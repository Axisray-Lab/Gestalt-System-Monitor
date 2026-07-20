/**
 * Native RBREPLAY world-packet -> AttributeMap projection.
 *
 * This is deliberately a plain ESM module: Monitor and repository-root Node
 * analyzers import this exact file. The game and Monitor ship in lockstep, so
 * the player-observable Attribute FlatBuffer subset is the single source of
 * truth; there is no second sampled Attribute track.
 *
 * The game's generated TypeScript bindings are private-build artifacts outside
 * the public Monitor repository and are gitignored. Importing them would also
 * require a TS runtime. We therefore reuse the official FlatBuffers ByteBuffer
 * runtime and expose a small, bounds-checked view of only the observable
 * CreateAttributeMap, AttributeChange, and RecycleAttributeMap tables.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { ByteBuffer } from 'flatbuffers';

const RBREPLAY_MAGIC = 'RBREPLAY';
const WORLD_SCHEMA = 'echo.packet-stream/3';
const WORLD_ATTRIBUTE_PROJECTION = 'echo.attribute-map-events/1';
const CURRENT_FORMAT_VERSION = 4;
const WORLD_ONLY_FORMAT_VERSION = 3;
const CURRENT_ATTRIBUTE_SOURCE = 'world.echo_attribute_events';
const CURRENT_TRACK_NAMES = ['ai_decision', 'match_event', 'meta', 'world'];
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024 * 1024;
const MAX_VECTOR_ITEMS = 1_000_000;

const PACKET_INITIAL = 'initial_snapshot';
const PACKET_CHECKPOINT = 'checkpoint_snapshot';
const WORLD_ATTRIBUTE_PACKET_KINDS = new Set([
  PACKET_INITIAL,
  PACKET_CHECKPOINT,
  'typescript_broadcast',
  'typescript_mono_cycle',
]);

// EchoEventBatch union tags from the player-observable world wire contract.
const EVENT_BATCH_ATTRIBUTE_CHANGE = 14;
const EVENT_BATCH_CREATE_ATTRIBUTE_MAP = 15;
const EVENT_BATCH_RECYCLE_ATTRIBUTE_MAP = 16;

// EEchoEvent ids paired with the union tags above. Checking both catches schema
// drift instead of accidentally decoding another union member as Attribute data.
const EVENT_ID_CREATE_ATTRIBUTE_MAP = 32_500_004;
const EVENT_ID_ATTRIBUTE_CHANGE = 32_500_007;
const EVENT_ID_RECYCLE_ATTRIBUTE_MAP = 32_500_010;

const GAME_TIME_ATTRIBUTE_ID = 80_000_002;

export const COMPACT_FULL = 0;
export const COMPACT_DELTA = 1;
export const COMPACT_RECYCLE = 2;

function readExact(fd, length, position, size) {
  if (!Number.isInteger(length) || length < 0 || position < 0 || position + length > size) {
    throw new Error(`truncated RBREPLAY read offset=${position} length=${length} size=${size}`);
  }
  const result = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, result, read, length - read, position + read);
    if (count <= 0) throw new Error(`truncated RBREPLAY read at ${position + read}`);
    read += count;
  }
  return result;
}

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('world packet must be a Uint8Array or ArrayBuffer');
}

function requireRange(bytes, offset, length, label) {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  ) {
    throw new Error(`${label}: out of bounds offset=${offset} length=${length} size=${bytes.length}`);
  }
}

function rootTable(bb, bytes) {
  requireRange(bytes, 0, 4, 'root offset');
  const relative = bb.readInt32(0);
  if (relative <= 0) throw new Error(`root offset: invalid relative offset ${relative}`);
  requireRange(bytes, relative, 4, 'root table');
  return relative;
}

function tableField(bb, bytes, table, vtableField, label) {
  requireRange(bytes, table, 4, `${label} table`);
  const vtableDistance = bb.readInt32(table);
  const vtable = table - vtableDistance;
  requireRange(bytes, vtable, 4, `${label} vtable`);
  const vtableLength = bb.readUint16(vtable);
  if (vtableLength < 4) throw new Error(`${label}: invalid vtable length ${vtableLength}`);
  if (vtableField >= vtableLength) return 0;
  requireRange(bytes, vtable + vtableField, 2, `${label} vtable field`);
  const relative = bb.readUint16(vtable + vtableField);
  if (relative === 0) return 0;
  const field = table + relative;
  requireRange(bytes, field, 1, `${label} field`);
  return field;
}

function indirect(bb, bytes, offset, label) {
  requireRange(bytes, offset, 4, `${label} offset`);
  const relative = bb.readInt32(offset);
  if (relative <= 0) throw new Error(`${label}: invalid relative offset ${relative}`);
  const table = offset + relative;
  requireRange(bytes, table, 4, `${label} table`);
  return table;
}

function tableVector(bb, bytes, table, vtableField, elementSize, label) {
  const field = tableField(bb, bytes, table, vtableField, label);
  if (field === 0) throw new Error(`${label}: missing required vector`);
  requireRange(bytes, field, 4, `${label} vector offset`);
  const relative = bb.readInt32(field);
  if (relative <= 0) throw new Error(`${label}: invalid vector relative offset ${relative}`);
  const vector = field + relative;
  requireRange(bytes, vector, 4, `${label} vector`);
  const length = bb.readInt32(vector);
  if (length < 0 || length > MAX_VECTOR_ITEMS) {
    throw new Error(`${label}: invalid vector length ${length}`);
  }
  const start = vector + 4;
  requireRange(bytes, start, length * elementSize, `${label} vector data`);
  return { start, length };
}

function readScalar(bb, bytes, table, vtableField, size, reader, fallback, label) {
  const field = tableField(bb, bytes, table, vtableField, label);
  if (field === 0) return fallback;
  requireRange(bytes, field, size, label);
  return reader.call(bb, field);
}

function parseAttributeData(bb, bytes, table, label) {
  const mapId = readScalar(bb, bytes, table, 4, 4, bb.readInt32, 0, `${label}.map_id`);
  const ids = tableVector(bb, bytes, table, 6, 4, `${label}.attribute_ids`);
  const values = tableVector(bb, bytes, table, 8, 8, `${label}.attribute_values`);
  if (ids.length !== values.length) {
    throw new Error(`${label}: attribute id/value length mismatch ${ids.length}/${values.length}`);
  }

  const flat = new Array(ids.length * 2);
  for (let index = 0; index < ids.length; index += 1) {
    const attributeId = bb.readInt32(ids.start + index * 4);
    const value = bb.readFloat64(values.start + index * 8);
    if (!Number.isFinite(value)) {
      throw new Error(`${label}: non-finite value for attribute ${attributeId}`);
    }
    flat[index * 2] = attributeId;
    flat[index * 2 + 1] = value;
  }
  return { mapId, attributes: flat };
}

function parseAttributeEvent(bb, bytes, eventTable, kind, label) {
  const datas = tableVector(bb, bytes, eventTable, 4, 4, `${label}.datas`);
  const events = [];
  for (let index = 0; index < datas.length; index += 1) {
    const dataTable = indirect(bb, bytes, datas.start + index * 4, `${label}.datas[${index}]`);
    events.push({ kind, ...parseAttributeData(bb, bytes, dataTable, `${label}.datas[${index}]`) });
  }
  return events;
}

function parseRecycleEvent(bb, bytes, eventTable, label) {
  const datas = tableVector(bb, bytes, eventTable, 4, 4, `${label}.datas`);
  const events = [];
  for (let index = 0; index < datas.length; index += 1) {
    events.push({
      kind: 'recycle',
      mapId: bb.readInt32(datas.start + index * 4),
      attributes: [],
    });
  }
  return events;
}

/** Decode only Attribute lifecycle events from one native world FlatBuffer. */
export function decodeWorldAttributePacket(packetKind, data) {
  if (!WORLD_ATTRIBUTE_PACKET_KINDS.has(packetKind)) {
    throw new Error(`Unsupported RBREPLAY world packet kind "${packetKind}"`);
  }
  const bytes = asBytes(data);
  const bb = new ByteBuffer(bytes);

  try {
    const root = rootTable(bb, bytes);
    const packs = tableVector(bb, bytes, root, 6, 4, 'EchoEventBufferPackArray.buffer_packs');
    const events = [];

    for (let index = 0; index < packs.length; index += 1) {
      const pack = indirect(bb, bytes, packs.start + index * 4, `buffer_packs[${index}]`);
      const eventId = readScalar(
        bb,
        bytes,
        pack,
        4,
        4,
        bb.readUint32,
        0,
        `buffer_packs[${index}].event_id`,
      );
      const eventType = readScalar(
        bb,
        bytes,
        pack,
        6,
        1,
        bb.readUint8,
        0,
        `buffer_packs[${index}].event_datas_type`,
      );

      let expectedEventId = 0;
      let eventKind = null;
      if (eventType === EVENT_BATCH_CREATE_ATTRIBUTE_MAP) {
        expectedEventId = EVENT_ID_CREATE_ATTRIBUTE_MAP;
        eventKind = 'create';
      } else if (eventType === EVENT_BATCH_ATTRIBUTE_CHANGE) {
        expectedEventId = EVENT_ID_ATTRIBUTE_CHANGE;
        eventKind = 'change';
      } else if (eventType === EVENT_BATCH_RECYCLE_ATTRIBUTE_MAP) {
        expectedEventId = EVENT_ID_RECYCLE_ATTRIBUTE_MAP;
        eventKind = 'recycle';
      } else {
        continue;
      }

      if (eventId !== expectedEventId) {
        throw new Error(
          `buffer_packs[${index}]: event id/type mismatch id=${eventId} type=${eventType}`,
        );
      }
      const eventField = tableField(
        bb,
        bytes,
        pack,
        8,
        `buffer_packs[${index}].event_datas`,
      );
      if (eventField === 0) throw new Error(`buffer_packs[${index}]: missing event data`);
      const eventTable = indirect(bb, bytes, eventField, `buffer_packs[${index}].event_datas`);
      if (eventKind === 'recycle') {
        events.push(...parseRecycleEvent(bb, bytes, eventTable, `buffer_packs[${index}]`));
      } else {
        events.push(
          ...parseAttributeEvent(bb, bytes, eventTable, eventKind, `buffer_packs[${index}]`),
        );
      }
    }
    return events;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${packetKind}: invalid Attribute world packet: ${message}`);
  }
}

function flatToRecord(flat) {
  const record = {};
  for (let index = 0; index < flat.length; index += 2) {
    record[String(flat[index])] = flat[index + 1];
  }
  return record;
}

function mergeFlat(target, flat) {
  for (let index = 0; index < flat.length; index += 2) {
    target.set(flat[index], flat[index + 1]);
  }
}

function mapToFlat(attributes) {
  const flat = [];
  const entries = [...attributes.entries()].sort((left, right) => left[0] - right[0]);
  for (const [attributeId, value] of entries) flat.push(attributeId, value);
  return flat;
}

function findGameTime(state) {
  for (const attributes of state.values()) {
    const value = attributes.get(GAME_TIME_ATTRIBUTE_ID);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function applyIncrementalEvents(events, state) {
  const updates = [];
  for (const event of events) {
    if (event.kind === 'recycle') {
      state.delete(event.mapId);
      updates.push([event.mapId, [], COMPACT_RECYCLE]);
      continue;
    }
    if (event.kind === 'create') {
      const attributes = new Map();
      mergeFlat(attributes, event.attributes);
      state.set(event.mapId, attributes);
      updates.push([event.mapId, event.attributes, COMPACT_FULL]);
      continue;
    }
    let attributes = state.get(event.mapId);
    if (!attributes) {
      attributes = new Map();
      state.set(event.mapId, attributes);
    }
    mergeFlat(attributes, event.attributes);
    updates.push([event.mapId, event.attributes, COMPACT_DELTA]);
  }
  return updates;
}

function applySnapshotEvents(events, state) {
  const previousIds = new Set(state.keys());
  const replacement = new Map();
  for (const event of events) {
    if (event.kind === 'recycle') {
      replacement.delete(event.mapId);
      continue;
    }
    if (event.kind === 'create') replacement.set(event.mapId, new Map());
    let attributes = replacement.get(event.mapId);
    if (!attributes) {
      attributes = new Map();
      replacement.set(event.mapId, attributes);
    }
    mergeFlat(attributes, event.attributes);
  }

  const updates = [];
  for (const mapId of [...previousIds].sort((left, right) => left - right)) {
    if (!replacement.has(mapId)) updates.push([mapId, [], COMPACT_RECYCLE]);
  }
  for (const [mapId, attributes] of [...replacement.entries()].sort(
    (left, right) => left[0] - right[0],
  )) {
    updates.push([mapId, mapToFlat(attributes), COMPACT_FULL]);
  }

  state.clear();
  for (const [mapId, attributes] of replacement) state.set(mapId, attributes);
  return updates;
}

function estimatedRelativeMs(frameId, startFrameId, logicTickRate) {
  if (logicTickRate <= 0 || frameId < startFrameId) return 0;
  return Math.max(0, Math.round(((frameId - startFrameId) * 1000) / logicTickRate));
}

/**
 * Scan an RBREPLAY and derive Monitor compact frames from its native world
 * packets. `loadFrames=false` validates the container contract and counts
 * candidate world frames without decoding payloads; exact frames are loaded
 * only when a replay client connects.
 */
export function readRbReplayWorldAttributes(replayPath, loadFrames = true) {
  const fd = openSync(replayPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const prefix = readExact(fd, 16, 0, size);
    if (prefix.toString('ascii', 0, 8) !== RBREPLAY_MAGIC) {
      throw new Error(`Invalid RBREPLAY magic in ${replayPath}`);
    }
    const version = prefix.readUInt32LE(8);
    const headerLength = prefix.readUInt32LE(12);
    if (version !== WORLD_ONLY_FORMAT_VERSION && version !== CURRENT_FORMAT_VERSION) {
      throw new Error(`Unsupported RBREPLAY format version ${version}`);
    }
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
      throw new Error(`Invalid RBREPLAY header length ${headerLength}`);
    }
    const header = JSON.parse(readExact(fd, headerLength, 16, size).toString('utf8'));
    if (header.magic !== RBREPLAY_MAGIC) throw new Error('Invalid RBREPLAY JSON header magic');
    if (Number(header.format_version) !== version) {
      throw new Error(
        `RBREPLAY binary/header version mismatch ${version}/${String(header.format_version)}`,
      );
    }
    if (version === CURRENT_FORMAT_VERSION) {
      const trackNames = Object.keys(header.tracks ?? {}).sort();
      if (trackNames.join('|') !== CURRENT_TRACK_NAMES.join('|')) {
        throw new Error(
          `Invalid current RBREPLAY tracks: expected ${CURRENT_TRACK_NAMES.join(',')}; ` +
            `got ${trackNames.join(',') || '(none)'}`,
        );
      }
      if (header.attribute_source !== CURRENT_ATTRIBUTE_SOURCE) {
        throw new Error(
          `Invalid current RBREPLAY attribute_source ${String(header.attribute_source)}`,
        );
      }
      if (
        header.tracks.world?.schema !== WORLD_SCHEMA ||
        header.tracks.world?.codec !== 'flatbuffers' ||
        header.tracks.world?.attribute_projection !== WORLD_ATTRIBUTE_PROJECTION
      ) {
        throw new Error('Invalid current RBREPLAY world Attribute projection contract');
      }
    } else if (header.tracks?.world && header.tracks.world.schema !== WORLD_SCHEMA) {
      throw new Error(`Unsupported RBREPLAY world schema ${String(header.tracks.world.schema)}`);
    }
    if (header.requires_initial_snapshot !== true) {
      throw new Error('RBREPLAY world stream does not require an initial snapshot');
    }

    const mapId = Number(header.map_id) > 0 ? Number(header.map_id) : 4;
    const startFrameId = Number.isInteger(header.start_frame_id)
      ? Number(header.start_frame_id)
      : 0;
    const logicTickRate = Number(header.logic_tick_rate) > 0
      ? Number(header.logic_tick_rate)
      : 60;

    let offset = 16 + headerLength;
    let lastElapsedMs = 0;
    let currentMarkerFrameId = null;
    let currentMarkerElapsedMs = 0;
    let initialSnapshotCount = 0;
    let attributeEventCount = 0;
    const metadataFrameIds = new Set();
    const state = new Map();
    const framesById = new Map();
    const frameOrder = [];

    const getFrame = (frameId) => {
      let frame = framesById.get(frameId);
      if (!frame) {
        frame = {
          frameId,
          relMs: frameId === currentMarkerFrameId
            ? currentMarkerElapsedMs
            : estimatedRelativeMs(frameId, startFrameId, logicTickRate),
          gtMs: null,
          updates: [],
        };
        framesById.set(frameId, frame);
        frameOrder.push(frame);
      }
      return frame;
    };

    while (offset < size) {
      const type = readExact(fd, 1, offset, size)[0];
      offset += 1;
      if (type === 0) {
        const marker = readExact(fd, 17, offset, size);
        offset += 17;
        const frameId = marker.readUInt32LE(0);
        const elapsedSeconds = marker.readDoubleLE(8);
        if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
          throw new Error(`Invalid RBREPLAY frame marker time ${elapsedSeconds}`);
        }
        lastElapsedMs = Math.round(elapsedSeconds * 1000);
        currentMarkerFrameId = frameId;
        currentMarkerElapsedMs = lastElapsedMs;
        const existing = framesById.get(frameId);
        if (existing) existing.relMs = lastElapsedMs;
        continue;
      }
      if (type === 1) {
        const fixed = readExact(fd, 5, offset, size);
        offset += 5;
        const frameId = fixed.readUInt32LE(0);
        const kindLength = fixed[4];
        const kind = readExact(fd, kindLength, offset, size).toString('utf8');
        offset += kindLength;
        const dataLength = readExact(fd, 4, offset, size).readUInt32LE(0);
        offset += 4;
        if (dataLength <= 0 || dataLength > MAX_RECORD_BYTES || offset + dataLength > size) {
          throw new Error(`Invalid ${kind} packet length ${dataLength}`);
        }

        if (WORLD_ATTRIBUTE_PACKET_KINDS.has(kind)) {
          if (kind === PACKET_INITIAL) initialSnapshotCount += 1;
          metadataFrameIds.add(frameId);
          if (!loadFrames) {
            offset += dataLength;
            continue;
          }
          const events = decodeWorldAttributePacket(
            kind,
            readExact(fd, dataLength, offset, size),
          );
          if (events.length > 0 || kind === PACKET_INITIAL || kind === PACKET_CHECKPOINT) {
            const updates = kind === PACKET_INITIAL || kind === PACKET_CHECKPOINT
              ? applySnapshotEvents(events, state)
              : applyIncrementalEvents(events, state);
            attributeEventCount += events.length;
            if (updates.length > 0) {
              const frame = getFrame(frameId);
              frame.updates.push(...updates);
              frame.gtMs = findGameTime(state);
            }
          }
        }
        offset += dataLength;
        continue;
      }
      if (type === 2) {
        const footerLength = readExact(fd, 4, offset, size).readUInt32LE(0);
        offset += 4;
        if (footerLength > MAX_HEADER_BYTES || offset + footerLength > size) {
          throw new Error(`Invalid RBREPLAY footer length ${footerLength}`);
        }
        offset += footerLength;
        break;
      }
      throw new Error(`Unknown RBREPLAY record type ${type} at ${offset - 1}`);
    }

    if (initialSnapshotCount === 0) {
      throw new Error('RBREPLAY world stream is missing initial_snapshot');
    }
    if (loadFrames && attributeEventCount === 0) {
      throw new Error('RBREPLAY world stream contains no AttributeMap events');
    }

    if (!loadFrames) {
      return {
        info: {
          version,
          mapId,
          // Fast discovery metadata intentionally counts candidate world frames;
          // exact Attribute-bearing frames and game time are decoded on resume.
          frameCount: metadataFrameIds.size,
          durMs: lastElapsedMs,
          gtMs: 0,
        },
        frames: [],
      };
    }

    const nativeFrames = frameOrder.map((frame) => [frame.relMs, frame.gtMs, frame.updates]);
    nativeFrames.sort((left, right) => left[0] - right[0]);
    const latestGameTime = findGameTime(state);
    return {
      info: {
        version,
        mapId,
        frameCount: nativeFrames.length,
        durMs: lastElapsedMs,
        gtMs: Number.isFinite(latestGameTime) ? Number(latestGameTime) : 0,
      },
      frames: nativeFrames,
    };
  } finally {
    closeSync(fd);
  }
}

/** Project compact updates into the existing watchAttributeMaps.result shape. */
export function projectCompactAttributeUpdates(updates, state = new Map()) {
  const projected = [];
  for (const update of updates) {
    const [mapId, flat, marker] = update;
    if (!Number.isInteger(mapId) || !Array.isArray(flat) || flat.length % 2 !== 0) {
      throw new Error(`Malformed compact Attribute update for map ${String(mapId)}`);
    }
    if (marker === COMPACT_RECYCLE) {
      if (flat.length !== 0) {
        throw new Error(`Recycle compact Attribute update for map ${mapId} must be empty`);
      }
      state.delete(mapId);
      projected.push({ sync_type: 2, attribute_map_id: mapId, attributes: {} });
      continue;
    }
    if (marker !== COMPACT_FULL && marker !== COMPACT_DELTA) {
      throw new Error(`Unknown compact Attribute marker ${marker} for map ${mapId}`);
    }
    const isFull = marker === COMPACT_FULL;
    const current = isFull ? {} : (state.get(mapId) ?? {});
    const attributes = flatToRecord(flat);
    Object.assign(current, attributes);
    state.set(mapId, current);
    projected.push({
      sync_type: isFull ? 0 : 1,
      attribute_map_id: mapId,
      attributes,
    });
  }
  return { watch_attribute_maps_results: projected };
}

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Builder } from 'flatbuffers';
import {
  COMPACT_DELTA,
  COMPACT_FULL,
  COMPACT_RECYCLE,
  decodeWorldAttributePacket,
  projectCompactAttributeUpdates,
  readRbReplayWorldAttributes,
} from './rbreplay-world-attributes.mjs';

const EVENT = {
  change: { id: 32_500_007, type: 14 },
  create: { id: 32_500_004, type: 15 },
  recycle: { id: 32_500_010, type: 16 },
};

const GAME_TIME = 80_000_002;
const MAP_ID = 80_000_003;
const HEALTH = 10_000_003;
const HEALTH_MAX = 60_000_004;
const WORLD_X = 10_000_107;

function offsetVector(builder, offsets) {
  builder.startVector(4, offsets.length, 4);
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    builder.addOffset(offsets[index]);
  }
  return builder.endVector();
}

function intVector(builder, values) {
  builder.startVector(4, values.length, 4);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    builder.addInt32(values[index]);
  }
  return builder.endVector();
}

function doubleVector(builder, values) {
  builder.startVector(8, values.length, 8);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    builder.addFloat64(values[index]);
  }
  return builder.endVector();
}

function attributeData(builder, mapId, entries) {
  const ids = intVector(builder, entries.map(([id]) => id));
  const values = doubleVector(builder, entries.map(([, value]) => value));
  builder.startObject(3);
  builder.addFieldInt32(0, mapId, 0);
  builder.addFieldOffset(1, ids, 0);
  builder.addFieldOffset(2, values, 0);
  return builder.endObject();
}

function attributeEvent(builder, changes) {
  const datas = changes.map(({ mapId, entries }) => attributeData(builder, mapId, entries));
  const vector = offsetVector(builder, datas);
  builder.startObject(1);
  builder.addFieldOffset(0, vector, 0);
  return builder.endObject();
}

function recycleEvent(builder, mapIds) {
  const vector = intVector(builder, mapIds);
  builder.startObject(1);
  builder.addFieldOffset(0, vector, 0);
  return builder.endObject();
}

function worldPacket(frameId, specs) {
  const builder = new Builder(1024);
  const packs = [];
  for (const spec of specs) {
    const wire = EVENT[spec.kind];
    const payload = spec.kind === 'recycle'
      ? recycleEvent(builder, spec.mapIds)
      : attributeEvent(builder, spec.changes);
    builder.startObject(3);
    builder.addFieldInt32(0, wire.id, 0);
    builder.addFieldInt8(1, wire.type, 0);
    builder.addFieldOffset(2, payload, 0);
    packs.push(builder.endObject());
  }

  const packsVector = offsetVector(builder, packs);
  builder.prep(4, 4);
  builder.writeInt32(frameId);
  const header = builder.offset();
  builder.startObject(10);
  builder.addFieldStruct(0, header, 0);
  builder.addFieldOffset(1, packsVector, 0);
  const root = builder.endObject();
  builder.finish(root);
  return Buffer.from(builder.asUint8Array());
}

function u32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function frameMarker(frameId, relativeFrame, elapsedSeconds, lateOrGap = 0) {
  const result = Buffer.alloc(18);
  result[0] = 0;
  result.writeUInt32LE(frameId, 1);
  result.writeUInt32LE(relativeFrame, 5);
  result.writeDoubleLE(elapsedSeconds, 9);
  result[17] = lateOrGap;
  return result;
}

function packetRecord(frameId, kind, payload) {
  const kindBytes = Buffer.from(kind, 'utf8');
  assert.ok(kindBytes.length <= 255);
  return Buffer.concat([
    Buffer.from([1]),
    u32(frameId),
    Buffer.from([kindBytes.length]),
    kindBytes,
    u32(payload.length),
    payload,
  ]);
}

function footerRecord() {
  const payload = Buffer.from(JSON.stringify({ type: 'footer', reason: 'test' }));
  return Buffer.concat([Buffer.from([2]), u32(payload.length), payload]);
}

function currentHeader() {
  return {
    type: 'header',
    magic: 'RBREPLAY',
    format_version: 4,
    map_id: 4,
    logic_tick_rate: 10,
    start_frame_id: 10,
    requires_initial_snapshot: true,
    attribute_source: 'world.echo_attribute_events',
    tracks: {
      world: {
        schema: 'echo.packet-stream/3',
        codec: 'flatbuffers',
        attribute_projection: 'echo.attribute-map-events/1',
      },
      ai_decision: { schema: 'rb.ai_decision/1', codec: 'json+zlib' },
      match_event: { schema: 'rb.match_event/1', codec: 'json+zlib' },
      meta: { schema: 'rb.meta/1', codec: 'json+zlib' },
    },
  };
}

function nativeRecords() {
  const initial = worldPacket(11, [
    {
      kind: 'create',
      changes: [
        { mapId: 1, entries: [[GAME_TIME, 0], [MAP_ID, 4]] },
        { mapId: 100, entries: [[HEALTH, 100], [HEALTH_MAX, 100]] },
      ],
    },
  ]);
  const broadcast = worldPacket(12, [
    {
      kind: 'change',
      changes: [
        { mapId: 1, entries: [[GAME_TIME, 100]] },
        { mapId: 100, entries: [[HEALTH, 80]] },
      ],
    },
    { kind: 'create', changes: [{ mapId: 200, entries: [[WORLD_X, 1]] }] },
  ]);
  const mono = worldPacket(13, [
    { kind: 'change', changes: [{ mapId: 200, entries: [[WORLD_X, 2]] }] },
    { kind: 'create', changes: [{ mapId: 400, entries: [[HEALTH, 9]] }] },
  ]);
  const recycle = worldPacket(14, [{ kind: 'recycle', mapIds: [100] }]);
  const checkpoint = worldPacket(15, [
    {
      kind: 'create',
      changes: [
        { mapId: 1, entries: [[GAME_TIME, 400], [MAP_ID, 4]] },
        { mapId: 200, entries: [[WORLD_X, 7]] },
        { mapId: 300, entries: [[HEALTH, 30]] },
      ],
    },
  ]);
  const finalDelta = worldPacket(16, [
    {
      kind: 'change',
      changes: [
        { mapId: 1, entries: [[GAME_TIME, 500]] },
        { mapId: 200, entries: [[WORLD_X, 8]] },
      ],
    },
  ]);

  // Match the game writer: a packet can precede the marker carrying that same
  // frame id. The reader must backfill the canonical marker time by frame_id.
  return [
    frameMarker(10, 0, 0),
    packetRecord(11, 'initial_snapshot', initial),
    frameMarker(11, 1, 0.1),
    packetRecord(12, 'typescript_broadcast', broadcast),
    frameMarker(12, 2, 0.2),
    packetRecord(13, 'typescript_mono_cycle', mono),
    frameMarker(13, 3, 0.3),
    packetRecord(14, 'typescript_broadcast', recycle),
    frameMarker(14, 4, 0.4),
    packetRecord(15, 'checkpoint_snapshot', checkpoint),
    frameMarker(15, 5, 0.5),
    packetRecord(16, 'typescript_broadcast', finalDelta),
    frameMarker(16, 6, 0.6),
    frameMarker(17, 7, 0.7),
    footerRecord(),
  ];
}

function replayBytes(header, records = nativeRecords()) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  return Buffer.concat([
    Buffer.from('RBREPLAY', 'ascii'),
    u32(header.format_version),
    u32(headerBytes.length),
    headerBytes,
    ...records,
  ]);
}

function withTempReplay(header, run) {
  const dir = mkdtempSync(join(tmpdir(), 'gsm-native-rbreplay-'));
  const path = join(dir, 'fixture.rbreplay');
  try {
    writeFileSync(path, replayBytes(header));
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('decodes native initial, delta, recycle and checkpoint packets on container time', () => {
  withTempReplay(currentHeader(), (path) => {
    const replay = readRbReplayWorldAttributes(path, true);
    assert.deepEqual(replay.info, {
      version: 4,
      mapId: 4,
      frameCount: 6,
      durMs: 700,
      gtMs: 500,
    });
    assert.deepEqual(replay.frames.map(([relMs, gtMs]) => [relMs, gtMs]), [
      [100, 0],
      [200, 100],
      [300, 100],
      [400, 100],
      [500, 400],
      [600, 500],
    ]);

    assert.deepEqual(replay.frames[0][2], [
      [1, [GAME_TIME, 0, MAP_ID, 4], COMPACT_FULL],
      [100, [HEALTH, 100, HEALTH_MAX, 100], COMPACT_FULL],
    ]);
    assert.deepEqual(replay.frames[3][2], [[100, [], COMPACT_RECYCLE]]);

    const checkpoint = replay.frames[4][2];
    assert.deepEqual(checkpoint[0], [400, [], COMPACT_RECYCLE]);
    assert.deepEqual(checkpoint.slice(1).map(([mapId, , marker]) => [mapId, marker]), [
      [1, COMPACT_FULL],
      [200, COMPACT_FULL],
      [300, COMPACT_FULL],
    ]);

    const state = new Map();
    const projected = replay.frames.map(([, , updates]) =>
      projectCompactAttributeUpdates(updates, state));
    assert.equal(state.has(100), false);
    assert.equal(state.has(400), false);
    assert.equal(state.get(200)?.[String(WORLD_X)], 8);
    assert.equal(state.get(300)?.[String(HEALTH)], 30);
    assert.deepEqual(projected[3].watch_attribute_maps_results, [
      { sync_type: 2, attribute_map_id: 100, attributes: {} },
    ]);
    assert.deepEqual(projected[4].watch_attribute_maps_results[0], {
      sync_type: 2,
      attribute_map_id: 400,
      attributes: {},
    });
  });
});

test('metadata-only scan stays lazy and does not retain or decode frames', () => {
  withTempReplay(currentHeader(), (path) => {
    const replay = readRbReplayWorldAttributes(path, false);
    assert.equal(replay.info.frameCount, 6);
    assert.equal(replay.info.gtMs, 0);
    assert.deepEqual(replay.frames, []);
  });
});

test('marker-first late/gap elapsed overrides tick estimate with non-zero start frame', () => {
  const header = currentHeader();
  header.start_frame_id = 9_000;
  header.logic_tick_rate = 60;
  const initial = worldPacket(9_001, [
    {
      kind: 'create',
      changes: [{ mapId: 1, entries: [[GAME_TIME, 2_750], [MAP_ID, 4]] }],
    },
  ]);
  const records = [
    frameMarker(9_001, 1, 2.75, 1),
    packetRecord(9_001, 'initial_snapshot', initial),
    footerRecord(),
  ];
  const dir = mkdtempSync(join(tmpdir(), 'gsm-native-rbreplay-marker-'));
  const path = join(dir, 'fixture.rbreplay');
  try {
    writeFileSync(path, replayBytes(header, records));
    const replay = readRbReplayWorldAttributes(path);
    assert.equal(replay.frames[0][0], 2_750);
    assert.equal(replay.info.durMs, 2_750);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('current format rejects the discarded Attribute side track', () => {
  const header = currentHeader();
  header.tracks.attributes = { schema: 'rb.attributes/1', codec: 'json+zlib' };
  withTempReplay(header, (path) => {
    assert.throws(
      () => readRbReplayWorldAttributes(path),
      /Invalid current RBREPLAY tracks/,
    );
  });
});

test('world-only format reads the same native Attribute events without side tracks', () => {
  const header = currentHeader();
  header.format_version = 3;
  delete header.attribute_source;
  delete header.tracks;
  withTempReplay(header, (path) => {
    const replay = readRbReplayWorldAttributes(path);
    assert.equal(replay.info.version, 3);
    assert.equal(replay.info.frameCount, 6);
    assert.equal(replay.info.gtMs, 500);
  });
});

test('packet decoder accepts every native world source and rejects id/type drift', () => {
  const packet = worldPacket(1, [
    { kind: 'change', changes: [{ mapId: 9, entries: [[HEALTH, 42]] }] },
  ]);
  for (const kind of [
    'initial_snapshot',
    'checkpoint_snapshot',
    'typescript_broadcast',
    'typescript_mono_cycle',
  ]) {
    assert.deepEqual(decodeWorldAttributePacket(kind, packet), [
      { kind: 'change', mapId: 9, attributes: [HEALTH, 42] },
    ]);
  }

  const mismatchBuilder = new Builder(256);
  const payload = attributeEvent(mismatchBuilder, [{ mapId: 9, entries: [[HEALTH, 1]] }]);
  mismatchBuilder.startObject(3);
  mismatchBuilder.addFieldInt32(0, EVENT.create.id, 0);
  mismatchBuilder.addFieldInt8(1, EVENT.change.type, 0);
  mismatchBuilder.addFieldOffset(2, payload, 0);
  const pack = mismatchBuilder.endObject();
  const vector = offsetVector(mismatchBuilder, [pack]);
  mismatchBuilder.prep(4, 4);
  mismatchBuilder.writeInt32(1);
  const rootHeader = mismatchBuilder.offset();
  mismatchBuilder.startObject(10);
  mismatchBuilder.addFieldStruct(0, rootHeader, 0);
  mismatchBuilder.addFieldOffset(1, vector, 0);
  const root = mismatchBuilder.endObject();
  mismatchBuilder.finish(root);
  assert.throws(
    () => decodeWorldAttributePacket('typescript_broadcast', mismatchBuilder.asUint8Array()),
    /event id\/type mismatch/,
  );
});

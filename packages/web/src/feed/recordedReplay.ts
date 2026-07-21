import type {
  AttributeMapUpdate,
  MapWireframe,
  WatchAttributeMapsResult,
} from '@gsm/protocol';
import { publicAssetUrl } from '@/publicAssetUrl';

export const RECORDED_REPLAY_SCHEMA = 'gsm-watch-replay/2';
export const RECORDED_REPLAY_TICK_MS = 100;

export interface RecordedReplayFrame {
  t: number;
  result: WatchAttributeMapsResult;
}

export interface RecordedReplay {
  schema: typeof RECORDED_REPLAY_SCHEMA;
  frameCount: number;
  durationMs: number;
  map: MapWireframe;
  frames: RecordedReplayFrame[];
  source?: unknown;
  interpolation?: unknown;
  inference?: unknown;
}

function fail(message: string): never {
  throw new Error(`Invalid recorded replay: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be a finite number`);
  }
  return value;
}

function finiteVec3(value: unknown, context: string): void {
  if (!isRecord(value)) fail(`${context} must be an object`);
  finiteNumber(value.x, `${context}.x`);
  finiteNumber(value.y, `${context}.y`);
  finiteNumber(value.z, `${context}.z`);
}

function validateMap(value: unknown): asserts value is MapWireframe {
  if (!isRecord(value)) fail('map must be an object');
  if (!Array.isArray(value.lines)) fail('map.lines must be an array');
  for (let lineIndex = 0; lineIndex < value.lines.length; lineIndex += 1) {
    const line = value.lines[lineIndex];
    if (!Array.isArray(line)) fail(`map.lines[${lineIndex}] must be an array`);
    for (let pointIndex = 0; pointIndex < line.length; pointIndex += 1) {
      finiteVec3(line[pointIndex], `map.lines[${lineIndex}][${pointIndex}]`);
    }
  }
  if (
    value.mapId != null &&
    typeof value.mapId !== 'string' &&
    typeof value.mapId !== 'number'
  ) {
    fail('map.mapId must be a string or number');
  }
  if (value.bounds != null) {
    if (!isRecord(value.bounds)) fail('map.bounds must be an object');
    finiteVec3(value.bounds.min, 'map.bounds.min');
    finiteVec3(value.bounds.max, 'map.bounds.max');
  }
}

function validateFrame(
  value: unknown,
  index: number
): asserts value is RecordedReplayFrame {
  if (!isRecord(value)) fail(`frames[${index}] must be an object`);
  const t = finiteNumber(value.t, `frames[${index}].t`);
  if (!Number.isSafeInteger(t) || t < 0) {
    fail(`frames[${index}].t must be a non-negative safe integer`);
  }
  if (!isRecord(value.result))
    fail(`frames[${index}].result must be an object`);
  const updates = value.result.watch_attribute_maps_results;
  if (!Array.isArray(updates)) {
    fail(
      `frames[${index}].result.watch_attribute_maps_results must be an array`
    );
  }
  for (let updateIndex = 0; updateIndex < updates.length; updateIndex += 1) {
    const update = updates[updateIndex];
    const context = `frames[${index}].updates[${updateIndex}]`;
    if (!isRecord(update)) fail(`${context} must be an object`);
    if (
      update.sync_type !== 0 &&
      update.sync_type !== 1 &&
      update.sync_type !== 2
    ) {
      fail(`${context}.sync_type must be 0, 1, or 2`);
    }
    if (
      typeof update.attribute_map_id !== 'number' ||
      !Number.isSafeInteger(update.attribute_map_id) ||
      update.attribute_map_id <= 0
    ) {
      fail(`${context}.attribute_map_id must be a positive safe integer`);
    }
    if (!isRecord(update.attributes))
      fail(`${context}.attributes must be an object`);
    if (update.sync_type === 2 && Object.keys(update.attributes).length !== 0) {
      fail(`${context} recycle update must not carry attributes`);
    }
    for (const [attributeId, attributeValue] of Object.entries(
      update.attributes
    )) {
      if (!/^(0|[1-9]\d*)$/.test(attributeId)) {
        fail(`${context}.attributes has invalid id ${attributeId}`);
      }
      finiteNumber(attributeValue, `${context}.attributes[${attributeId}]`);
    }
  }
}

export function parseRecordedReplay(value: unknown): RecordedReplay {
  if (!isRecord(value)) fail('root must be an object');
  if (value.schema !== RECORDED_REPLAY_SCHEMA) {
    fail(`schema must be ${RECORDED_REPLAY_SCHEMA}`);
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    fail('frames must be a non-empty array');
  }
  for (let index = 0; index < value.frames.length; index += 1) {
    validateFrame(value.frames[index], index);
  }
  if (value.frames[0].t !== 0) fail('first frame must start at t=0');
  if (
    !value.frames[0].result.watch_attribute_maps_results.some(
      (update: AttributeMapUpdate) => update.sync_type === 0
    )
  ) {
    fail('first frame must contain at least one full update');
  }
  for (let index = 1; index < value.frames.length; index += 1) {
    if (value.frames[index].t < value.frames[index - 1].t) {
      fail(`frames are not monotonic at index ${index}`);
    }
  }
  if (
    typeof value.frameCount !== 'number' ||
    !Number.isSafeInteger(value.frameCount) ||
    value.frameCount !== value.frames.length
  ) {
    fail(`frameCount must equal frames.length (${value.frames.length})`);
  }
  const durationMs = finiteNumber(value.durationMs, 'durationMs');
  const lastT = value.frames[value.frames.length - 1].t;
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < lastT + RECORDED_REPLAY_TICK_MS
  ) {
    fail(
      `durationMs must be at least last frame + ${RECORDED_REPLAY_TICK_MS} ms`
    );
  }
  validateMap(value.map);
  return value as unknown as RecordedReplay;
}

export function replayAssetUrl(
  relativePath: string,
  baseUrl: string,
  documentBaseUrl: string
): string {
  return publicAssetUrl(relativePath, baseUrl, documentBaseUrl);
}

import { publicAssetUrl } from '@/publicAssetUrl';
import {
  OVERVIEW_TRACK_SCHEMA,
  type OverviewTrackDescriptor,
  type StaticReplayRoundDescriptor,
} from './staticReplayCatalog';

const MAGIC = new TextEncoder().encode('GSMOVW01');
const VERSION = 1;
const HEADER_BYTES = 64;
const ROUND_HEADER_BYTES = 28;
const RECORD_BYTES = 7;
const SAMPLE_HZ = 1;
const POSITION_QUANTIZATION_CM = 1;
const TRACK_VIEWS = new WeakMap<OverviewTrack, DataView>();

export interface OverviewTrackRound {
  descriptor: StaticReplayRoundDescriptor;
  robotIds: readonly number[];
  sampleCount: number;
  /** Byte offset of the first time-major, robot-major sample record. */
  recordsOffset: number;
}

export interface OverviewTrack {
  schema: typeof OVERVIEW_TRACK_SCHEMA;
  regionKey: string;
  sampleHz: 1;
  positionQuantizationCm: 1;
  timelineSampleCount: number;
  entitySampleCount: number;
  rounds: readonly OverviewTrackRound[];
  /** Validated immutable backing payload. Use readOverviewSample for access. */
  bytes: Uint8Array;
}

export interface OverviewEntitySample {
  /** UE centimetres. Convert at the renderer boundary with the existing ueToThree mapping. */
  x: number;
  y: number;
  z: number;
  defeated: boolean;
}

function fail(message: string): never {
  throw new Error(`[overview track] ${message}`);
}

function shaBytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeGameId(value: bigint, context: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${context} exceeds Number.MAX_SAFE_INTEGER`);
  return Number(value);
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function parseOverviewTrack(
  input: ArrayBuffer | Uint8Array,
  descriptor: OverviewTrackDescriptor,
  expectedRounds: readonly StaticReplayRoundDescriptor[],
  databaseSha256: string
): OverviewTrack {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength !== descriptor.uncompressedBytes) {
    fail(
      `${descriptor.regionKey} uncompressed bytes ${bytes.byteLength} != ${descriptor.uncompressedBytes}`
    );
  }
  if (bytes.byteLength <= HEADER_BYTES) fail(`${descriptor.regionKey} payload is truncated`);
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) fail(`${descriptor.regionKey} magic drifted`);
  }
  const view = dataView(bytes);
  const regionIndexByKey: Readonly<Record<string, number>> = { east: 0, south: 1, north: 2 };
  const regionIndex = regionIndexByKey[descriptor.regionKey];
  if (regionIndex === undefined) fail(`unsupported region ${descriptor.regionKey}`);
  const roundCount = view.getUint16(14, true);
  const timelineSampleCount = view.getUint32(16, true);
  const entitySampleCount = view.getUint32(20, true);
  if (
    view.getUint16(8, true) !== VERSION ||
    view.getUint8(10) !== regionIndex ||
    view.getUint8(11) !== SAMPLE_HZ ||
    view.getUint8(12) !== RECORD_BYTES ||
    view.getUint8(13) !== POSITION_QUANTIZATION_CM ||
    roundCount !== descriptor.roundCount ||
    roundCount !== expectedRounds.length ||
    timelineSampleCount !== descriptor.timelineSampleCount ||
    entitySampleCount !== descriptor.entitySampleCount ||
    view.getUint32(24, true) !== bytes.byteLength - HEADER_BYTES ||
    shaBytesToHex(bytes.subarray(28, 60)) !== databaseSha256 ||
    view.getUint32(60, true) !== 0
  ) {
    fail(`${descriptor.regionKey} header drifted`);
  }

  const rounds: OverviewTrackRound[] = [];
  let offset = HEADER_BYTES;
  let actualTimelineSamples = 0;
  let actualEntitySamples = 0;
  for (let index = 0; index < expectedRounds.length; index += 1) {
    const expected = expectedRounds[index];
    if (expected.regionKey !== descriptor.regionKey) {
      fail(`${expected.key} does not belong to ${descriptor.regionKey}`);
    }
    if (offset + ROUND_HEADER_BYTES > bytes.byteLength) {
      fail(`${expected.key} round header is truncated`);
    }
    const matchNumber = view.getUint16(offset, true);
    const roundNumber = view.getUint8(offset + 2);
    const robotCount = view.getUint8(offset + 3);
    const gameId = safeGameId(view.getBigUint64(offset + 4, true), `${expected.key} gameId`);
    const webGameId = view.getUint32(offset + 12, true);
    const durationSeconds = view.getUint16(offset + 16, true);
    const sampleCount = view.getUint16(offset + 18, true);
    const recordCount = view.getUint32(offset + 20, true);
    const payloadBytes = view.getUint32(offset + 24, true);
    offset += ROUND_HEADER_BYTES;
    if (
      matchNumber !== expected.matchNumber ||
      roundNumber !== expected.roundNumber ||
      gameId !== expected.gameId ||
      webGameId !== expected.webGameId ||
      durationSeconds * 1_000 !== expected.durationMs ||
      sampleCount !== durationSeconds ||
      robotCount === 0 ||
      recordCount !== robotCount * sampleCount ||
      payloadBytes !== robotCount * 2 + recordCount * RECORD_BYTES ||
      offset + payloadBytes > bytes.byteLength
    ) {
      fail(`${expected.key} header or identity drifted`);
    }
    const robotIds: number[] = [];
    let previousRobotId = 0;
    for (let robotIndex = 0; robotIndex < robotCount; robotIndex += 1) {
      const robotId = view.getUint16(offset, true);
      offset += 2;
      if (robotId <= previousRobotId) fail(`${expected.key} robot ids are not strictly ordered`);
      if (![1, 2, 3, 4, 6, 7, 101, 102, 103, 104, 106, 107].includes(robotId)) {
        fail(`${expected.key} has unsupported robot id ${robotId}`);
      }
      robotIds.push(robotId);
      previousRobotId = robotId;
    }
    const recordsOffset = offset;
    for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
      const flags = view.getUint8(offset + 6);
      if ((flags & ~1) !== 0) fail(`${expected.key} record ${recordIndex} has invalid flags`);
      offset += RECORD_BYTES;
    }
    rounds.push({ descriptor: expected, robotIds, sampleCount, recordsOffset });
    actualTimelineSamples += sampleCount;
    actualEntitySamples += recordCount;
  }
  if (
    offset !== bytes.byteLength ||
    actualTimelineSamples !== timelineSampleCount ||
    actualEntitySamples !== entitySampleCount
  ) {
    fail(`${descriptor.regionKey} payload totals drifted`);
  }
  const track: OverviewTrack = {
    schema: OVERVIEW_TRACK_SCHEMA,
    regionKey: descriptor.regionKey,
    sampleHz: 1,
    positionQuantizationCm: 1,
    timelineSampleCount,
    entitySampleCount,
    rounds,
    bytes,
  };
  TRACK_VIEWS.set(track, view);
  return track;
}

export function readOverviewSample(
  track: OverviewTrack,
  round: OverviewTrackRound,
  sampleIndex: number,
  robotIndex: number,
  target: OverviewEntitySample = { x: 0, y: 0, z: 0, defeated: false }
): OverviewEntitySample {
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= round.sampleCount) {
    fail(`${round.descriptor.key} sample index ${sampleIndex} is out of range`);
  }
  if (!Number.isSafeInteger(robotIndex) || robotIndex < 0 || robotIndex >= round.robotIds.length) {
    fail(`${round.descriptor.key} robot index ${robotIndex} is out of range`);
  }
  const offset =
    round.recordsOffset +
    (sampleIndex * round.robotIds.length + robotIndex) * RECORD_BYTES;
  const view = TRACK_VIEWS.get(track);
  if (!view) fail('track was not created by parseOverviewTrack');
  const scale = track.positionQuantizationCm;
  target.x = view.getInt16(offset, true) * scale;
  target.y = view.getInt16(offset + 2, true) * scale;
  target.z = view.getInt16(offset + 4, true) * scale;
  target.defeated = (view.getUint8(offset + 6) & 1) !== 0;
  return target;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    fail('browser does not support SHA-256 integrity verification');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return shaBytesToHex(new Uint8Array(digest));
}

export async function loadOverviewTrack(
  descriptor: OverviewTrackDescriptor,
  expectedRounds: readonly StaticReplayRoundDescriptor[],
  databaseSha256: string,
  signal: AbortSignal,
  baseUrl = import.meta.env.BASE_URL,
  documentBaseUrl = document.baseURI
): Promise<OverviewTrack> {
  const url = publicAssetUrl(descriptor.assetPath, baseUrl, documentBaseUrl);
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) fail(`HTTP ${response.status} while loading ${url}`);
  if (response.body === null) fail(`response body is missing while loading ${url}`);
  if (typeof globalThis.DecompressionStream !== 'function') {
    fail('browser does not support gzip overview decompression');
  }
  const compressed = await new Response(response.body).arrayBuffer();
  if (compressed.byteLength !== descriptor.compressedBytes) {
    fail(
      `${descriptor.regionKey} compressed bytes ${compressed.byteLength} != ${descriptor.compressedBytes}`
    );
  }
  const digest = await sha256Hex(compressed);
  if (digest !== descriptor.sha256) {
    fail(`${descriptor.regionKey} SHA-256 ${digest} != ${descriptor.sha256}`);
  }
  const stream = new Blob([compressed]).stream().pipeThrough(
    new DecompressionStream('gzip'),
    { signal }
  );
  const decompressed = await new Response(stream).arrayBuffer();
  return parseOverviewTrack(decompressed, descriptor, expectedRounds, databaseSha256);
}

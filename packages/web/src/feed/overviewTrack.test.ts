import { describe, expect, it } from 'vitest';
import { parseOverviewTrack, readOverviewSample } from './overviewTrack';
import type {
  OverviewTrackDescriptor,
  StaticReplayRoundDescriptor,
} from './staticReplayCatalog';

const databaseSha256 = 'ab'.repeat(32);
const payloadBytes = 28 + 2 + 7;
const uncompressedBytes = 64 + payloadBytes;

const round: StaticReplayRoundDescriptor = {
  key: 'rmuc2026-east-m001-g1',
  label: 'G1',
  assetKey: 'rmuc2026-east-m001',
  seriesKey: 'rmuc2026-east-m001',
  assetPath: 'replays/rmuc2026-regionals/east/m001.json.gzip',
  encoding: 'gzip',
  regionKey: 'east',
  regionLabel: '东部赛区',
  matchNumber: 1,
  roundNumber: 1,
  gameId: 1_778_631_047_459,
  webGameId: 83_163,
  winner: '红',
  startedLocal: '2026-01-01 00:00:00',
  redSchool: '红方',
  blueSchool: '蓝方',
  roundCount: 1,
  assetRoundCount: 2,
  startMs: 0,
  endMs: 1_000,
  durationMs: 1_000,
  frameStartIndex: 0,
  frameCount: 10,
  frameCountInRound: 10,
  assetFrameCount: 50,
  assetDurationMs: 5_000,
  compressedBytes: 100,
  sha256: 'a'.repeat(64),
  competitionKey: 'rmuc2026',
  competitionLabel: 'RMUC2026',
  mapKey: 'rmuc2026',
  mapLabel: 'RMUC2026',
};

const descriptor: OverviewTrackDescriptor = {
  schema: 'gsm-rmuc2026-overview-track/1',
  assetPath: 'replays/rmuc2026-regionals/overview/east.bin.gzip',
  encoding: 'gzip',
  regionKey: 'east',
  sampleHz: 1,
  positionQuantizationCm: 1,
  roundCount: 1,
  timelineSampleCount: 1,
  entitySampleCount: 1,
  uncompressedBytes,
  compressedBytes: 50,
  sha256: 'b'.repeat(64),
};

function fixture(): Uint8Array {
  const bytes = new Uint8Array(uncompressedBytes);
  bytes.set(new TextEncoder().encode('GSMOVW01'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  view.setUint8(10, 0);
  view.setUint8(11, 1);
  view.setUint8(12, 7);
  view.setUint8(13, 1);
  view.setUint16(14, 1, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, payloadBytes, true);
  bytes.set(Uint8Array.from(databaseSha256.match(/../g)!.map((hex) => Number.parseInt(hex, 16))), 28);
  let offset = 64;
  view.setUint16(offset, 1, true);
  view.setUint8(offset + 2, 1);
  view.setUint8(offset + 3, 1);
  view.setBigUint64(offset + 4, BigInt(round.gameId), true);
  view.setUint32(offset + 12, round.webGameId, true);
  view.setUint16(offset + 16, 1, true);
  view.setUint16(offset + 18, 1, true);
  view.setUint32(offset + 20, 1, true);
  view.setUint32(offset + 24, 9, true);
  offset += 28;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setInt16(offset, 123, true);
  view.setInt16(offset + 2, -456, true);
  view.setInt16(offset + 4, 78, true);
  view.setUint8(offset + 6, 1);
  return bytes;
}

describe('overview track parser', () => {
  it('parses strict identity and reuses the caller-provided sample object', () => {
    const track = parseOverviewTrack(fixture(), descriptor, [round], databaseSha256);
    const target = { x: 0, y: 0, z: 0, defeated: false };
    const sample = readOverviewSample(track, track.rounds[0], 0, 0, target);

    expect(sample).toBe(target);
    expect(sample).toEqual({ x: 123, y: -456, z: 78, defeated: true });
  });

  it('rejects unknown flags during parsing', () => {
    const bytes = fixture();
    bytes[64 + 28 + 2 + 6] = 2;

    expect(() => parseOverviewTrack(bytes, descriptor, [round], databaseSha256)).toThrow(
      /invalid flags/
    );
  });
});

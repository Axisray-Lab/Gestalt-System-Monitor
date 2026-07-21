import { describe, expect, it } from 'vitest';
import { parseStaticReplayCatalog } from './staticReplayCatalog';

const digest = 'a'.repeat(64);

function validCatalog(): Record<string, unknown> {
  return {
    schema: 'gsm-static-replay-catalog/1',
    databaseSha256: digest,
    competition: {
      key: 'rmuc2026',
      label: 'RMUC 2026',
      mapKey: 'rmuc2026',
      mapLabel: 'RMUC 2026',
    },
    seriesCount: 1,
    roundCount: 3,
    regions: [
      {
        key: 'east',
        label: '东部赛区',
        replays: [
          {
            key: 'rmuc2026-east-m001',
            label: 'M001 · 红方学校 vs 蓝方学校',
            assetPath: 'replays/rmuc2026-regionals/east/m001.json.gzip',
            encoding: 'gzip',
            regionKey: 'east',
            regionLabel: '东部赛区',
            matchNumber: 1,
            roundCount: 3,
            redSchool: '红方学校',
            blueSchool: '蓝方学校',
            frameCount: 100,
            durationMs: 10_000,
            compressedBytes: 1_024,
            sha256: digest,
          },
        ],
      },
    ],
  };
}

function firstReplay(catalog: Record<string, unknown>): Record<string, unknown> {
  const regions = catalog.regions as Array<Record<string, unknown>>;
  return (regions[0].replays as Array<Record<string, unknown>>)[0];
}

describe('static replay catalog validation', () => {
  it('accepts the strict v1 catalog and attaches competition/map metadata', () => {
    const parsed = parseStaticReplayCatalog(validCatalog());

    expect(parsed.seriesCount).toBe(1);
    expect(parsed.roundCount).toBe(3);
    expect(parsed.regions[0].replays[0]).toMatchObject({
      competitionKey: 'rmuc2026',
      mapKey: 'rmuc2026',
      regionKey: 'east',
      matchNumber: 1,
      encoding: 'gzip',
    });
  });

  it('rejects unknown fields instead of silently accepting schema drift', () => {
    const catalog = validCatalog();
    firstReplay(catalog).unexpected = true;

    expect(() => parseStaticReplayCatalog(catalog)).toThrow(/contain exactly/);
  });

  it('rejects a replay whose region metadata disagrees with its container', () => {
    const catalog = validCatalog();
    firstReplay(catalog).regionKey = 'south';

    expect(() => parseStaticReplayCatalog(catalog)).toThrow(/must match its region/);
  });

  it('rejects non-gzip descriptors without an alternate loading path', () => {
    const catalog = validCatalog();
    firstReplay(catalog).encoding = 'json';

    expect(() => parseStaticReplayCatalog(catalog)).toThrow(/must equal gzip/);
  });

  it('rejects catalog totals that do not match the replay descriptors', () => {
    const catalog = validCatalog();
    catalog.roundCount = 4;

    expect(() => parseStaticReplayCatalog(catalog)).toThrow(/round totals/);
  });
});

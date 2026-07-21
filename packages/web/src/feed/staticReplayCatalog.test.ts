import { describe, expect, it } from 'vitest';
import generatedCatalog from './rmuc2026ReplayCatalog.generated.json';
import {
  RMUC2026_OVERVIEW_SHARDS,
  RMUC2026_ROUNDS,
  RMUC2026_SERIES,
  parseStaticReplayCatalog,
} from './staticReplayCatalog';

function validCatalog(): Record<string, unknown> {
  return structuredClone(generatedCatalog) as Record<string, unknown>;
}

function firstRegion(catalog: Record<string, unknown>): Record<string, unknown> {
  return (catalog.regions as Array<Record<string, unknown>>)[0];
}

function firstSeries(catalog: Record<string, unknown>): Record<string, unknown> {
  return (firstRegion(catalog).replays as Array<Record<string, unknown>>)[0];
}

function firstRound(catalog: Record<string, unknown>): Record<string, unknown> {
  return (firstSeries(catalog).rounds as Array<Record<string, unknown>>)[0];
}

describe('static replay catalog validation', () => {
  it('exports the exact 266 series, 613 single-game descriptors and three shards', () => {
    const parsed = parseStaticReplayCatalog(validCatalog());

    expect(parsed.regions.map((region) => region.replays.length)).toEqual([88, 88, 90]);
    expect(parsed.regions.map((region) =>
      region.replays.reduce((sum, replay) => sum + replay.roundCount, 0)
    )).toEqual([203, 204, 206]);
    expect(RMUC2026_SERIES).toHaveLength(266);
    expect(RMUC2026_ROUNDS).toHaveLength(613);
    expect(RMUC2026_OVERVIEW_SHARDS).toHaveLength(3);
    expect(RMUC2026_ROUNDS[0]).toMatchObject({
      key: 'rmuc2026-east-m001-g1',
      seriesKey: 'rmuc2026-east-m001',
      roundCount: 1,
      startMs: 0,
      frameStartIndex: 0,
      competitionKey: 'rmuc2026',
      mapKey: 'rmuc2026',
    });
  });

  it('rejects unknown fields instead of silently accepting schema drift', () => {
    const catalog = validCatalog();
    firstRound(catalog).unexpected = true;

    expect(() => parseStaticReplayCatalog(catalog)).toThrow(/contain exactly/);
  });

  it('rejects a round whose shared series asset identity disagrees', () => {
    const catalog = validCatalog();
    firstRound(catalog).seriesKey = 'rmuc2026-east-m999';

    expect(() => parseStaticReplayCatalog(catalog)).toThrow(/series asset or frame boundaries/);
  });

  it('rejects a frame boundary that does not map exactly onto 100 ms frames', () => {
    const catalog = validCatalog();
    firstRound(catalog).endMs = 1_001;

    expect(() => parseStaticReplayCatalog(catalog)).toThrow(/series asset or frame boundaries/);
  });

  it('rejects overview shard metadata with the wrong regional round total', () => {
    const catalog = validCatalog();
    const overview = firstRegion(catalog).overviewTrack as Record<string, unknown>;
    overview.roundCount = 202;

    expect(() => parseStaticReplayCatalog(catalog)).toThrow(/must equal 203/);
  });
});

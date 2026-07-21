import { describe, expect, it } from 'vitest';
import { parseRecordedReplay, replayAssetUrl } from './recordedReplay';

function validReplay(): unknown {
  return {
    schema: 'gsm-watch-replay/2',
    frameCount: 2,
    durationMs: 200,
    map: {
      mapId: 'RMUC2026',
      lines: [],
      bounds: {
        min: { x: -836, y: -1500, z: 0 },
        max: { x: 836, y: 1500, z: 300 },
      },
    },
    frames: [
      {
        t: 0,
        result: {
          watch_attribute_maps_results: [
            {
              sync_type: 0,
              attribute_map_id: 1,
              attributes: { '80000003': 4 },
            },
          ],
        },
      },
      {
        t: 100,
        result: {
          watch_attribute_maps_results: [
            {
              sync_type: 1,
              attribute_map_id: 1,
              attributes: { '80000005': 1 },
            },
          ],
        },
      },
    ],
  };
}

describe('recorded replay validation', () => {
  it('accepts the strict v2 lifecycle shape', () => {
    expect(parseRecordedReplay(validReplay()).frameCount).toBe(2);
  });

  it('rejects an unreachable final frame', () => {
    const replay = validReplay() as { durationMs: number };
    replay.durationMs = 100;
    expect(() => parseRecordedReplay(replay)).toThrow(/last frame/);
  });

  it('rejects a non-monotonic timeline', () => {
    const replay = validReplay() as { frames: Array<{ t: number }> };
    replay.frames[1].t = -1;
    expect(() => parseRecordedReplay(replay)).toThrow();
  });

  it('resolves project-Pages assets below the configured base', () => {
    expect(
      replayAssetUrl(
        'replays/rmuc2026-regionals/east/m088.json.gzip',
        './',
        'https://example.test/Gestalt-System-Monitor/index.html'
      )
    ).toBe(
      'https://example.test/Gestalt-System-Monitor/replays/rmuc2026-regionals/east/m088.json.gzip'
    );
  });

  it('rejects origin-absolute assets', () => {
    expect(() =>
      replayAssetUrl(
        '/replays/east.json',
        './',
        'https://example.test/project/'
      )
    ).toThrow(/relative/);
  });
});

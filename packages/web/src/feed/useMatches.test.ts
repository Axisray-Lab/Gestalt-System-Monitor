import { effectScope, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredProcess } from '@gsm/protocol';
import type { StaticReplayDescriptor } from './staticReplayCatalog';
import { useMatches, type MatchHooks } from './useMatches';

function descriptor(index: number): StaticReplayDescriptor {
  const matchNumber = index + 1;
  const matchId = String(matchNumber).padStart(3, '0');
  return {
    key: `rmuc2026-east-m${matchId}`,
    label: `M${matchId}`,
    assetPath: `replays/rmuc2026-regionals/east/m${matchId}.json.gzip`,
    encoding: 'gzip',
    regionKey: 'east',
    regionLabel: '东部赛区',
    matchNumber,
    roundCount: 3,
    redSchool: `红方${matchId}`,
    blueSchool: `蓝方${matchId}`,
    frameCount: 1,
    durationMs: 100,
    compressedBytes: 1,
    sha256: 'a'.repeat(64),
    competitionKey: 'rmuc2026',
    competitionLabel: 'RMUC 2026',
    mapKey: 'rmuc2026',
    mapLabel: 'RMUC 2026',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('static replay materialization', () => {
  it('projects the full catalog but only creates and fetches the focused replay', () => {
    const replays = Array.from({ length: 266 }, (_, index) => descriptor(index));
    const pendingSignals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) pendingSignals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal('document', { baseURI: 'https://example.test/monitor/index.html' });
    vi.stubGlobal('fetch', fetchMock);

    const added: string[] = [];
    const removed: string[] = [];
    const hooks: MatchHooks = {
      onAdd: key => added.push(key),
      onRemove: key => removed.push(key),
      onMap: vi.fn(),
      onSnapshot: vi.fn(),
    };
    const scope = effectScope();
    const api = scope.run(() =>
      useMatches(ref<DiscoveredProcess[]>([]), hooks, { staticReplays: replays })
    );
    if (!api) throw new Error('useMatches did not initialize');

    expect(api.matches.value).toHaveLength(266);
    expect(added).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    api.start();
    expect(added).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    api.setFocusedKey(replays[0].key);
    expect(added).toEqual([replays[0].key]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pendingSignals[0].aborted).toBe(false);

    api.setFocusedKey(replays[1].key);
    expect(pendingSignals[0].aborted).toBe(true);
    expect(removed).toEqual([replays[0].key]);
    expect(added).toEqual([replays[0].key, replays[1].key]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    api.setFocusedKey(null);
    expect(pendingSignals[1].aborted).toBe(true);
    expect(removed).toEqual([replays[0].key, replays[1].key]);
    expect(api.matches.value[0].status).toBe('idle');
    expect(api.matches.value[1].status).toBe('idle');

    scope.stop();
  });
});

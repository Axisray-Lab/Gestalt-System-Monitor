import { reactive, ref, watch, onUnmounted, type Ref } from 'vue';
import type { DiscoveredProcess, MapWireframe, WorldSnapshot } from '@gsm/protocol';
import { createMockFeed } from './mockFeed';
import { createWsFeed } from './wsFeed';
import type { FeedSource, MatchView } from './types';

/** Stable key for the always-present in-browser mock match. */
export const MOCK_KEY = 'mock';
const MOCK_LABEL = 'RMUC2026AI (mock)';

const keyOf = (p: DiscoveredProcess) => `${p.matchId}@${p.sourceIp}`;

/** Side-effect hooks into the renderer — kept here so unit lifecycle ordering lives in one place. */
export interface MatchHooks {
  /** Create the renderable unit. MUST run before the feed starts delivering. */
  onAdd(key: string, label: string): void;
  /** Tear down the renderable unit. Runs after the feed is closed. */
  onRemove(key: string): void;
  onMap(key: string, map: MapWireframe): void;
  onSnapshot(key: string, snap: WorldSnapshot): void;
}

interface Entry {
  feed: FeedSource;
  view: MatchView;
}

/**
 * Reconciles the live discovery list into a set of simultaneously-open feeds:
 * the built-in mock (always present) plus one WebSocket feed per discovered
 * process. As matches come and go it creates/destroys units + feeds, keyed by
 * `${matchId}@${sourceIp}` so the sidebar list and in-scene focus stay aligned.
 *
 * `hooks` are not invoked until `start()` is called, so the caller can defer the
 * first reconcile until the renderer exists.
 */
export function useMatches(processes: Ref<DiscoveredProcess[]>, hooks: MatchHooks) {
  const entries = new Map<string, Entry>();
  const matches = ref<MatchView[]>([]);
  let started = false;

  function project(): void {
    matches.value = [...entries.values()].map((e) => e.view);
  }

  function add(key: string, label: string, feed: FeedSource, playerCount?: number): void {
    const view = reactive<MatchView>({ key, label, status: 'idle', playerCount });
    hooks.onAdd(key, label); // unit exists before any telemetry arrives
    feed.onStatus((s) => (view.status = s));
    feed.onMap((m) => hooks.onMap(key, m));
    feed.onSnapshot((s) => hooks.onSnapshot(key, s));
    feed.start();
    entries.set(key, { feed, view });
  }

  function remove(key: string): void {
    const e = entries.get(key);
    if (!e) return;
    e.feed.close(); // stop telemetry first
    hooks.onRemove(key); // then drop the unit
    entries.delete(key);
  }

  function reconcile(procs: DiscoveredProcess[]): void {
    const desired = new Map<string, DiscoveredProcess | null>();
    desired.set(MOCK_KEY, null); // mock is always desired
    for (const p of procs) desired.set(keyOf(p), p);

    for (const [key, p] of desired) {
      const existing = entries.get(key);
      if (existing) {
        if (p) {
          // Same match, fresh beacon: update metadata in place, keep the live feed.
          existing.view.label = p.name ?? p.matchId;
          existing.view.playerCount = p.playerCount;
        }
        continue;
      }
      if (key === MOCK_KEY) add(MOCK_KEY, MOCK_LABEL, createMockFeed());
      else if (p) add(key, p.name ?? p.matchId, createWsFeed(p.wsUrl), p.playerCount);
    }
    for (const key of [...entries.keys()]) {
      if (!desired.has(key)) remove(key);
    }
    project();
  }

  // Watch is registered during setup (so it's auto-disposed), but stays inert
  // until start() runs the first reconcile against a ready renderer.
  watch(processes, (p) => {
    if (started) reconcile(p);
  });

  function start(): void {
    if (started) return;
    started = true;
    reconcile(processes.value);
  }

  onUnmounted(() => {
    for (const e of entries.values()) e.feed.close();
    entries.clear();
  });

  return { matches, start };
}

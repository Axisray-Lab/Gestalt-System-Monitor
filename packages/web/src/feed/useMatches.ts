import { reactive, ref, watch, onUnmounted, type Ref } from 'vue';
import type { DiscoveredProcess, MapWireframe, WorldSnapshot } from '@gsm/protocol';
import { createMockFeed } from './mockFeed';
import { createWsFeed } from './wsFeed';
import type { FeedSource, MatchView } from './types';

const keyOf = (p: DiscoveredProcess) => `${p.matchId}@${p.sourceIp}`;

/** Options for {@link useMatches}. */
export interface UseMatchesOptions {
  /** How many built-in mock matches to spawn (all render the RMUC2026 arena). Default 1. */
  mockCount?: number;
}

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
  started: boolean;
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
export function useMatches(
  processes: Ref<DiscoveredProcess[]>,
  hooks: MatchHooks,
  opts: UseMatchesOptions = {}
) {
  const mockKeys = Array.from({ length: opts.mockCount ?? 1 }, (_, i) => `mock-${i}`);
  const entries = new Map<string, Entry>();
  const matches = ref<MatchView[]>([]);
  let activeKeys = new Set<string>();
  let started = false;

  function project(): void {
    matches.value = [...entries.values()].map((e) => e.view);
  }

  function add(key: string, label: string, feed: FeedSource, process?: DiscoveredProcess): void {
    const view = reactive<MatchView>({
      key,
      label,
      status: 'idle',
      playerCount: process?.playerCount,
      localLaunchId: process?.localLaunchId,
      localLaunchPid: process?.localLaunchPid,
    });
    feed.onStatus((s) => (view.status = s));
    feed.onMap((m) => hooks.onMap(key, m));
    feed.onSnapshot((s) => hooks.onSnapshot(key, s));
    const entry: Entry = { feed, view, started: false };
    entries.set(key, entry);
    hooks.onAdd(key, label); // unit exists before any telemetry arrives
    if (activeKeys.has(key)) startFeed(entry);
  }

  function remove(key: string): void {
    const e = entries.get(key);
    if (!e) return;
    e.feed.close(); // stop telemetry first
    hooks.onRemove(key); // then drop the unit
    entries.delete(key);
  }

  function startFeed(entry: Entry): void {
    if (entry.started) return;
    entry.started = true;
    entry.feed.start();
    entry.feed.setActive(true);
  }

  function reconcile(procs: DiscoveredProcess[]): void {
    const desired = new Map<string, DiscoveredProcess | null>();
    for (const k of mockKeys) desired.set(k, null); // built-in mocks always present
    for (const p of procs) desired.set(keyOf(p), p);

    for (const [key, p] of desired) {
      const existing = entries.get(key);
      if (existing) {
        if (p) {
          // Same match, fresh beacon: update metadata in place, keep the live feed.
          existing.view.label = p.name ?? p.matchId;
          existing.view.playerCount = p.playerCount;
          existing.view.localLaunchId = p.localLaunchId;
          existing.view.localLaunchPid = p.localLaunchPid;
        }
        continue;
      }
      if (mockKeys.includes(key)) add(key, `RMUC2026AI #${mockKeys.indexOf(key) + 1}`, createMockFeed());
      else if (p) add(key, p.name ?? p.matchId, createWsFeed(p.wsUrl, p.mapId), p);
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

  /** Gate each feed by whether its board currently renders (driven by the scene's
   *  stack-visibility). Hidden boards fully disconnect; the agent-side replay is
   *  lazy too, so large libraries stay as catalog entries until viewed. */
  function setActiveKeys(active: Set<string>): void {
    activeKeys = new Set(active);
    for (const [key, entry] of entries) {
      if (activeKeys.has(key)) {
        startFeed(entry);
        continue;
      }
      if (!entry.started) continue;
      entry.feed.close();
      entry.started = false;
      entry.view.status = 'idle';
    }
  }

  onUnmounted(() => {
    for (const e of entries.values()) e.feed.close();
    entries.clear();
  });

  return { matches, start, setActiveKeys };
}

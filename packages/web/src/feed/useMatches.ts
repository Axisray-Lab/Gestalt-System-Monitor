import { onScopeDispose, reactive, ref, watch, type Ref } from 'vue';
import type { DiscoveredProcess, MapWireframe, WorldSnapshot } from '@gsm/protocol';
import { createMockFeed } from './mockFeed';
import type { StaticReplayRoundDescriptor } from './staticReplayCatalog';
import { createWsFeed } from './wsFeed';
import type { FeedSource, MatchView } from './types';

const keyOf = (process: DiscoveredProcess) => `${process.matchId}@${process.sourceIp}`;

/** Options for {@link useMatches}. */
export interface UseMatchesOptions {
  /** Static, browser-hosted replay fixtures. Empty by default for live/dev use. */
  staticReplays?: readonly StaticReplayRoundDescriptor[];
}

/** Side-effect hooks into the renderer — kept here so unit lifecycle ordering lives in one place. */
export interface MatchHooks {
  /** Create the renderable unit. MUST run before the feed starts delivering. */
  onAdd(key: string, label: string): void;
  /** Tear down the renderable unit. Runs after the feed is closed. */
  onRemove(key: string): void;
  onMap(key: string, map: MapWireframe): void;
  onSnapshot(key: string, snap: WorldSnapshot): void;
  onReplayPlayback?(key: string, paused: boolean): void;
  onReplayDiscontinuity?(key: string): void;
}

interface Entry {
  kind: 'live' | 'static';
  feed: FeedSource;
  view: MatchView;
  started: boolean;
}

function staticView(replay: StaticReplayRoundDescriptor): MatchView {
  return reactive<MatchView>({
    key: replay.key,
    label: replay.label,
    status: 'idle',
    staticReplay: {
      competitionKey: replay.competitionKey,
      competitionLabel: replay.competitionLabel,
      mapKey: replay.mapKey,
      mapLabel: replay.mapLabel,
      regionKey: replay.regionKey,
      regionLabel: replay.regionLabel,
      seriesKey: replay.seriesKey,
      matchNumber: replay.matchNumber,
      roundNumber: replay.roundNumber,
      gameId: replay.gameId,
      roundCount: replay.roundCount,
      redSchool: replay.redSchool,
      blueSchool: replay.blueSchool,
    },
  });
}

/**
 * Reconciles live discovery while projecting the complete static replay catalog.
 * Live feeds keep their renderer-driven visibility lifecycle. Static replay
 * entries remain metadata-only until focused; changing focus closes and removes
 * the previous static scene before materializing the next one.
 *
 * `hooks` are not invoked until `start()` is called, so the caller can defer the
 * first reconcile until the renderer exists.
 */
export function useMatches(
  processes: Ref<DiscoveredProcess[]>,
  hooks: MatchHooks,
  opts: UseMatchesOptions = {}
) {
  const staticReplays = opts.staticReplays ?? [];
  const staticReplayByKey = new Map<string, StaticReplayRoundDescriptor>();
  const staticViews = new Map<string, MatchView>();
  for (const replay of staticReplays) {
    if (staticReplayByKey.has(replay.key)) {
      throw new Error(`Duplicate static replay key: ${replay.key}`);
    }
    staticReplayByKey.set(replay.key, replay);
    staticViews.set(replay.key, staticView(replay));
  }

  const entries = new Map<string, Entry>();
  const matches = ref<MatchView[]>([...staticViews.values()]);
  let activeKeys = new Set<string>();
  let focusedStaticKey: string | null = null;
  let started = false;

  function project(): void {
    const liveViews = [...entries.values()]
      .filter(entry => entry.kind === 'live')
      .map(entry => entry.view);
    matches.value = [...staticViews.values(), ...liveViews];
  }

  function bindFeed(key: string, feed: FeedSource, view: MatchView, kind: Entry['kind']): Entry {
    feed.onStatus(status => (view.status = status));
    feed.onMap(map => hooks.onMap(key, map));
    feed.onSnapshot(snapshot => hooks.onSnapshot(key, snapshot));
    const entry: Entry = { kind, feed, view, started: false };
    entries.set(key, entry);
    hooks.onAdd(key, view.label);
    feed.playback?.onState(state => {
      view.replayPlayback = state;
      hooks.onReplayPlayback?.(key, state.paused);
    });
    feed.playback?.onDiscontinuity(() => hooks.onReplayDiscontinuity?.(key));
    return entry;
  }

  function startFeed(entry: Entry): void {
    if (entry.started) return;
    entry.started = true;
    entry.feed.start();
    entry.feed.setActive(true);
  }

  function addLive(key: string, process: DiscoveredProcess): void {
    const view = reactive<MatchView>({
      key,
      label: process.name ?? process.matchId,
      status: 'idle',
      playerCount: process.playerCount,
      localLaunchId: process.localLaunchId,
      localLaunchPid: process.localLaunchPid,
    });
    const entry = bindFeed(key, createWsFeed(process.wsUrl, process.mapId), view, 'live');
    if (activeKeys.has(key)) startFeed(entry);
  }

  function removeEntry(key: string, resetStaticStatus = false): void {
    const entry = entries.get(key);
    if (!entry) return;
    entry.feed.close();
    hooks.onRemove(key);
    entries.delete(key);
    if (resetStaticStatus) {
      entry.view.status = 'idle';
      delete entry.view.replayPlayback;
    }
  }

  function materializeFocusedStatic(): void {
    if (!started || focusedStaticKey === null || entries.has(focusedStaticKey)) return;
    const replay = staticReplayByKey.get(focusedStaticKey);
    const view = staticViews.get(focusedStaticKey);
    if (!replay || !view) {
      throw new Error(`Static replay catalog state is missing ${focusedStaticKey}`);
    }
    const entry = bindFeed(replay.key, createMockFeed(replay), view, 'static');
    startFeed(entry);
  }

  function reconcile(procs: DiscoveredProcess[]): void {
    const desired = new Map<string, DiscoveredProcess>();
    for (const process of procs) {
      const key = keyOf(process);
      if (staticReplayByKey.has(key)) {
        throw new Error(`Live match key collides with static replay key: ${key}`);
      }
      desired.set(key, process);
    }

    for (const [key, process] of desired) {
      const existing = entries.get(key);
      if (existing) {
        if (existing.kind !== 'live') {
          throw new Error(`Live match key collides with materialized static replay: ${key}`);
        }
        existing.view.label = process.name ?? process.matchId;
        existing.view.playerCount = process.playerCount;
        existing.view.localLaunchId = process.localLaunchId;
        existing.view.localLaunchPid = process.localLaunchPid;
        continue;
      }
      addLive(key, process);
    }
    for (const [key, entry] of [...entries]) {
      if (entry.kind === 'live' && !desired.has(key)) removeEntry(key);
    }
    project();
  }

  // Watch is registered during setup (so it's auto-disposed), but stays inert
  // until start() runs the first reconcile against a ready renderer.
  watch(processes, procs => {
    if (started) reconcile(procs);
  });

  function start(): void {
    if (started) return;
    started = true;
    reconcile(processes.value);
    materializeFocusedStatic();
  }

  /** Materialize exactly one focused static replay. Live focus keys do not alter
   * their existing discovery/visibility lifecycle. */
  function setFocusedKey(key: string | null): void {
    const nextStaticKey = key !== null && staticReplayByKey.has(key) ? key : null;
    if (nextStaticKey === focusedStaticKey) return;
    const previous = focusedStaticKey;
    focusedStaticKey = nextStaticKey;
    if (previous !== null) removeEntry(previous, true);
    materializeFocusedStatic();
  }

  /** Gate live feeds by whether their board currently renders. Static feeds are
   * present only while focused and therefore remain active until focus changes. */
  function setActiveKeys(active: Set<string>): void {
    activeKeys = new Set(active);
    for (const [key, entry] of entries) {
      if (entry.kind === 'static') continue;
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

  function staticPlaybackFor(key: string) {
    const entry = entries.get(key);
    if (!entry || entry.kind !== 'static') {
      throw new Error(`Static replay is not materialized: ${key}`);
    }
    if (!entry.feed.playback) {
      throw new Error(`Static replay feed does not expose playback controls: ${key}`);
    }
    return entry.feed.playback;
  }

  function setReplayPaused(key: string, paused: boolean): void {
    staticPlaybackFor(key).setPaused(paused);
  }

  function seekReplay(key: string, positionMs: number): void {
    staticPlaybackFor(key).seek(positionMs);
  }

  onScopeDispose(() => {
    for (const entry of entries.values()) entry.feed.close();
    entries.clear();
  });

  return {
    matches,
    start,
    setActiveKeys,
    setFocusedKey,
    setReplayPaused,
    seekReplay,
  };
}

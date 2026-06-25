import {
  METHOD_WATCH_ATTRIBUTE_MAPS,
  METHOD_WATCH_ATTRIBUTE_MAPS_RESULT,
  makeWatchParams,
  isNotification,
  type JSONRPCMessage,
  type MapWireframe,
  type WatchAttributeMapsResult,
  type WorldSnapshot,
} from '@gsm/protocol';
import { AttributeStore } from './attributeStore';
import { feedPerf } from './feedPerf';
import type { FeedSource, FeedStatus } from './types';

/**
 * Live feed: connects to a game process's WebSocket and consumes the SAME
 * `attribute.watchAttributeMaps` stream (plain JSON). On connect it subscribes
 * (WatchContinuous); each `watchAttributeMaps.result` push is folded into an
 * AttributeStore and projected to a WorldSnapshot for the renderer. Passive aside
 * from subscribe requests.
 *
 * NOTE: the set of attribute_map_ids that covers ALL vehicles normally comes from
 * a bootstrap chain (global ids -> per-player maps -> battle maps). We start with
 * a broad low-id watch and then subscribe to referenced ids as they appear.
 */

// All attribute maps live in a LOW id space (~1..200) and stream back fine. Per-robot
// combat data is in BATTLE maps (odd low ids, e.g. 95..119) carrying Health/Team/Class;
// bases (class 2001)/outposts (2002)/buildings (1007) sit alongside. NOTE: `80000+` is
// NOT a map id — it is a player-id band. Battle/player
// maps recycle as bots die/respawn, so watching a broad low span keeps catching them.
// The dynamic global->player->battle bootstrap below fills in any ids outside the
// initial low span.
const DEFAULT_WATCH_MAP_IDS = Array.from({ length: 256 }, (_, i) => i + 1);
// Cap snapshot projection rate. A live match streams ~30 Hz, but the renderer
// interpolates between snapshots (and replays are 10 Hz and look fine), so
// projecting more than ~20 Hz just burns the main thread. applyResult still runs
// on every message, so no state is lost — only the expensive projection is coalesced.
const MIN_PROJECT_MS = 50;
const RMUC_FIELD_HALF_X_CM = 836;
const RMUC_FIELD_HALF_Y_CM = 1500;

export function createWsFeed(url: string, mapId?: string | number): FeedSource {
  let ws: WebSocket | null = null;
  let closedByUser = false;
  let reqId = 1;
  let watched = new Set<number>();
  let active = true;
  let lastProjectAt = 0;
  let receivedStream = false;
  let streamWaitTimer: number | null = null;
  const store = new AttributeStore();
  let mapCb: ((m: MapWireframe) => void) | null = null;
  let snapCb: ((s: WorldSnapshot) => void) | null = null;
  let statusCb: ((s: FeedStatus) => void) | null = null;

  const setStatus = (s: FeedStatus) => statusCb?.(s);

  function clearStreamWaitTimer(): void {
    if (streamWaitTimer == null) return;
    window.clearTimeout(streamWaitTimer);
    streamWaitTimer = null;
  }

  function watch(ids: Iterable<number>): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const fresh = [...ids]
      .map((id) => Math.round(id))
      .filter((id) => Number.isFinite(id) && id > 0 && !watched.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) watched.add(id);
    ws.send(
      JSON.stringify({
        type: 0,
        id: reqId++,
        method: METHOD_WATCH_ATTRIBUTE_MAPS,
        params: makeWatchParams(fresh),
      })
    );
  }

  function connect() {
    setStatus('connecting');
    receivedStream = false;
    clearStreamWaitTimer();
    ws = new WebSocket(url);
    ws.onopen = () => {
      watched = new Set<number>();
      // Subscribe to attribute-map streaming.
      watch(DEFAULT_WATCH_MAP_IDS);
      watch(store.referencedMapIds());
      // Load the arena model from the beacon's mapId (telemetry is independent of this).
      // Bounds = the real RMUC field extent in UE cm (long axis is Y), so the model
      // scale + world-position attributes share one coordinate frame.
      if (mapId != null) {
        mapCb?.({
          mapId,
          lines: [],
          bounds: {
            min: { x: -RMUC_FIELD_HALF_X_CM, y: -RMUC_FIELD_HALF_Y_CM, z: 0 },
            max: { x: RMUC_FIELD_HALF_X_CM, y: RMUC_FIELD_HALF_Y_CM, z: 0 },
          },
        });
      }
      streamWaitTimer = window.setTimeout(() => {
        if (!receivedStream) setStatus('idle');
        streamWaitTimer = null;
      }, 6000);
    };
    ws.onerror = () => {
      clearStreamWaitTimer();
      setStatus('error');
    };
    ws.onclose = () => {
      clearStreamWaitTimer();
      if (closedByUser) {
        setStatus('idle');
      } else {
        setStatus('closed');
        setTimeout(connect, 1500);
      }
    };
    ws.onmessage = (ev) => {
      let msg: JSONRPCMessage;
      const tParse = performance.now();
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      feedPerf.parseMs += performance.now() - tParse;
      feedPerf.messages += 1;
      if (!isNotification(msg)) return;
      if (msg.method === METHOD_WATCH_ATTRIBUTE_MAPS_RESULT) {
        if (!receivedStream) {
          receivedStream = true;
          clearStreamWaitTimer();
          setStatus('open');
        }
        // Always fold the update in (cheap) so the store stays warm; only do the
        // expensive id-scan + snapshot projection when this board actually renders.
        const tApply = performance.now();
        store.applyResult(msg.params as WatchAttributeMapsResult);
        feedPerf.applyMs += performance.now() - tApply;
        if (active) {
          const now = performance.now();
          if (now - lastProjectAt >= MIN_PROJECT_MS) {
            lastProjectAt = now;
            watch(store.referencedMapIds());
            const tProject = performance.now();
            const snap = store.toSnapshot();
            feedPerf.projectMs += performance.now() - tProject;
            snapCb?.(snap);
          }
        }
      }
    };
  }

  return {
    label: url,
    onMap: (cb) => (mapCb = cb),
    onSnapshot: (cb) => (snapCb = cb),
    onStatus: (cb) => (statusCb = cb),
    start: () => {
      closedByUser = false;
      connect();
    },
    close: () => {
      closedByUser = true;
      clearStreamWaitTimer();
      ws?.close();
      ws = null;
    },
    setActive: (a) => {
      if (a === active) return;
      active = a;
      // On activation, catch up immediately: subscribe to any newly-referenced
      // battle ids and emit a snapshot now so the board renders on its next frame,
      // not only on its next ~100ms message.
      if (a && ws?.readyState === WebSocket.OPEN) {
        watch(store.referencedMapIds());
        snapCb?.(store.toSnapshot());
        lastProjectAt = performance.now();
      }
    },
  };
}

import {
  METHOD_MAP_GEOMETRY,
  METHOD_WORLD_SNAPSHOT,
  isNotification,
  type JSONRPCMessage,
  type MapWireframe,
  type WorldSnapshot,
} from '@gsm/protocol';
import type { FeedSource, FeedStatus } from './types';

/**
 * Connects directly to a game process's WebSocket and listens for the
 * `monitor.mapGeometry` + `monitor.worldSnapshot` notifications. Reconnects on
 * drop (game processes come and go). Purely passive — it never sends, so it
 * does not consume a player slot or disturb the in-game UI.
 */
export function createWsFeed(url: string): FeedSource {
  let ws: WebSocket | null = null;
  let closedByUser = false;
  let mapCb: ((m: MapWireframe) => void) | null = null;
  let snapCb: ((s: WorldSnapshot) => void) | null = null;
  let statusCb: ((s: FeedStatus) => void) | null = null;

  const setStatus = (s: FeedStatus) => statusCb?.(s);

  function connect() {
    setStatus('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => setStatus('open');
    ws.onerror = () => setStatus('error');
    ws.onclose = () => {
      setStatus('closed');
      if (!closedByUser) setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      let msg: JSONRPCMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (!isNotification(msg)) return;
      if (msg.method === METHOD_WORLD_SNAPSHOT) snapCb?.(msg.params as WorldSnapshot);
      else if (msg.method === METHOD_MAP_GEOMETRY) mapCb?.(msg.params as MapWireframe);
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
      ws?.close();
      ws = null;
    },
  };
}

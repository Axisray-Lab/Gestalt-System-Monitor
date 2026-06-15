import type { MapWireframe, WorldSnapshot } from '@gsm/protocol';

export type FeedStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/**
 * A telemetry source the renderer consumes. Implemented by both the live
 * WebSocket feed (`createWsFeed`) and the in-browser `createMockFeed`, so
 * MonitorView is agnostic to where the data comes from.
 */
export interface FeedSource {
  readonly label: string;
  onMap(cb: (m: MapWireframe) => void): void;
  onSnapshot(cb: (s: WorldSnapshot) => void): void;
  onStatus(cb: (s: FeedStatus) => void): void;
  start(): void;
  close(): void;
}

/**
 * One row in the sidebar match list — the reactive projection of a live match
 * (built-in mock or a discovered process). The renderer keys units by the same
 * string, so list highlight and in-scene focus stay in sync.
 */
export interface MatchView {
  /** 'mock' for the built-in match, else `${matchId}@${sourceIp}`. */
  key: string;
  label: string;
  status: FeedStatus;
  playerCount?: number;
}

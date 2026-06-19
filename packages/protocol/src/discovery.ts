/**
 * LAN-discovery beacon schema.
 *
 * NOTE — this is the *target* contract, not what the game emits today. Currently
 * the beacon only broadcasts after an inbound `lobby.startLanBroadcast` WS request
 * (which nothing sends), and its payload does NOT include the WebSocket port.
 * Making headless matches auto-discoverable requires the game-side support
 * documented in docs/ARCHITECTURE.md ("Game-side requirements"): broadcast at boot
 * and put `wsPort` + `matchId` in the payload. Until then, use the mock agent.
 */

/** What the host puts in each UDP beacon payload (after the magic). */
export interface BeaconPayload {
  /** Stable per-process id so the monitor can de-dup across the beacon's lifetime. */
  matchId: string;
  /** Human-friendly room/match name. */
  name?: string;
  /** Current map identifier. */
  mapId?: string | number;
  /** The (randomized) WebSocket port the monitor must connect to. */
  wsPort: number;
  /** Optional in-process HTTP port (localhost-only today; informational). */
  httpPort?: number;
  playerCount?: number;
  maxPlayers?: number;
  /** Game/build version string. */
  version?: string;
}

/** A live process as tracked by the discovery agent. */
export interface DiscoveredProcess extends BeaconPayload {
  /** Source IP of the UDP datagram (injected by the listener). */
  sourceIp: string;
  /** epoch ms of the most recent beacon. */
  lastSeen: number;
  /** Convenience: ws://<sourceIp>:<wsPort> the browser connects to directly. */
  wsUrl: string;
}

/** Message the agent pushes to the browser over its own WS channel. */
export interface AgentProcessListMessage {
  kind: 'processes';
  processes: DiscoveredProcess[];
}

export type AgentBrowserMessage =
  | AgentProcessListMessage
  | import('./launcher').AgentLauncherStatusMessage;

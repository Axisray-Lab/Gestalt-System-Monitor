/**
 * World-telemetry feed the monitor renders.
 *
 * NOTE — also a *target* contract. Today the game's WebSocket carries only
 * UI/input/lobby/settings events; no vehicle transforms or map geometry are on
 * the wire yet. Emitting these two notification methods is the additive game-side
 * change documented in docs/ARCHITECTURE.md ("Game-side requirements").
 *
 * The monitor's `wsFeed` listens for these JSON-RPC notification methods; the
 * `mockFeed` synthesizes them so the front-end runs with zero game-side work.
 */

/** Per-tick snapshot of all tracked vehicles. */
export const METHOD_WORLD_SNAPSHOT = 'monitor.worldSnapshot';
/** Sent once on connect / on map change. */
export const METHOD_MAP_GEOMETRY = 'monitor.mapGeometry';

/** Unreal world-space, centimetres, Z-up (left-handed). The monitor converts. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface VehicleState {
  /** Stable per-vehicle id for the match's lifetime. */
  id: number;
  name?: string;
  team?: string | number;
  /** World location (UE cm). */
  pos: Vec3;
  /** Heading, degrees (rotator yaw). */
  yaw?: number;
  /** cm/s or game units; rendered on the info panel. */
  speed?: number;
  /** 0..1. */
  health?: number;
  score?: number;
}

export interface WorldSnapshot {
  /** Server time or frame id. */
  t: number;
  vehicles: VehicleState[];
}

/** Map wireframe as a set of polylines (e.g. exported from the track geometry). */
export interface MapWireframe {
  mapId?: string | number;
  /** Each entry is an ordered list of points forming one polyline. */
  lines: Vec3[][];
  bounds?: { min: Vec3; max: Vec3 };
}

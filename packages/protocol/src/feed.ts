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

export type VehicleKind = 'robot' | 'base' | 'outpost' | 'rune' | 'building';

export interface VehicleState {
  /** Stable per-vehicle id for the match's lifetime. */
  id: number;
  /** Source attribute_map_id, useful when another public attribute points at this entity. */
  attributeMapId?: number;
  /** Semantic kind inferred from player-observable wire attributes. */
  kind?: VehicleKind;
  /** Player-observable class/career id from the attribute map. */
  classId?: number;
  name?: string;
  team?: string | number;
  /** In-team robot number (RMUC 1-7). With team makes the nameplate badge, e.g. "B3". */
  teamNumber?: number;
  /** World location (UE cm). */
  pos: Vec3;
  /** Heading, degrees (rotator yaw). */
  yaw?: number;
  /** Turret heading, degrees (rotator yaw). */
  turretYaw?: number;
  /** Turret pitch, degrees; positive raises the muzzle. */
  turretPitch?: number;
  /** cm/s or game units; rendered on the info panel. */
  speed?: number;
  /** 0..1 (current/max). */
  health?: number;
  /** Raw current HP (integer) — drives the segmented bar's 1-precision fill + readout. */
  hp?: number;
  /** Raw max HP — the bar draws one tick per 50 HP across this range. */
  hpMax?: number;
  /** Defeated/dead state projected from player-observable status attributes. */
  defeated?: boolean;
  /** Structure deploy/open state. Used by base hologram armor animation. */
  deployed?: boolean;
  /** Optional respawn progress, 0..1. If absent, the renderer may infer locally. */
  respawnProgress?: number;
  /** Optional structure repair progress, 0..1. Outposts use this for defeated revival. */
  repairProgress?: number;
  /** Optional remaining repair/revival count for repairable structures. */
  repairCount?: number;
  /** Optional remaining respawn time in milliseconds. */
  respawnRemainingMs?: number;
  /** Optional total respawn time in milliseconds. */
  respawnTotalMs?: number;
  score?: number;
  /** Active status glyphs to show as head-of-unit icons (buffs, debuffs, sentry state). */
  buffs?: string[];
  /** Optional resolved target id hint, used for dart visualisation when supplied. */
  dartTargetId?: number;
  /** Dart unit launch allowance, used to detect dart launches from ammo drops. */
  dartAmmo?: number;
  /** Base-side dart hit counter; increments when an enemy dart lands on this base. */
  dartHitCount?: number;
  /** Robot upgrade level (1..N). */
  level?: number;
  /** Launch allowance (17mm + 42mm), matching the OB panel's ammo readout. */
  ammo?: number;
  /** 17mm launch allowance, kept separately so visual effects can infer shot type. */
  ammo17?: number;
  /** 42mm launch allowance, kept separately so visual effects can infer lob shots. */
  ammo42?: number;
  /** Shooter locked out (FiringLocked) → ⊘ icon + dimmed ammo. */
  firingLocked?: boolean;
  /** Firing heat, 0..1 (current / max). */
  heat?: number;
  /** Accumulated damage taken (from DamageTakenTotal attribute). */
  damageTaken?: number;
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

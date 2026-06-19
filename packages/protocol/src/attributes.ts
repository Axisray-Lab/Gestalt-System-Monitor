/**
 * AttributeMap telemetry — the player-observable attribute stream.
 *
 * The monitor consumes the same `attribute.watchAttributeMaps` stream as other
 * spectator clients (plain JSON, not FlatBuffers), instead of a bespoke
 * `monitor.*` push. Gestalt System writes per-entity attributes into its
 * attribute maps; the monitor subscribes and parses those public wire values.
 *
 * Attribute IDs below are a subset of the player-observable wire contract.
 */

/** Subset of the attribute IDs the monitor reads. */
export enum AttrId {
  PlayerID_0 = 0,
  PlayerID_MAX = 100000,
  PlayerBattleAttributeMapID = 1000001,
  Health = 10000003,
  HealthMax = 60000004,
  Shield = 10000013,
  PlayerID = 10000035,
  TeamID = 10000036,
  TeamNumber = 10000037,
  Class = 60000002, // career / vehicle type
  Level = 60000003,
  FiringHeat1 = 10000011,
  FiringHeatMax1 = 60000011,
  ReviveCount = 10000009,
  ReviveProgress = 10000022,
  ReviveSpeed = 10000023,
  Ammo17mmCount = 10000033,
  Ammo42mmCount = 10000034,
  DartInterferenceEffectTrigger = 10000083, // 致盲 (dart interference)
  SentryMode = 10000089,
  Weakened = 50000002, // 虚弱
  Overheated = 50000003,
  FiringLocked = 50000006, // 1 = shooter locked → ⊘ icon + dimmed ammo (the OB panel's rule)
  Defeated = 50000007,
  Invincible = 50000013,
  IsInDeploymentMode = 50000043,
  IsActorHidden = 51000001,
  HealthRatio = 51000008,
  // Buff-pip sources (presence-only): the OB panel's curated set, extra
  // gains/debuffs, and sentry-only public status. Multipliers are active when > 0.
  AttackMultiplierThou = 61000000,
  DefenseMultiplierThou = 61000001,
  RecoverMultiplierThou = 61000003,
  ColdMultiplierThou = 61000004, // 冷却增益
  PowerMultiplierThou = 61000005, // 功率增益
  SentryEnhanced = 61000013,
  ReviveProgressMax = 60000017,
  DamageTakenTotal = 63000001,
  BaseDeployed = 10000101,
  // World pose (UE world cm, Z-up + degrees).
  WorldPosX = 10000107,
  WorldPosY = 10000108,
  WorldPosZ = 10000109,
  ChassisYaw = 10000110,
  TurretYaw = 10000111,
  TurretPitch = 10000112,
  OP_AngularSpeed = 72000001,
  OP_RotationStopRequested = 72000002,
  BS_State = 70000001,
  BS_CurOmega = 70000003,
  TM_Coins = 74000003,
  TM_OutPostRebuildCount = 74000011,
  G_BaseId_0 = 80001000,
  G_BaseId_MAX = 80001999,
  G_OutpostId_0 = 80002000,
  G_OutpostId_MAX = 80002999,
  G_BuffStationId_0 = 80004000,
  G_BuffStationId_MAX = 80004999,
}

/** WS method to start streaming attribute maps. */
export const METHOD_WATCH_ATTRIBUTE_MAPS = 'attribute.watchAttributeMaps';
/** Server push carrying attribute-map updates. */
export const METHOD_WATCH_ATTRIBUTE_MAPS_RESULT = 'watchAttributeMaps.result';

export enum WatchType {
  None = 0,
  WatchOnce = 1,
  WatchContinuous = 2,
  StopWatch = 3,
}

/**
 * Subscribe params (JSON-RPC `params` for {@link METHOD_WATCH_ATTRIBUTE_MAPS}).
 *
 * The web-interface entry point takes a FLAT `attribute_map_ids` array + a single
 * shared `watch_type`; the server fans them out into per-map watch entries.
 */
export interface WatchAttributeMapsParams {
  attribute_map_ids: number[];
  watch_type: WatchType;
}

/** Build a continuous-watch subscribe payload for a set of attribute-map ids. */
export function makeWatchParams(
  ids: number[],
  watchType: WatchType = WatchType.WatchContinuous
): WatchAttributeMapsParams {
  return { attribute_map_ids: ids, watch_type: watchType };
}

/** One attribute map's update. `sync_type` 0 = full replace, 1 = incremental patch. */
export interface AttributeMapUpdate {
  sync_type: number;
  attribute_map_id: number;
  attributes: Record<string, number>;
}

export interface WatchAttributeMapsResult {
  cycle_event_type?: number;
  watch_attribute_maps_results: AttributeMapUpdate[];
}

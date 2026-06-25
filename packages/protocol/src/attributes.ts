/**
 * AttributeMap telemetry — the player-observable attribute stream.
 *
 * The monitor consumes the same `attribute.watchAttributeMaps` stream as other
 * spectator clients (plain JSON, not FlatBuffers). Gestalt System writes per-entity
 * attributes into its attribute maps; the monitor subscribes and parses those
 * public wire values.
 *
 * This enum is a faithful transcription of the game's attribute-id table
 * (`RobotBridgeDemoAttributeDefines.fbs` → `ERobotBridgeDemoAttributeId`), which is
 * player-observable wire contract. Keep it in sync with that source of truth.
 *
 * ID bands: 1xxxxxxx = value attrs, 5000xxxx = boolean tags, 5100xxxx = common
 * function tags, 6xxxxxxx = state/ceiling/multiplier attrs, 7xxxxxxx = scene
 * interaction (rune / control-zone / base-controller / team / global).
 */
export enum AttrId {
  // ---- player attrs (0-band) ----
  PlayerID_0 = 0,
  PlayerID_MAX = 100000,
  PlayerBattleAttributeMapID = 1000001,
  PlayerBaseAttributeMapID = 1000002,

  // ---- value attrs (1xxxxxxx) ----
  EntityId = 10000001,
  Experience = 10000002,
  Health = 10000003,
  BufferEnergy = 10000004,
  CapacityEnergy = 10000005,
  ChassisEnergy = 10000006,
  ChassisPower = 10000007,
  ChassisRealPower = 10000008,
  ReviveCount = 10000009,
  PurchaseReviveCount = 10000010,
  FiringHeat1 = 10000011,
  FiringHeat2 = 10000012,
  Shield = 10000013,
  ChargingPower = 10000014,
  FiringHeatCoolingRate1 = 10000017,
  FiringHeatCoolingRate2 = 10000018,
  IsForceSpin = 10000019,
  ForcedSpinSpeed = 10000020,
  WirelessChargingPower = 10000021,
  ReviveProgress = 10000022,
  ReviveSpeed = 10000023,
  SpawnIndex = 10000024,
  ChassisMode = 10000025,
  ShooterMode = 10000026,
  HeroCombatMode = 10000027,
  ShooterSpreadPara = 10000028,
  ShooterSpeedSpreadPara = 10000029,
  ShooterRealSpeed = 10000030,
  Real17mmAmmoCount = 10000031,
  Real42mmAmmoCount = 10000032,
  Ammo17mmCount = 10000033,
  Ammo42mmCount = 10000034,
  PlayerID = 10000035,
  TeamID = 10000036,
  TeamNumber = 10000037,
  POVRotationPitch = 10000038,
  POVRotationYaw = 10000039,
  POVTargetArmLength = 10000040,

  // RMUC2026 sentry mode system. SentryMode = current mode (0/Move/Defense/Attack);
  // each mode's GAIN is written into the sentry-specific multiplier value positions
  // below (Sentry*MultiplierThou), not inferred from the mode number.
  SentryMode = 10000044,
  SentryModeLastTime_Move = 10000045,
  SentryModeLastTime_Defense = 10000046,
  SentryModeLastTime_Attack = 10000047,
  SentryModeCooldownRemaining = 10000048,

  // muzzle enclosing config
  GunMaxEnclosing = 10000049,
  GunMinEnclosing = 10000050,
  GunEnclosingRatio = 10000051,
  GunTargetDistance = 10000052,

  OutOfCombatCountdown = 10000053,
  // launch mode 0:none 1:once 2:continuous 3:no-safety continuous
  FiringMode = 10000054,
  RemoteAmmoPendingCount = 10000055,
  RemoteAmmoCountdownMs = 10000056,
  RemoteRepairPendingCount = 10000057,
  RemoteRepairCountdownMs = 10000058,
  AutoAimLocked = 10000059,
  ConnectionUpdateFlag = 10000060,
  ConnectionLanAddress = 10000061,
  ConnectionPlatformAccountID = 10000062,
  ConnectionRTT = 10000063,
  ConnectionEntityConfigId = 10000064,
  ConsecutiveLaserHitCount = 10000065,
  AerialLockCount = 10000066,
  RealDartAmmoCount = 10000067,
  RealLaserAmmoCount = 10000068,
  AmmoDartCount = 10000069,
  AmmoLaserCount = 10000070,
  DartControlTarget = 10000071,
  DartBaseTargetMode = 10000072,
  DartGateReady = 10000073,
  DartRemainingShots = 10000074,
  DartKeyNEnabled = 10000075,
  DartKeyMEnabled = 10000076,
  DartKeyJEnabled = 10000077,
  DartAimYaw = 10000078,
  DartAimPitch = 10000079,
  EngineerCarriedTechCoreCount = 10000080,
  DartGateCountdownMs = 10000081,
  DartGateCountdownDurationMs = 10000082,
  DartInterferenceEffectTrigger = 10000083, // 致盲 (dart interference)
  EngineerInitialCoinBonusIndex = 10000084,
  EngineerInitialCoinBonus = 10000085,
  RadarMarkProgress = 10000086,
  RadarMarkDelta = 10000087,
  RadarMarkLastStatus = 10000088,
  RadarMarkLevel = 10000089, // NOTE: the monitor previously mislabelled this as SentryMode
  RadarDoubleVulnerabilityCharges = 10000090,
  RadarDoubleVulnerabilityChargeProgressMs = 10000091,
  RadarDoubleVulnerabilityChargeProgressMaxMs = 10000092,
  RadarDoubleVulnerabilityRemainingMs = 10000093,
  RadarDoubleVulnerabilityUsedCount = 10000094,
  RadarDetectionMode = 10000095,
  DartAimArmorPlateId = 10000096,
  AerialFreeSupportTimeMs = 10000097,
  RMUC2026_Tech_L1 = 10000098,
  RMUC2026_Tech_L2 = 10000099,
  RMUC2026_Tech_L3 = 10000100,
  RMUC2026_Tech_L4 = 10000101, // a tech-upgrade level — NOT the base deploy state
  // (the base's 展开/armour-open state is BC_State 73000001, used as `deployed`).
  BoostControlMode = 10000102,
  SentryModeEnhancedRemaining_Move = 10000103,
  SentryModeEnhancedRemaining_Defense = 10000104,
  SentryModeEnhancedRemaining_Attack = 10000105,
  HeroDeploymentModeCooldownRemainingMs = 10000106,

  // World pose (Issue #40 monitor telemetry; raw native UE units, double on the wire):
  //   WorldPos*  : world location in UE centimetres (cm).
  //   ChassisYaw : chassis yaw, degrees, world frame, [-180,180].
  //   TurretYaw/Pitch: gun-muzzle world rotation in degrees (world-absolute).
  WorldPosX = 10000107,
  WorldPosY = 10000108,
  WorldPosZ = 10000109,
  ChassisYaw = 10000110,
  TurretYaw = 10000111,
  TurretPitch = 10000112,

  // ---- boolean tags (5000xxxx) ----
  OutOfCombat = 50000001,
  Weakened = 50000002, // 虚弱
  Overheated = 50000003, // 过热
  Blocked = 50000004,
  Reviving = 50000005,
  FiringLocked = 50000006, // 1 = shooter locked → ⊘ icon + dimmed ammo
  Defeated = 50000007,
  PermanentFiringLocked = 50000008,
  LowPower = 50000009,
  CanSupply = 50000010,
  CanRevive = 50000011,
  CanOccupy = 50000012, // 可占垒
  Invincible = 50000013, // 无敌
  IsChassisOnline = 50000014,
  HasGun = 50000016,
  IsInSupplyArea = 50000017,
  IsPrepared = 50000018,
  IsMatchStarted = 50000019,
  RFIDDisabled = 50000020,
  CanOperate = 50000021,
  IsBoost = 50000022,
  IsCharging = 50000023,
  IsInBaseGainPoint = 50000024,
  IsInRampGainPoint = 50000025,
  TerrainCrossingStage1_Road = 50000026,
  TerrainCrossingStage1_Ramp_Reverse = 50000027,
  HasTerrainCrossing_Road = 50000028,
  HasTerrainCrossing_Road_Buff = 50000029,
  TerrainCrossingStage1_Highland = 50000030,
  HasTerrainCrossing_Highland = 50000031,
  HasTerrainCrossing_Highland_Buff = 50000032,
  TerrainCrossingStage1_Ramp = 50000033,
  HasTerrainCrossing_Ramp = 50000034,
  HasTerrainCrossing_Ramp_Buff = 50000035,
  HasTerrainCrossingDefenseBuff = 50000036, // 过地形：防御增益
  HasTerrainCrossingRefreshBuff = 50000037,
  IsInHighlandGainPoint = 50000038,
  IsInOutpostGainPoint = 50000039,
  IsInFortressGainPoint = 50000040,
  IsInFortressOccupyPoint = 50000041, // 占垒：机器人位于占领点内
  IsInDeploymentArea = 50000042,
  IsInDeploymentMode = 50000043,
  IsDeploymentModeChanging = 50000044,
  CanEnhancedSupply = 50000045,
  HasTeamDefenseBuff = 50000046,
  HasFortressAmmo = 50000047,
  TerrainCrossingStage1_Tunnel = 50000048,
  TerrainCrossingStage2_Tunnel = 50000049,
  HasTerrainCrossing_Tunnel = 50000050,
  HasTerrainCrossing_Tunnel_Buff = 50000051,
  HasTerrainCrossing_Tunnel_ColdBuff = 50000052, // 过洞：冷却增益（标志位，配 TerrainCrossingColdMultiplierThou）
  CanPurchaseRevive = 50000053,
  IsInAssemblyArea = 50000054,
  HasEngineerEarlyDefenseBuff = 50000055,
  EngineerAssemblyInvincibleRemainingMs = 50000056,
  EngineerEarlyDefenseRemainingMs = 50000057,
  EngineerSelectedAssemblyLevel = 50000058,
  HasSmallRuneBuff = 50000059,
  EngineerTeamEnergyUnitStock = 50000060,
  EngineerSupplyTaskState = 50000061,
  EngineerSupplyTaskCountdownMs = 50000062,
  EngineerSupplyTaskDurationMs = 50000063,
  EngineerAssemblyTaskState = 50000064,
  EngineerAssemblyTaskCountdownMs = 50000065,
  EngineerAssemblyTaskDurationMs = 50000066,
  EngineerAssemblyCooldownCountdownMs = 50000067,
  EngineerAssemblyMaxCompletedLevel = 50000068,
  DartBlocked2s = 50000069,
  DartBlocked3s = 50000070,
  DartBlocked5s = 50000071,
  DartBlocked10s = 50000072,
  RadarMarkAccurateTag = 50000073,
  RadarDoubleVulnerabilityActive = 50000074,
  RadarHasVulnerableTarget = 50000075,
  SentryModeFatigued_Move = 50000076,
  SentryModeFatigued_Defense = 50000077,
  SentryModeFatigued_Attack = 50000078,
  EngineerEarlyDefenseActive = 50000079,
  EngineerAssemblyInvincibleActive = 50000080,
  AerialIsSupporting = 50000081,
  BigRuneBuffArmCount = 50000082,
  BigRuneBuffLightCount = 50000083,
  DartCounterBuffSuspended = 50000084,
  DartDetectionWindowClosed = 50000085,
  IsBoostOverdraftAllowed = 50000086,
  SentryModeEnhanced = 50000087, // 哨兵强化模式标志（取代旧的错误 id 61000013）
  IsAIControlled = 50000088,
  AIMoveMode = 50000089,
  AITargetMode = 50000090,
  AIFireRateMilliHz = 50000091,
  AIFireMaxErrorMilliDeg = 50000092,
  IsInRuneZone = 50000093,
  AIRequestJump = 50000094,
  AIRequestSpecialAction1 = 50000095,
  AIRequestSpecialAction2 = 50000096,

  // ---- common function tags (5100xxxx) ----
  IsActorHidden = 51000001,
  BindActorInstanceId = 51000002,
  HP_Flash = 51000003,
  HP_MainColorSwitch = 51000004,
  HP_SideColorSwitch = 51000005,
  HP_MainColorIntensity = 51000006,
  HP_SideColorIntensity = 51000007,
  HP_Progress = 51000008, // 0..1 health ratio (the monitor reads this as the HP fill)

  // ---- state / ceiling attrs (6xxxxxxx) ----
  Class = 60000002, // career / vehicle type
  Level = 60000003,
  HealthMax = 60000004,
  BufferEnergyMax = 60000005,
  CapacityEnergyMax = 60000006,
  ChassisEnergyMax = 60000007,
  ChassisPowerMax = 60000008,
  ChassisOperatePower = 60000009,
  AmmoCountMax = 60000010,
  FiringHeatMax1 = 60000011,
  FiringHeatExceedMax1 = 60000012,
  FiringHeatMax2 = 60000013,
  FiringHeatExceedMax2 = 60000014,
  AirSupportTimeMax = 60000015,
  WirelessChargingPowerMax = 60000016,
  ReviveProgressMax = 60000017,
  LevelMax = 60000018,
  ExperienceMax = 60000019,
  NextLevelExpMax = 60000020,
  CapacityEnergyPowerMax = 60000021,
  CapacityEnergyChargePowerMax = 60000022,

  // Generic gain multipliers (active when > 0). These carry buffs from runes /
  // zones / terrain for the non-sentry careers.
  AttackMultiplierThou = 61000000,
  DefenseMultiplierThou = 61000001, // 防御增益
  DamageMultiplierThou = 61000002, // 易伤减益：受到伤害的倍率（值>0 = 受伤加重）。是 debuff，不是攻击增益
  RecoverMultiplierThou = 61000003, // 恢复增益
  ColdMultiplierThou = 61000004, // 冷却增益（神符）
  PowerMultiplierThou = 61000005, // 功率增益
  FortressCoolingValue = 61000006, // 冷却增益（堡垒/碉堡）

  // Sentry-specific gains (RMUC2026 §5.6.4): the sentry's mode gains live in these
  // value positions, NOT in the SentryMode number. "Gain" types take the max:
  SentryDefenseMultiplierThou = 61000007, // 防御增益（哨兵）
  SentryDamageMultiplierThou = 61000008, // 攻击/损伤增益（哨兵）
  SentryColdMultiplierThou = 61000011, // 冷却增益（哨兵）
  TerrainCrossingColdMultiplierThou = 61000012, // 冷却增益（增益点/过洞）
  RadarDamageMultiplierThou = 61000013, // NOTE: monitor previously mislabelled this as SentryEnhanced
  // "Coefficient" types multiply after the base value (cooling decay / power reduction).
  SentryColdCoefficientThou = 61000009,
  SentryPowerCoefficientThou = 61000010,

  // bullet attrs (62)
  BulletType = 62000000,
  BulletSpeed = 62000001,
  BulletSize = 62000004,
  BulletOwnerActorID = 62000005,
  BulletInitPacked32 = 62000006,
  ProjectileCountPerShot = 62000007,

  // statistics (63)
  DamageAppliedTotal = 63000000,
  DamageTakenTotal = 63000001,
  BulletFiredTotal = 63000002,

  // ---- scene interaction (7xxxxxxx) ----
  // rune (energy station)
  BS_State = 70000001,
  BS_IsSuccess = 70000002,
  BS_CurOmega = 70000003,
  BS_CurRoll = 70000004,
  BS_SetTargetIndex = 70000005,
  BS_SetTargetRingNum = 70000006,
  BS_SetTargetState = 70000007,
  BS_Target_0 = 70000008,
  BS_Target_1 = 70000009,
  BS_Target_2 = 70000010,
  BS_Target_3 = 70000011,
  BS_Target_4 = 70000012,
  BS_CurA = 70000013,
  BS_CurW = 70000014,
  BS_CurB = 70000015,
  BS_PhaseMode = 70000016,
  BS_RemainingChances = 70000017,
  BS_NextActivatableInMs = 70000018,
  BS_NextActivatableTotalMs = 70000019,

  // exchange/transition station (71)
  TP_CheckInterval = 71000001,
  TP_CheckMinTime = 71000002,
  TP_CheckMaxTime = 71000003,
  TP_SuccessChance = 71000004,
  TP_DetectorExtent_X = 71000005,
  TP_DetectorExtent_Y = 71000006,
  TP_DetectorExtent_Z = 71000007,

  // outpost station (72)
  OP_AngularSpeed = 72000001,
  OP_RotationStopRequested = 72000002,

  // base controller (73)
  BC_State = 73000001,
  BC_DartDetectionMode = 73000002,
  BC_DartModuleROM = 73000003,
  BC_MoveInterval = 73000004,
  BC_MoveTarget = 73000005,

  // team attrs (74)
  TM_State = 74000001,
  TM_Color = 74000002,
  TM_Coins = 74000003,
  TM_LevelMax = 74000004,
  TM_Ammo17mmMax = 74000005,
  TM_Ammo42mmMax = 74000006,
  TM_SupportCoins_70 = 74000007,
  TM_SupportCoins_140 = 74000008,
  G_ControlZone_TeamID = 74000009,
  TM_BaseDamageCount = 74000010,
  TM_OutPostRebuildCount = 74000011,
  TM_SentrySupplyAmmo = 74000012,
  TM_FortAmmo = 74000013,
  G_BlueOutpostZone_TeamID = 74000014,
  G_RedOutpostZone_TeamID = 74000015,
  G_BlueBaseCountdown = 74000016,
  G_RedBaseCountdown = 74000017,
  G_BlueOutpostRepairProgress = 74000018,
  G_RedOutpostRepairProgress = 74000019,
  G_ControlZone1_TeamID = 74000020,
  G_ControlZone2_TeamID = 74000021,
  TM_FortAmmoCapMax = 74000022,

  // zone controller (75) — 占垒/占点 progress lives here
  TB_MarkerId = 75000001,
  TB_BelongTeamID = 75000002, // controlling team (occupier)
  TB_ControlSpeed = 75000003,
  TB_ControlProgress = 75000004, // 占垒进度
  TB_ControlProgressMax = 75000005,
  TB_ControlLostTime = 75000006,
  TB_ControlLostDelay = 75000007,

  // ---- global vars (8xxxxxxx) ----
  G_MaxGameTime = 80000001,
  G_CurGameTime = 80000002,
  G_CurMapId = 80000003,
  G_CurMatchStatus = 80000005,
  G_GameStartCountDown = 80000006,
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

/**
 * Team-builder wire contract — the custom-match roster payload the SPA authors and
 * the agent launches (carried as an autostart parameter to a headless match).
 *
 * This is the player-observable launch interface only. Cost/score and any
 * game-internal balance are NOT modeled here — the SPA obtains them at runtime
 * (see the agent's team-config endpoint) and the game never reads them.
 */

/** Career id = the Class attribute value; fixed by the slot (read-only in the UI). */
export enum CareerId {
  Hero = 1001,
  Engineer = 1002,
  Infantry = 1003,
  Sentry = 1004,
  Aerial = 1005,
  Radar = 1006,
  Dart = 1007,
}

export enum RuleSet {
  RMUC2026 = 'RMUC2026',
  RMUL2026 = 'RMUL2026',
  RMUL2026_1V1 = 'RMUL2026_1V1',
}

export enum RosterAttrId {
  CapacityEnergyPowerMax = 60000021,
  Ammo17mmCount = 10000033,
  Real17mmAmmoCount = 10000031,
  Ammo42mmCount = 10000034,
  Real42mmAmmoCount = 10000032,
  ShooterSpeedSpreadPara = 10000029,
  GunMaxEnclosing = 10000049,
  GunMinEnclosing = 10000050,
  AIFireRateMilliHz = 50000091,
  DartControlTarget = 10000071,
  DartBaseTargetMode = 10000072,
  EngineerSelectedAssemblyLevel = 50000058,
  EngineerTeamEnergyUnitStock = 50000060,
  EngineerAssemblyMaxCompletedLevel = 50000068,
  RadarDetectionMode = 10000095,
}

export const ROSTER_TEAM_RED = 0;
export const ROSTER_TEAM_BLUE = 1;

export interface RuleSetDescriptor {
  id: RuleSet;
  label: string;
  mapId: number;
  slots: Array<{ teamNumber: number; careerId: CareerId; entityType: number }>;
}

export const RULESETS: Record<RuleSet, RuleSetDescriptor> = {
  [RuleSet.RMUC2026]: {
    id: RuleSet.RMUC2026,
    label: 'RMUC 2026',
    mapId: 4,
    slots: [
      { teamNumber: 1, careerId: CareerId.Hero, entityType: 66000001 },
      { teamNumber: 2, careerId: CareerId.Engineer, entityType: 66000014 },
      { teamNumber: 3, careerId: CareerId.Infantry, entityType: 66000002 },
      { teamNumber: 4, careerId: CareerId.Infantry, entityType: 66000008 },
      { teamNumber: 6, careerId: CareerId.Aerial, entityType: 66000013 },
      { teamNumber: 7, careerId: CareerId.Sentry, entityType: 66000005 },
    ],
  },
  [RuleSet.RMUL2026]: {
    id: RuleSet.RMUL2026,
    label: 'RMUL 2026',
    mapId: 5,
    slots: [
      { teamNumber: 1, careerId: CareerId.Hero, entityType: 66000001 },
      { teamNumber: 3, careerId: CareerId.Infantry, entityType: 66000002 },
      { teamNumber: 7, careerId: CareerId.Sentry, entityType: 66000005 },
    ],
  },
  [RuleSet.RMUL2026_1V1]: {
    id: RuleSet.RMUL2026_1V1,
    label: 'RMUL 1v1',
    mapId: 7,
    slots: [
      { teamNumber: 3, careerId: CareerId.Infantry, entityType: 66000002 },
    ],
  },
};

/** One roster slot. `careerId` is fixed by the slot; the player picks `entityType`
 *  (the 构型) from that career's options and tunes the per-slot settings below. */
export interface RosterSlotConfig {
  teamNumber: number; // slot number within the team
  careerId: number; // fixed by the slot; echo-only
  entityType: number; // chosen construct id

  /** Sparse per-instance attribute overrides (attributeId → raw value). */
  paramOverrides?: Record<number, number>;

  // Optional per-slot match settings (present only when the slot exposes them):
  firingIntervalMs?: number;
  spread?: { maxEnclosing: number; minEnclosing: number };
  dart?: { canOutpost: boolean; canBase: boolean; maxBaseMode: 0 | 1 | 2 | 3 };
  engineer?: { maxAssemblyLevel: 1 | 2 | 3 | 4; corePool: 2 | 4 | 6; assemblyDurMsByLevel?: number[] };
  radar?: { maxLockRangeM: number; detectionMode: 0 | 1 | 2 };

  /** UI-side only (cost is computed from runtime config; not sent to the game). */
  slotCost?: number;
}

export interface TeamConfig {
  teamId: number; // 0 / 1
  slots: RosterSlotConfig[];
  teamCost?: number; // UI-side only
}

export interface HeadlessMatchConfig {
  mapId: number;
  nettype: number;
  teams: TeamConfig[];
  aiFill: boolean;
  attrrecord?: boolean;
  attrrecordHz?: number;
  hudHidden?: boolean;
}

export interface RosterAttrPair {
  attrId: number;
  value: number;
}

export function createDefaultMatch(ruleSet: RuleSet = RuleSet.RMUC2026): HeadlessMatchConfig {
  const descriptor = RULESETS[ruleSet];
  return {
    mapId: descriptor.mapId,
    nettype: 0,
    aiFill: true,
    hudHidden: false,
    attrrecord: false,
    teams: [
      createDefaultTeam(ROSTER_TEAM_RED, descriptor),
      createDefaultTeam(ROSTER_TEAM_BLUE, descriptor),
    ],
  };
}

export function createDefaultTeam(teamId: number, ruleSet: RuleSetDescriptor = RULESETS[RuleSet.RMUC2026]): TeamConfig {
  return {
    teamId,
    slots: ruleSet.slots.map((slot) => ({
      ...slot,
      entityType: defaultEntityTypeForSlot(teamId, ruleSet.id, slot),
    })),
  };
}

export function slotAttrPairs(slot: RosterSlotConfig): RosterAttrPair[] {
  const attrs = new Map<number, number>();
  const set = (attrId: number, value: number | undefined) => {
    if (value == null || !Number.isFinite(value)) return;
    attrs.set(attrId, Math.round(value));
  };

  if (slot.firingIntervalMs != null && slot.firingIntervalMs > 0) {
    set(RosterAttrId.AIFireRateMilliHz, 1_000_000 / slot.firingIntervalMs);
  }
  if (slot.spread) {
    set(RosterAttrId.GunMaxEnclosing, slot.spread.maxEnclosing);
    set(RosterAttrId.GunMinEnclosing, slot.spread.minEnclosing);
  }
  if (slot.dart) {
    if (slot.dart.canOutpost || slot.dart.canBase) {
      set(RosterAttrId.DartControlTarget, slot.dart.canBase ? 1 : 0);
      if (slot.dart.canBase) set(RosterAttrId.DartBaseTargetMode, slot.dart.maxBaseMode);
    }
  }
  if (slot.engineer) {
    set(RosterAttrId.EngineerSelectedAssemblyLevel, slot.engineer.maxAssemblyLevel);
    set(RosterAttrId.EngineerAssemblyMaxCompletedLevel, slot.engineer.maxAssemblyLevel);
    set(RosterAttrId.EngineerTeamEnergyUnitStock, slot.engineer.corePool);
  }
  if (slot.radar) {
    set(RosterAttrId.RadarDetectionMode, slot.radar.detectionMode);
  }

  for (const [attrId, value] of Object.entries(slot.paramOverrides ?? {})) {
    set(Number(attrId), value);
  }

  return [...attrs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attrId, value]) => ({ attrId, value }));
}

export function buildRosterSpec(match: HeadlessMatchConfig): string {
  return [...match.teams]
    .sort((a, b) => a.teamId - b.teamId)
    .flatMap((team) =>
      [...team.slots]
        .sort((a, b) => a.teamNumber - b.teamNumber)
        .map((slot) => {
          const attrs = slotAttrPairs(slot);
          const fields = [
            String(team.teamId),
            String(slot.teamNumber),
            String(slot.entityType || 0),
          ];
          if (attrs.length > 0) {
            fields.push(attrs.map((attr) => `${attr.attrId}=${attr.value}`).join('|'));
          }
          return fields.join(',');
        }),
    )
    .join(';');
}

function defaultEntityTypeForSlot(
  teamId: number,
  ruleSet: RuleSet,
  slot: { teamNumber: number; careerId: CareerId; entityType: number },
): number {
  if (ruleSet !== RuleSet.RMUC2026 || teamId !== ROSTER_TEAM_BLUE) return slot.entityType;
  if (slot.careerId === CareerId.Hero) return 66000017;
  if (slot.careerId === CareerId.Sentry) return 66000012;
  return slot.entityType;
}

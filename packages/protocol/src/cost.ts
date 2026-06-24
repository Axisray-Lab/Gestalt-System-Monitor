/**
 * R&D 费 (cost) model — a MONITOR-SIDE visualization metric only. It compares the
 * two teams' build "strength" and is never sent into / read by the game.
 *
 * Raw 费 are summed directly (no 0-100 normalization — it breaks on small maps).
 * Per-construct accuracy (命中率) cost is Monte-Carlo-derived, so it is encoded
 * here as catalog data (GUN_HIT_COST) rather than recomputed in TS.
 */
import { CareerId, type RosterSlotConfig, type TeamConfig } from './team';

export type BuildTier = 0 | 5;

export interface ConstructMeta {
  name: string; // in-game display name
  career: CareerId;
  buildTier: BuildTier; // 0 = standard 4-wheel; 5 = tunnel / stair-climb / aerial
}

/** entity_config_id → construct metadata. */
export const ENTITY_CATALOG: Record<number, ConstructMeta> = {
  66000001: { name: 'ASSEMBLY', career: CareerId.Hero, buildTier: 0 },
  66000017: { name: 'LUIGI', career: CareerId.Hero, buildTier: 5 }, // tunnel
  66000003: { name: 'MOON-ROVER', career: CareerId.Hero, buildTier: 5 }, // stair/lift
  66000014: { name: 'ENGINEER-X', career: CareerId.Engineer, buildTier: 0 },
  66000007: { name: 'HACHISEN', career: CareerId.Infantry, buildTier: 0 },
  66000009: { name: 'HACHILLES', career: CareerId.Infantry, buildTier: 0 },
  66000002: { name: 'ACHILLES', career: CareerId.Infantry, buildTier: 5 }, // stair
  66000008: { name: 'MARIO', career: CareerId.Infantry, buildTier: 5 }, // tunnel
  66000005: { name: 'HACHISEN', career: CareerId.Sentry, buildTier: 0 },
  66000010: { name: 'HACHILLES', career: CareerId.Sentry, buildTier: 0 },
  66000011: { name: 'ACHILLES', career: CareerId.Sentry, buildTier: 5 }, // stair
  66000012: { name: 'MARIO', career: CareerId.Sentry, buildTier: 5 }, // tunnel
  66000013: { name: 'DRONE', career: CareerId.Aerial, buildTier: 5 },
  66000015: { name: 'RADAR', career: CareerId.Radar, buildTier: 0 },
  66000016: { name: 'DART', career: CareerId.Dart, buildTier: 0 },
};

export const constructsForCareer = (careerId: number): Array<{ entityType: number } & ConstructMeta> =>
  Object.entries(ENTITY_CATALOG)
    .filter(([, m]) => m.career === careerId)
    .map(([id, m]) => ({ entityType: Number(id), ...m }));

/** Per-construct accuracy (命中率) cost; undefined → 0 (gunless / not yet measured). */
export const GUN_HIT_COST: Record<number, number> = {
  66000001: 5, // ASSEMBLY — long-range precision (hand-set)
  66000017: 0.75, // LUIGI
  66000002: 1.33, 66000008: 1.33, 66000007: 1.33, 66000009: 1.33, // 17mm infantry
  66000005: 1.33, 66000010: 1.33, 66000011: 1.33, 66000012: 1.33, // 17mm sentry
  66000013: 1.33, // DRONE 17mm gun
};

/** Cost-axis formulas (zero-floor: weakest setting = 0 费). */
export const COST = {
  buildTier: (entityType: number): number => ENTITY_CATALOG[entityType]?.buildTier ?? 0,
  discharge: (powerW: number): number => Math.max(0, powerW / 60), // 0W=0, 120W=2
  ammo17: (real: number): number => Math.max(0, (real - 500) / 500), // 500=0, 1000=1
  ammo42: (real: number): number => Math.max(0, (real - 50) / 50), // 50=0, 100=1
  fireRate: (hz: number): number => Math.max(0, (hz - 10) / 5), // 10Hz=0, 25Hz=3
  fireRateFromIntervalMs: (ms: number): number => COST.fireRate(1000 / ms),
  gunHit: (entityType: number): number => GUN_HIT_COST[entityType] ?? 0,
  dart: (d?: { canOutpost: boolean; canBase: boolean; maxBaseMode: number }): number => {
    if (!d) return 0;
    let c = 0;
    if (d.canOutpost) c += 3;
    if (d.canBase) c += 5 + ([0, 1, 3, 5][d.maxBaseMode] ?? 0);
    return c;
  },
  dartHit: 6, // direct-fire, 10×10 plate, R100 ≈ 15 m
  engineerAssembly: (maxLevel: number): number => [0, 0, 1, 3, 5][maxLevel] ?? 0, // L1..L4 = 0/1/3/5
  engineerPool: (cores: number): number => ({ 2: 0, 4: 1, 6: 2 } as Record<number, number>)[cores] ?? 0,
  radar: (r?: { maxLockRangeM: number; detectionMode: number }): number => {
    if (!r) return 0;
    const lock = r.maxLockRangeM <= 0 ? 0 : r.maxLockRangeM <= 18 ? r.maxLockRangeM / 18 : 1 + (r.maxLockRangeM - 18) / 5;
    const detect = [0, 1, 3][r.detectionMode] ?? 0;
    return lock + detect + 2; // + flat hitscan accuracy
  },
} as const;

/** Per-construct DEFAULT slot cost (no overrides), so the UI shows a real baseline. */
export const SLOT_DEFAULT_COST: Record<number, number> = {
  66000001: 8.7, // ASSEMBLY
  66000017: 11.35, // LUIGI
  66000002: 12.33, 66000008: 12.33, 66000005: 7.33, 66000012: 12.33,
  66000013: 12.33, // DRONE platform (gun only; dart added separately)
  66000014: 7.0, // ENGINEER default economy (max-level L4 + 6-core pool)
};

/** Drone dart system default = capability 13 (both targets + max base mode) + hit 6. */
export const DRONE_DART_DEFAULT_COST = 13 + COST.dartHit; // 19

export function computeSlotCost(slot: RosterSlotConfig): number {
  const base = SLOT_DEFAULT_COST[slot.entityType];
  if (slot.paramOverrides == null && slot.dart == null && slot.engineer == null && slot.radar == null && base != null) {
    return base;
  }
  let cost = COST.buildTier(slot.entityType) + COST.gunHit(slot.entityType);
  if (slot.dart) cost += COST.dart(slot.dart) + COST.dartHit;
  if (slot.engineer) cost += COST.engineerAssembly(slot.engineer.maxAssemblyLevel) + COST.engineerPool(slot.engineer.corePool);
  if (slot.radar) cost += COST.radar(slot.radar);
  // TODO: add 放电/弹药/射频 deltas from slot.paramOverrides vs construct defaults.
  return cost;
}

export const computeTeamCost = (team: TeamConfig): number =>
  team.slots.reduce((sum, s) => sum + computeSlotCost(s), 0);

/** Self-check anchors: a default RMUC2026 roster ≈ ranged 79.0 / melee 86.7. */
export const RMUC2026_SAMPLE = { rangedTeamCost: 79.0, meleeTeamCost: 86.7 } as const;

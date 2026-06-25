/**
 * R&D 费 (cost) model — a MONITOR-SIDE visualization metric only. It compares the
 * two teams' build strength and is never sent into / read by the game.
 *
 * Raw 费 are summed directly (no 0-100 normalization). Per-construct accuracy
 * (命中率) cost is Monte-Carlo-derived (velocity jitter dominates for slow 42mm,
 * so a geometric formula is not reliable) — encoded here as GUN_HIT_COST data.
 */
import { CareerId, type RosterSlotConfig, type SlotTuning, type TeamConfig } from '@gsm/protocol';

export type BuildTier = 0 | 5;

export interface ConstructMeta {
  name: string; // in-game display name
  career: CareerId;
  buildTier: BuildTier; // 0 = standard 4-wheel; 5 = tunnel / stair-climb / aerial
  bulletRadiusCm: number; // projectile collision radius (for the spread estimator)
}

/** entity_config_id → construct metadata. */
export const ENTITY_CATALOG: Record<number, ConstructMeta> = {
  66000001: { name: 'ASSEMBLY', career: CareerId.Hero, buildTier: 0, bulletRadiusCm: 2.1 },
  66000017: { name: 'LUIGI', career: CareerId.Hero, buildTier: 5, bulletRadiusCm: 2.1 },
  66000003: { name: 'MOON-ROVER', career: CareerId.Hero, buildTier: 5, bulletRadiusCm: 2.1 },
  66000014: { name: 'ENGINEER-X', career: CareerId.Engineer, buildTier: 0, bulletRadiusCm: 0 },
  66000007: { name: 'HACHISEN', career: CareerId.Infantry, buildTier: 0, bulletRadiusCm: 0.65 },
  66000009: { name: 'HACHILLES', career: CareerId.Infantry, buildTier: 0, bulletRadiusCm: 0.65 },
  66000002: { name: 'ACHILLES', career: CareerId.Infantry, buildTier: 5, bulletRadiusCm: 0.65 },
  66000008: { name: 'MARIO', career: CareerId.Infantry, buildTier: 5, bulletRadiusCm: 0.65 },
  66000005: { name: 'HACHISEN', career: CareerId.Sentry, buildTier: 0, bulletRadiusCm: 0.65 },
  66000010: { name: 'HACHILLES', career: CareerId.Sentry, buildTier: 0, bulletRadiusCm: 0.65 },
  66000011: { name: 'ACHILLES', career: CareerId.Sentry, buildTier: 5, bulletRadiusCm: 0.65 },
  66000012: { name: 'MARIO', career: CareerId.Sentry, buildTier: 5, bulletRadiusCm: 0.65 },
  66000013: { name: 'DRONE', career: CareerId.Aerial, buildTier: 5, bulletRadiusCm: 0.65 },
  66000015: { name: 'RADAR', career: CareerId.Radar, buildTier: 0, bulletRadiusCm: 0.1 },
  66000016: { name: 'DART', career: CareerId.Dart, buildTier: 0, bulletRadiusCm: 2.1 },
};

export const constructsForCareer = (careerId: number): Array<{ entityType: number } & ConstructMeta> =>
  Object.entries(ENTITY_CATALOG)
    .filter(([, m]) => m.career === careerId)
    .map(([id, m]) => ({ entityType: Number(id), ...m }));

/** Per-construct accuracy (命中率) cost — MC-derived; undefined → 0 (gunless / TBD). */
export const GUN_HIT_COST: Record<number, number> = {
  66000001: 5, // ASSEMBLY — long-range precision (hand-set, off the normal scale)
  66000017: 0.75, // LUIGI
  66000002: 1.33, 66000008: 1.33, 66000007: 1.33, 66000009: 1.33, // 17mm infantry
  66000005: 1.33, 66000010: 1.33, 66000011: 1.33, 66000012: 1.33, // 17mm sentry
  66000013: 1.33, // DRONE 17mm gun
};

/** Cost-axis formulas (zero-floor: weakest setting = 0 费). */
export const COST = {
  buildTier: (entityType: number): number => ENTITY_CATALOG[entityType]?.buildTier ?? 0,
  discharge: (powerW: number): number => Math.max(0, powerW / 60), // 0W=0, 120W=2
  ammo17: (rounds: number): number => Math.max(0, (rounds - 500) / 500), // 500=0, 1000=1
  ammo42: (rounds: number): number => Math.max(0, (rounds - 50) / 50), // 50=0, 100=1
  fireRate: (hz: number): number => Math.max(0, (hz - 10) / 5), // 10Hz=0, 25Hz=3
  gunHit: (entityType: number): number => GUN_HIT_COST[entityType] ?? 0,
  dart: (d?: SlotTuning['dart']): number => {
    if (!d) return 0;
    let c = 0;
    if (d.canOutpost) c += 3;
    if (d.canBase) c += 5 + ([0, 1, 3, 5][d.maxBaseMode] ?? 0);
    return c;
  },
  dartHit: 6, // direct-fire, 10×10 plate, R100 ≈ 15 m
  engineerAssembly: (maxLevel: number): number => [0, 0, 1, 3, 5][maxLevel] ?? 0, // L1..L4 = 0/1/3/5
  engineerPool: (cores: number): number => ({ 2: 0, 4: 1, 6: 2 } as Record<number, number>)[cores] ?? 0,
  radar: (r?: SlotTuning['radar']): number => {
    if (!r) return 0;
    const lock = r.maxLockRangeM <= 0 ? 0 : r.maxLockRangeM <= 18 ? r.maxLockRangeM / 18 : 1 + (r.maxLockRangeM - 18) / 5;
    return lock + ([0, 1, 3][r.detectionMode] ?? 0) + 2; // + flat hitscan accuracy
  },
} as const;

// —— Per-construct default tuning (via shared models; T0 values) ——
const M_17MM: SlotTuning = { discharge: 120, ammo17: 1000, fireRateHz: 25, spreadMax: 10, spreadMin: 5, speedSpread: 30 };
const M_ASSEMBLY: SlotTuning = { discharge: 0, ammo42: 85, fireRateHz: 25, spreadMax: 5, spreadMin: 3, speedSpread: 10 };
const M_LUIGI: SlotTuning = { discharge: 120, ammo42: 80, fireRateHz: 25, spreadMax: 10, spreadMin: 5, speedSpread: 30 };
const M_MOONROVER: SlotTuning = { discharge: 120, ammo42: 100, fireRateHz: 25, spreadMax: 5, spreadMin: 3, speedSpread: 30 };
const DART_DEFAULT = { canOutpost: true, canBase: true, maxBaseMode: 3 } as const; // max-reachable (13 费)

/** entity_config_id → default SlotTuning (the construct's T0). */
export const CONSTRUCT_DEFAULTS: Record<number, SlotTuning> = {
  66000001: M_ASSEMBLY,
  66000017: M_LUIGI,
  66000003: M_MOONROVER,
  66000014: { engineer: { maxAssemblyLevel: 4, corePool: 6 } },
  66000007: M_17MM, 66000009: M_17MM, 66000002: M_17MM, 66000008: M_17MM,
  66000005: M_17MM, 66000010: M_17MM, 66000011: M_17MM, 66000012: M_17MM,
  66000013: { ...M_17MM, dart: { ...DART_DEFAULT } },
  66000015: { radar: { maxLockRangeM: 18, detectionMode: 1 } },
  66000016: { dart: { ...DART_DEFAULT } },
};

/** The construct default merged with the slot's sparse overrides. */
export const effectiveTuning = (slot: RosterSlotConfig): SlotTuning => ({
  ...(CONSTRUCT_DEFAULTS[slot.entityType] ?? {}),
  ...(slot.tuning ?? {}),
});

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeSlotCost(slot: RosterSlotConfig): number {
  const t = effectiveTuning(slot);
  let cost = COST.buildTier(slot.entityType) + COST.gunHit(slot.entityType);
  if (t.discharge != null) cost += COST.discharge(t.discharge);
  if (t.ammo17 != null) cost += COST.ammo17(t.ammo17);
  if (t.ammo42 != null) cost += COST.ammo42(t.ammo42);
  if (t.fireRateHz != null) cost += COST.fireRate(t.fireRateHz);
  if (t.dart) cost += COST.dart(t.dart) + COST.dartHit;
  if (t.engineer) cost += COST.engineerAssembly(t.engineer.maxAssemblyLevel) + COST.engineerPool(t.engineer.corePool);
  if (t.radar) cost += COST.radar(t.radar);
  // NOTE: spread/speedSpread don't move 命中率 cost live (it's MC-derived per
  // construct); GUN_HIT_COST is used. estimateGunHitCost() is an approximate helper.
  return round2(cost);
}

export const computeTeamCost = (team: TeamConfig): number =>
  round2(team.slots.reduce((sum, s) => sum + computeSlotCost(s), 0));

/** Approximate 命中率 cost from a spread cone (geometric, ignores velocity jitter —
 *  good for 17mm, OVERSHOOTS slow 42mm). For live UI hints only; not authoritative. */
export const estimateGunHitCost = (maxEnclosingCm: number, bulletRadiusCm: number): number => {
  if (maxEnclosingCm <= 0) return 0;
  const r100m = ((5 + bulletRadiusCm) * 10) / maxEnclosingCm; // TargetDistance = 1000 cm
  return Math.max(0, round2((r100m - 3) / 2));
};

/** Self-check anchors: an example RMUC2026 roster ≈ ranged 79.0 / melee 86.7. */
export const RMUC2026_SAMPLE = { rangedTeamCost: 79.0, meleeTeamCost: 86.7 } as const;

import {
  AttrId,
  type AttributeMapUpdate,
  type WatchAttributeMapsResult,
  type Vec3,
  type VehicleState,
  type WorldSnapshot,
} from '@gsm/protocol';

/**
 * Per-attribute-map store + projection into the renderer's `WorldSnapshot`.
 *
 * Mirrors the public `watchAttributeMaps.result` handling: plain JSON, with full
 * (`sync_type 0`) vs incremental (`sync_type 1`) updates. Each "vehicle" is one
 * attribute map that carries a `PlayerID`/`Health`.
 *
 * If world position + heading are absent, units are laid out in a deterministic
 * placeholder grid so the parse chain + per-unit panels remain testable.
 *
 * The mock feed and the live WS feed both drive THIS store, so the mock exercises
 * the exact same parse path as the real game.
 */

const TEAM_NAME: Record<number, string> = { 0: 'red', 1: 'blue' };

const CLASS_ID = {
  Hero: 1001,
  Engineer: 1002,
  Infantry: 1003,
  Sentry: 1004,
  Aerial: 1005,
  Radar: 1006,
  Dart: 1007,
  Building: 2000,
  Base: 2001,
  Outpost: 2002,
} as const;

const ROBOT_CLASSES = new Set<number>([
  CLASS_ID.Hero,
  CLASS_ID.Engineer,
  CLASS_ID.Infantry,
  CLASS_ID.Sentry,
  CLASS_ID.Aerial,
  CLASS_ID.Dart,
]);

const CAREER_NAME: Record<number, string> = {
  [CLASS_ID.Hero]: 'Hero',
  [CLASS_ID.Engineer]: 'Engineer',
  [CLASS_ID.Infantry]: 'Infantry',
  [CLASS_ID.Sentry]: 'Sentry',
  [CLASS_ID.Aerial]: 'Aerial',
  [CLASS_ID.Radar]: 'Radar',
  [CLASS_ID.Dart]: 'Dart',
};

const ROBOT_MAP_TTL_MS = 3500;

type UnitKind = NonNullable<VehicleState['kind']>;

interface RegisteredIds {
  robots: Set<number>;
  bases: Set<number>;
  outposts: Set<number>;
  runes: Set<number>;
  hidden: Set<number>;
}

const RMUC2026_FALLBACK_POS: Record<'red' | 'blue', Record<'base' | 'outpost', Vec3>> = {
  // RMUC2026 landmark origins in UE centimetres; used until live position attrs arrive.
  red: {
    base: { x: 8, y: -1130, z: 4 },
    outpost: { x: -381, y: -283, z: 20 },
  },
  blue: {
    base: { x: 7, y: 1185, z: 4 },
    outpost: { x: 393, y: 333, z: 20 },
  },
};

const RMUC2026_FALLBACK_YAW: Record<'red' | 'blue', Record<'base' | 'outpost', number>> = {
  red: { base: 90, outpost: -90 },
  blue: { base: -90, outpost: 90 },
};

const RMUC2026_DART_STATION_POS: Record<'red' | 'blue', Vec3> = {
  red: { x: 330, y: -1290, z: 2 },
  blue: { x: -320, y: 1370, z: 2 },
};

const RMUC2026_DART_STATION_YAW: Record<'red' | 'blue', number> = {
  red: 90,
  blue: -90,
};

const RUNE_FALLBACK_POS: Vec3 = { x: 0, y: 0, z: 90 };

/**
 * Buff pips, mirroring the spectator panel's curated slots (fixed order):
 * base buffs/debuffs plus sentry-only mode/boost keys emitted below.
 */
// Generic (rune / zone / terrain) buffs, read from VALUE positions (a multiplier
// or value > 0), NOT flags. Each gain can have several source attributes; duplicate
// keys collapse to one pip. The SENTRY's own mode gains are deliberately NOT here:
// its gain-type slots carry an always-on base (damage ≈ 250) plus the boosted mode
// gain, so they need boost-thresholded single-gain selection (see `sentryGain`),
// which a plain v>0 test would get wrong (it would light every slot every mode).
const BUFF_DEFS: { key: string; id: AttrId; on: (v: number) => boolean }[] = [
  { key: 'inv', id: AttrId.Invincible, on: (v) => v === 1 },
  { key: 'heat', id: AttrId.Overheated, on: (v) => v === 1 },
  { key: 'def', id: AttrId.DefenseMultiplierThou, on: (v) => v > 0 },
  { key: 'atk', id: AttrId.AttackMultiplierThou, on: (v) => v > 0 },
  { key: 'heal', id: AttrId.RecoverMultiplierThou, on: (v) => v > 0 },
  { key: 'power', id: AttrId.PowerMultiplierThou, on: (v) => v > 0 }, // 功率增益
  // 冷却增益 — rune(神符) / fortress(碉堡) / terrain-crossing(过洞). Sentry cooling
  // is a mode gain, handled in `sentryGain`, not here.
  { key: 'cool', id: AttrId.ColdMultiplierThou, on: (v) => v > 0 },
  { key: 'cool', id: AttrId.FortressCoolingValue, on: (v) => v > 0 },
  { key: 'cool', id: AttrId.TerrainCrossingColdMultiplierThou, on: (v) => v > 0 },
  { key: 'weak', id: AttrId.Weakened, on: (v) => v === 1 }, // 虚弱
  { key: 'blind', id: AttrId.Blocked, on: (v) => v === 1 }, // 致盲/受阻
  // 易伤 — DamageMultiplierThou is a DEBUFF (damage TAKEN multiplier), not a gain;
  // fires independently of AttackMultiplierThou on Hero/Infantry/Sentry.
  { key: 'vuln', id: AttrId.DamageMultiplierThou, on: (v) => v > 0 },
];

export class AttributeStore {
  /** attribute_map_id -> { "<attrId>": value } */
  private maps = new Map<number, Record<string, number>>();
  /** attribute_map_id -> wall-clock time of the latest wire update. */
  private mapUpdatedAt = new Map<number, number>();
  private ownHiddenMapIds = new Set<number>();
  /** Hidden player maps can hide their referenced battle map before that map updates. */
  private linkedHiddenMapIds = new Set<number>();
  private t = 0;

  applyResult(res: WatchAttributeMapsResult): void {
    const now = Date.now();
    for (const u of res?.watch_attribute_maps_results ?? []) this.applyUpdate(u, now);
    this.t++;
    // NOTE: we deliberately do NOT evict stale maps. The store is naturally bounded
    // by the broad-but-fixed low-id subscription, and stale maps are already kept
    // out of rendering by the per-map freshness check (isFreshRobotMap) in kindFor.
    // Deleting maps broke cross-match continuity: when the next match resumed with
    // INCREMENTAL (sync_type 1) updates, the evicted base state was gone, so the
    // board stayed empty until a full browser refresh re-subscribed (sync_type 0).
  }

  private applyUpdate(u: AttributeMapUpdate, now: number): void {
    this.mapUpdatedAt.set(u.attribute_map_id, now);
    const old = this.maps.get(u.attribute_map_id);
    const oldBattleMapId = old ? this.num(old, AttrId.PlayerBattleAttributeMapID) : undefined;
    let m = old;
    // sync_type 0 (or first sight) = full replace; sync_type 1 = patch.
    if (!m || u.sync_type !== 1) {
      m = {};
      this.maps.set(u.attribute_map_id, m);
    }
    // Object.assign over a for-of of Object.entries: same own-enumerable copy, but
    // no per-update pairs-array allocation — this runs ~14k×/s across all feeds, so
    // the avoided garbage is the difference between smooth and GC-stutter.
    if (u.attributes) Object.assign(m, u.attributes);

    const currentBattleMapId = this.num(m, AttrId.PlayerBattleAttributeMapID);
    const battleMapId = currentBattleMapId ?? oldBattleMapId;
    const hidden = this.num(m, AttrId.IsActorHidden);
    if (hidden === 1) {
      this.ownHiddenMapIds.add(u.attribute_map_id);
      if (battleMapId != null && battleMapId > 0) {
        this.linkedHiddenMapIds.add(Math.round(battleMapId));
      }
    } else {
      if (hidden === 0 || u.sync_type !== 1) this.ownHiddenMapIds.delete(u.attribute_map_id);
      if (battleMapId != null && battleMapId > 0) {
        this.linkedHiddenMapIds.delete(Math.round(battleMapId));
      }
    }
  }

  private num(m: Record<string, number>, id: AttrId): number | undefined {
    const v = m[String(id)];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  private unitRatio(v: number | undefined): number | undefined {
    if (v == null) return undefined;
    if (v >= 0 && v <= 1) return clamp01(v);
    if (v > 1 && v <= 100) return clamp01(v / 100);
    if (v > 100 && v <= 1000) return clamp01(v / 1000);
    return undefined;
  }

  private outpostRepairProgress(
    m: Record<string, number>,
    health: number | undefined,
    defeated: boolean | undefined
  ): number | undefined {
    if (defeated !== true) return undefined;
    const progress = this.num(m, AttrId.ReviveProgress);
    const progressMax = this.num(m, AttrId.ReviveProgressMax);
    if (progress != null && progressMax != null && progressMax > 0) {
      return clamp01(progress / progressMax);
    }
    return this.unitRatio(this.num(m, AttrId.HP_Progress)) ?? health;
  }

  /**
   * Single allocation-free pass over one map's keys, routing base/outpost/rune id
   * VALUES into the given sets and reporting whether the map carries ANY
   * structure-range KEY (value-agnostic — matches the old hasRegisteredStructureIds).
   * Replaces three `Object.entries` sweeps per map (the dominant per-message cost
   * when a live match streams hundreds of maps).
   */
  private collectStructureIds(
    m: Record<string, number>,
    bases: Set<number>,
    outposts: Set<number>,
    runes: Set<number>
  ): boolean {
    let hasStructureKey = false;
    for (const k in m) {
      const attr = Number(k);
      const v = m[k];
      const ok = typeof v === 'number' && Number.isFinite(v) && v > 0;
      if (attr >= AttrId.G_BaseId_0 && attr <= AttrId.G_BaseId_MAX) {
        hasStructureKey = true;
        if (ok) bases.add(Math.round(v));
      }
      if (attr >= AttrId.G_OutpostId_0 && attr <= AttrId.G_OutpostId_MAX) {
        hasStructureKey = true;
        if (ok) outposts.add(Math.round(v));
      }
      if (attr >= AttrId.G_BuffStationId_0 && attr <= AttrId.G_BuffStationId_MAX) {
        hasStructureKey = true;
        if (ok) runes.add(Math.round(v));
      }
    }
    return hasStructureKey;
  }

  private registeredIds(): RegisteredIds {
    const ids: RegisteredIds = {
      robots: new Set(),
      bases: new Set(),
      outposts: new Set(),
      runes: new Set(),
      hidden: new Set([...this.ownHiddenMapIds, ...this.linkedHiddenMapIds]),
    };
    for (const [mapId, m] of this.maps) {
      const battleMapId = this.num(m, AttrId.PlayerBattleAttributeMapID);
      const hidden = this.num(m, AttrId.IsActorHidden) === 1;
      if (hidden) {
        ids.hidden.add(mapId);
        if (battleMapId != null && battleMapId > 0) ids.hidden.add(Math.round(battleMapId));
      }
      if (!hidden && battleMapId != null && battleMapId > 0) ids.robots.add(Math.round(battleMapId));
      this.collectStructureIds(m, ids.bases, ids.outposts, ids.runes);
    }
    return ids;
  }

  /**
   * Attribute maps reference other attribute maps. The live feed starts with a
   * broad low-id watch, then uses these discovered ids to subscribe to player
   * maps and their current battle maps. This keeps a browser refresh from
   * getting stuck with only the already-visible structures.
   */
  referencedMapIds(): Set<number> {
    const ids = new Set<number>();
    for (const m of this.maps.values()) {
      const battleMapId = this.num(m, AttrId.PlayerBattleAttributeMapID);
      if (battleMapId != null && battleMapId > 0) ids.add(Math.round(battleMapId));

      // base/outpost/rune ids all go into the one referenced-id set; the return
      // gates harvesting referenced PlayerIDs (only on maps that carry structures).
      const hasStructureKey = this.collectStructureIds(m, ids, ids, ids);
      if (!hasStructureKey) continue;
      for (const k in m) {
        const attr = Number(k);
        if (attr <= AttrId.PlayerID_0 || attr >= AttrId.PlayerID_MAX) continue;
        const v = m[k];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) ids.add(Math.round(v));
      }
    }
    return ids;
  }

  private hasRobotIdentity(m: Record<string, number>): boolean {
    const pid = this.num(m, AttrId.PlayerID);
    if (pid != null && pid > AttrId.PlayerID_0 && pid < AttrId.PlayerID_MAX) return true;
    const classId = this.num(m, AttrId.Class);
    if (classId != null && ROBOT_CLASSES.has(classId)) return true;
    const teamNumber = this.num(m, AttrId.TeamNumber);
    return (
      this.num(m, AttrId.Health) != null &&
      this.num(m, AttrId.TeamID) != null &&
      teamNumber != null &&
      teamNumber >= 1 &&
      teamNumber <= 7
    );
  }

  private hasRuneIdentity(m: Record<string, number>): boolean {
    return this.num(m, AttrId.BS_State) != null || this.num(m, AttrId.BS_CurOmega) != null;
  }

  private hasRenderableRobotTeam(m: Record<string, number>): boolean {
    const teamId = this.num(m, AttrId.TeamID);
    return teamId === 0 || teamId === 1;
  }

  private isFreshRobotMap(mapId: number, now: number): boolean {
    const updatedAt = this.mapUpdatedAt.get(mapId);
    return updatedAt != null && now - updatedAt <= ROBOT_MAP_TTL_MS;
  }

  private kindFor(
    mapId: number,
    m: Record<string, number>,
    ids: RegisteredIds,
    now: number
  ): UnitKind | null {
    if (ids.hidden.has(mapId)) return null;
    if (this.num(m, AttrId.IsActorHidden) === 1) return null;

    const classId = this.num(m, AttrId.Class);

    if (ids.bases.has(mapId) || classId === CLASS_ID.Base) return 'base';
    if (ids.outposts.has(mapId) || classId === CLASS_ID.Outpost) return 'outpost';
    if (ids.runes.has(mapId) || (classId === CLASS_ID.Building && this.hasRuneIdentity(m))) {
      return 'rune';
    }

    if (ids.robots.size > 0) {
      // Dart maps are public low-id class maps (often PlayerID=-1) and may not be
      // referenced through PlayerBattleAttributeMapID, but their ammo drives dart
      // launch visuals.
      if (classId === CLASS_ID.Dart) {
        return this.hasRenderableRobotTeam(m) && this.isFreshRobotMap(mapId, now) ? 'robot' : null;
      }
      if (!ids.robots.has(mapId)) return null;
      if (!this.isFreshRobotMap(mapId, now)) return null;
      if (classId != null && !ROBOT_CLASSES.has(classId)) return null;
      return this.hasRenderableRobotTeam(m) ? 'robot' : null;
    }

    if (classId != null) {
      if (!this.isFreshRobotMap(mapId, now)) return null;
      return ROBOT_CLASSES.has(classId) && this.hasRenderableRobotTeam(m) ? 'robot' : null;
    }
    return this.hasRobotIdentity(m) && this.isFreshRobotMap(mapId, now) ? 'robot' : null;
  }

  private fallbackPos(kind: UnitKind, teamId: number | undefined, classId?: number): Vec3 | null {
    if (kind === 'rune') return RUNE_FALLBACK_POS;
    const side = teamId === 0 ? 'red' : teamId === 1 ? 'blue' : null;
    if (side && classId === CLASS_ID.Dart) return RMUC2026_DART_STATION_POS[side];
    if (!side || (kind !== 'base' && kind !== 'outpost')) return null;
    return RMUC2026_FALLBACK_POS[side][kind];
  }

  private fallbackYaw(kind: UnitKind, teamId: number | undefined, classId?: number): number | undefined {
    const side = teamId === 0 ? 'red' : teamId === 1 ? 'blue' : null;
    if (side && classId === CLASS_ID.Dart) return RMUC2026_DART_STATION_YAW[side];
    if (!side || (kind !== 'base' && kind !== 'outpost')) return undefined;
    return RMUC2026_FALLBACK_YAW[side][kind];
  }

  private resolvePos(
    m: Record<string, number>,
    kind: UnitKind,
    teamId: number | undefined,
    classId: number | undefined,
    i: number,
    n: number
  ): Vec3 {
    const fallback = this.fallbackPos(kind, teamId, classId);
    if (classId === CLASS_ID.Dart && fallback) return fallback;
    const px = this.num(m, AttrId.WorldPosX);
    const py = this.num(m, AttrId.WorldPosY);
    const pz = this.num(m, AttrId.WorldPosZ);
    if (px != null && py != null) return { x: px, y: py, z: pz ?? 60 };
    return fallback ?? this.layoutPos(i, n);
  }

  private displayName(kind: UnitKind, id: number, classId?: number): string {
    if (kind === 'base') return 'Base';
    if (kind === 'outpost') return 'Outpost';
    if (kind === 'rune') return 'RUNE';
    if (kind === 'building') return 'Building';
    if (classId && CAREER_NAME[classId]) return CAREER_NAME[classId];
    return `Car ${id}`;
  }

  private snapshotId(mapId: number, m: Record<string, number>, kind: UnitKind): number {
    const pid = this.num(m, AttrId.PlayerID);
    return kind === 'robot' && pid != null && pid > AttrId.PlayerID_0 ? pid : mapId;
  }

  /**
   * The sentry's single mode gain, read from its VALUE positions. The sentry has
   * exactly THREE modes — Defense / Cooling / Movement — and each drives ONE gain
   * slot positive. There is NO attack mode: the damage slot
   * (SentryDamageMultiplierThou) is an always-on ~250 base, NOT a gain, so it is
   * ignored here. The gain magnitudes differ by mode — defense runs small (~250–990,
   * enhanced ≈990), cooling large (~1000, enhanced ≈1e6) — so each slot is tested
   * for "on" (>0) rather than a shared threshold (a threshold tuned for cooling
   * would miss the whole defense mode). Movement shows as the power coefficient
   * going POSITIVE; that same slot is negative (a debuff) in the other two modes.
   * Verified against 67 recordings: these slots never co-occur except for stray
   * single-frame transitions, where reading the value (not the lagging mode number)
   * is still the right call. Returns the pip key, or null while the sentry is down.
   */
  private sentryGain(m: Record<string, number>): 'def' | 'cool' | 'power' | null {
    if ((this.num(m, AttrId.SentryColdMultiplierThou) ?? 0) > 0) return 'cool';
    if ((this.num(m, AttrId.SentryDefenseMultiplierThou) ?? 0) > 0) return 'def';
    if ((this.num(m, AttrId.SentryPowerCoefficientThou) ?? 0) > 0) return 'power';
    return null;
  }

  toSnapshot(): WorldSnapshot {
    // Collect first so the placeholder layout can fit ALL pieces inside the board
    // (the grid dims + spacing derive from the count — see layoutPos).
    const now = Date.now();
    const registered = this.registeredIds();
    const maps = [...this.maps]
      .map(([mapId, m]) => ({ mapId, m, kind: this.kindFor(mapId, m, registered, now) }))
      .filter((e): e is { mapId: number; m: Record<string, number>; kind: UnitKind } => e.kind != null);
    const outpostRebuildCountsByTeam = new Map<number, number>();
    for (const { m, kind } of maps) {
      if (kind !== 'base') continue;
      const teamId = this.num(m, AttrId.TeamID);
      const rebuildCount = this.num(m, AttrId.TM_OutPostRebuildCount);
      const hp = this.num(m, AttrId.Health);
      const hpMax = this.num(m, AttrId.HealthMax);
      if (teamId != null) {
        const baseDamaged = hp != null && hpMax != null && hpMax > 0 && hp < hpMax;
        outpostRebuildCountsByTeam.set(
          Math.round(teamId),
          baseDamaged && rebuildCount != null && rebuildCount >= 0 ? rebuildCount : 0
        );
      }
    }
    const n = maps.length;
    const vehicles: VehicleState[] = maps.map(({ mapId, m, kind }, i) => {
      const id = this.snapshotId(mapId, m, kind);
      const classId = this.num(m, AttrId.Class);
      const teamId = this.num(m, AttrId.TeamID);
      const team = kind !== 'rune' && teamId != null ? (TEAM_NAME[teamId] ?? teamId) : undefined;

      const hp = this.num(m, AttrId.Health);
      const hpMax = this.num(m, AttrId.HealthMax);
      const defeatedAttr = this.num(m, AttrId.Defeated);
      const healthRatio = this.unitRatio(this.num(m, AttrId.HP_Progress));
      const health =
        hp != null && hpMax != null && hpMax > 0
          ? clamp01(hp / hpMax)
          : hp != null
            ? clamp01(hp / 1000) // fallback scale until HealthMax is present
            : healthRatio;
      const defeated =
        defeatedAttr != null
          ? defeatedAttr > 0
          : hp != null
            ? hp <= 0
            : undefined;

      const teamNumber = this.num(m, AttrId.TeamNumber);
      const level = this.num(m, AttrId.Level);
      // Ammo = launch allowance (17mm + 42mm). Bases show team coins instead.
      const a17 = this.num(m, AttrId.Ammo17mmCount);
      const a42 = this.num(m, AttrId.Ammo42mmCount);
      const dartAmmo = this.num(m, AttrId.RealDartAmmoCount) ?? this.num(m, AttrId.AmmoDartCount);
      const coins = this.num(m, AttrId.TM_Coins);
      const ammo =
        kind === 'base' && coins != null
          ? coins
          : classId === CLASS_ID.Dart && dartAmmo != null
            ? dartAmmo
          : a17 != null || a42 != null
            ? (a17 ?? 0) + (a42 ?? 0)
            : undefined;
      const fl = this.num(m, AttrId.FiringLocked);
      const firingLocked = fl != null ? fl === 1 : undefined;
      const heatV = this.num(m, AttrId.FiringHeat1);
      const heatMax = this.num(m, AttrId.FiringHeatMax1);
      const heat =
        heatV != null && heatMax != null && heatMax > 0 ? clamp01(heatV / heatMax) : undefined;
      const rebuildCount =
        kind === 'outpost' && teamId != null
          ? outpostRebuildCountsByTeam.get(Math.round(teamId))
          : undefined;
      const reviveCount = kind === 'outpost' ? (this.num(m, AttrId.ReviveCount) ?? 0) : undefined;
      const repairCount =
        kind === 'outpost' && rebuildCount != null
          ? defeated === true
            ? Math.max(0, rebuildCount - (reviveCount ?? 0))
            : 0
          : undefined;
      const reviveProgressMax = this.num(m, AttrId.ReviveProgressMax);
      // Base 展开/deploy state = BC_State(73000001)===1 (the base controller opens up,
      // exposing its core just before it can be destroyed). NOT 10000101 (Tech_L4).
      const deployedAttr = kind === 'base' ? this.num(m, AttrId.BC_State) : undefined;
      const repairProgress =
        kind === 'outpost' ? this.outpostRepairProgress(m, health, defeated) : undefined;

      // Buffs come from VALUE positions (BUFF_DEFS); dedupe since several gains have
      // multiple source attributes (e.g. cool = rune/fortress/terrain-crossing).
      const buffs = [...new Set(BUFF_DEFS.filter((d) => d.on(this.num(m, d.id) ?? 0)).map((d) => d.key))];
      // The sentry shows exactly ONE mode gain (def/atk/cool), picked from its value
      // positions. Enhanced mode amplifies only THAT gain, so we tag it `enh:<key>`
      // and let the panel glow just that one pip (not every active buff).
      if (classId === CLASS_ID.Sentry) {
        const gain = this.sentryGain(m);
        if (gain) {
          if (!buffs.includes(gain)) buffs.push(gain);
          if (this.num(m, AttrId.SentryModeEnhanced) === 1) buffs.push(`enh:${gain}`);
        }
      }

      const pos = this.resolvePos(m, kind, teamId, classId, i, n);
      const yaw = this.num(m, AttrId.ChassisYaw) ?? this.fallbackYaw(kind, teamId, classId);
      const turretYaw = this.num(m, AttrId.TurretYaw);
      const turretPitch = this.num(m, AttrId.TurretPitch);
      const deploymentMode =
        classId === CLASS_ID.Hero ? this.num(m, AttrId.IsInDeploymentMode) : undefined;

      return {
        id,
        attributeMapId: mapId,
        kind,
        classId,
        name: this.displayName(kind, id, classId),
        team,
        teamNumber: teamNumber != null && teamNumber >= 0 ? teamNumber : undefined,
        pos,
        yaw,
        turretYaw: turretYaw ?? yaw,
        turretPitch,
        health,
        hp: hp != null ? Math.round(hp) : undefined,
        hpMax: hpMax != null ? Math.round(hpMax) : undefined,
        defeated,
        deployed:
          deploymentMode != null
            ? deploymentMode > 0
            : deployedAttr != null
              ? deployedAttr === 1
              : undefined,
        repairProgress,
        repairCount:
          repairCount != null && repairCount >= 0 ? Math.round(repairCount) : undefined,
        respawnTotalMs:
          kind === 'outpost' && reviveProgressMax != null && reviveProgressMax > 0
            ? Math.round(reviveProgressMax * (reviveProgressMax < 1000 ? 1000 : 1))
            : undefined,
        buffs: buffs.length ? buffs : undefined,
        level: level != null && level > 0 ? level : undefined,
        ammo,
        ammo17: a17,
        ammo42: a42,
        dartAmmo,
        dartHitCount:
          kind === 'base' ? this.num(m, AttrId.TM_BaseDamageCount) : undefined,
        firingLocked,
        heat,
        score: this.num(m, AttrId.DamageAppliedTotal) ?? 0,
        damageTaken: this.num(m, AttrId.DamageTakenTotal) ?? 0,
      };
    });
    return { t: this.t, vehicles };
  }

  /**
   * Placeholder layout (UE cm, Z-up) until real position attrs exist. Packs `n`
   * pieces into a grid sized to the count, with half-cell inset, so they ALWAYS
   * stay inside the board footprint no matter how many appear/disappear (no more
   * runaway row marching off the field).
   */
  private layoutPos(i: number, n: number): Vec3 {
    const RX = 700; // half-extents inside the arena (cm); field long axis is Y
    const RY = 1200;
    const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n) * (RX / RY))));
    const rows = Math.max(1, Math.ceil(n / cols));
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      x: -RX + (2 * RX * (c + 0.5)) / cols,
      y: RY - (2 * RY * (r + 0.5)) / rows,
      z: 60,
    };
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

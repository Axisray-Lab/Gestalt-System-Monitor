import {
  AttrId,
  type MapWireframe,
  type Vec3,
  type WatchAttributeMapsResult,
  type WorldSnapshot,
} from '@gsm/protocol';
import { AttributeStore } from './attributeStore';
import type { FeedSource, FeedStatus } from './types';

const TICK_MS = 100;
const REPLAY_SECONDS = 60;
const RECORDED_REPLAY_URL = '/replays/rmuc2026ai-loop.json';
const FIELD_X = 836;
const FIELD_Y = 1500;
const RECORDED_DART_FALLBACK_TARGET_IDS = [16, 17];

const CLASS_ID = {
  Hero: 1001,
  Engineer: 1002,
  Infantry: 1003,
  Sentry: 1004,
  Aerial: 1005,
  Dart: 1007,
  Base: 2001,
  Outpost: 2002,
  Building: 2000,
} as const;

interface ReplayRobot {
  mapId: number;
  pid: number;
  team: 0 | 1;
  teamNumber: number;
  classId: number;
  level: number;
  hpMax: number;
  ammoMax: number;
  heatMax: number;
  phase: number;
  path: Vec3[];
}

interface ReplayStructure {
  mapId: number;
  kind: 'base' | 'outpost' | 'rune';
  team?: 0 | 1;
  hpMax: number;
  pos: Vec3;
  yaw?: number;
}

interface RecordedReplayFrame {
  t: number;
  result: WatchAttributeMapsResult;
}

interface RecordedReplay {
  schema?: string;
  durationMs?: number;
  map?: MapWireframe;
  frames: RecordedReplayFrame[];
}

function oval(rx: number, ry: number, seg = 96): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry, z: 0 });
  }
  return pts;
}

function mirrorPath(path: Vec3[]): Vec3[] {
  return path.map((p) => ({ x: -p.x, y: -p.y, z: p.z }));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function samplePath(path: Vec3[], u: number): { pos: Vec3; yaw: number } {
  const wrapped = ((u % 1) + 1) % 1;
  const scaled = wrapped * path.length;
  const i = Math.floor(scaled) % path.length;
  const j = (i + 1) % path.length;
  const local = smooth(scaled - Math.floor(scaled));
  const a = path[i];
  const b = path[j];
  const pos = {
    x: lerp(a.x, b.x, local),
    y: lerp(a.y, b.y, local),
    z: lerp(a.z, b.z, local),
  };
  const yaw = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return { pos, yaw };
}

function wave01(t: number, offset = 0): number {
  return (Math.sin((t + offset) * Math.PI * 2) + 1) / 2;
}

function headingTo(from: Vec3, to: Vec3): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

function normalizeDeg(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function activeWindow(t: number, start: number, len: number): boolean {
  const u = ((t % 1) + 1) % 1;
  const end = start + len;
  return end <= 1 ? u >= start && u < end : u >= start || u < end - 1;
}

const RED_ATTACK_PATH: Vec3[] = [
  { x: 120, y: -1180, z: 66 },
  { x: -470, y: -900, z: 72 },
  { x: -520, y: -360, z: 98 },
  { x: -140, y: -80, z: 126 },
  { x: 240, y: 260, z: 92 },
  { x: 430, y: 830, z: 72 },
  { x: 80, y: 1160, z: 66 },
  { x: -260, y: 520, z: 82 },
];

const RED_DEFENSE_PATH: Vec3[] = [
  { x: -180, y: -1250, z: 66 },
  { x: 380, y: -1030, z: 72 },
  { x: 500, y: -560, z: 80 },
  { x: 210, y: -250, z: 78 },
  { x: -110, y: -550, z: 76 },
  { x: -420, y: -880, z: 72 },
];

const RED_CENTER_PATH: Vec3[] = [
  { x: -520, y: -720, z: 76 },
  { x: -260, y: -280, z: 116 },
  { x: -80, y: 0, z: 142 },
  { x: 230, y: 280, z: 116 },
  { x: 520, y: 700, z: 76 },
  { x: 240, y: 120, z: 122 },
];

const ROBOTS: ReplayRobot[] = [
  {
    mapId: 3008,
    pid: -1,
    team: 0,
    teamNumber: 9,
    classId: CLASS_ID.Dart,
    level: 1,
    hpMax: 180,
    ammoMax: 4,
    heatMax: 100,
    phase: 0.05,
    path: [{ x: 330, y: -1290, z: 2 }],
  },
  {
    mapId: 3018,
    pid: -1,
    team: 1,
    teamNumber: 9,
    classId: CLASS_ID.Dart,
    level: 1,
    hpMax: 180,
    ammoMax: 4,
    heatMax: 100,
    phase: 0.55,
    path: [{ x: -320, y: 1370, z: 2 }],
  },
  {
    mapId: 3001,
    pid: 1,
    team: 0,
    teamNumber: 1,
    classId: CLASS_ID.Hero,
    level: 3,
    hpMax: 600,
    ammoMax: 90,
    heatMax: 240,
    phase: 0.02,
    path: RED_ATTACK_PATH,
  },
  {
    mapId: 3002,
    pid: 2,
    team: 0,
    teamNumber: 2,
    classId: CLASS_ID.Engineer,
    level: 2,
    hpMax: 400,
    ammoMax: 60,
    heatMax: 220,
    phase: 0.18,
    path: RED_DEFENSE_PATH,
  },
  {
    mapId: 3003,
    pid: 3,
    team: 0,
    teamNumber: 3,
    classId: CLASS_ID.Infantry,
    level: 2,
    hpMax: 450,
    ammoMax: 75,
    heatMax: 200,
    phase: 0.34,
    path: RED_CENTER_PATH,
  },
  {
    mapId: 3004,
    pid: 4,
    team: 0,
    teamNumber: 7,
    classId: CLASS_ID.Sentry,
    level: 1,
    hpMax: 500,
    ammoMax: 140,
    heatMax: 260,
    phase: 0.54,
    path: [
      { x: -540, y: -1190, z: 74 },
      { x: -520, y: -820, z: 76 },
      { x: -470, y: -420, z: 92 },
      { x: -530, y: -760, z: 76 },
    ],
  },
  {
    mapId: 3006,
    pid: 6,
    team: 0,
    teamNumber: 6,
    classId: CLASS_ID.Aerial,
    level: 1,
    hpMax: 50,
    ammoMax: 0,
    heatMax: 100,
    phase: 0.7,
    path: RED_CENTER_PATH,
  },
  {
    mapId: 3011,
    pid: 101,
    team: 1,
    teamNumber: 1,
    classId: CLASS_ID.Hero,
    level: 3,
    hpMax: 600,
    ammoMax: 90,
    heatMax: 240,
    phase: 0.08,
    path: mirrorPath(RED_ATTACK_PATH),
  },
  {
    mapId: 3012,
    pid: 102,
    team: 1,
    teamNumber: 2,
    classId: CLASS_ID.Engineer,
    level: 2,
    hpMax: 400,
    ammoMax: 60,
    heatMax: 220,
    phase: 0.25,
    path: mirrorPath(RED_DEFENSE_PATH),
  },
  {
    mapId: 3013,
    pid: 103,
    team: 1,
    teamNumber: 3,
    classId: CLASS_ID.Infantry,
    level: 2,
    hpMax: 450,
    ammoMax: 75,
    heatMax: 200,
    phase: 0.42,
    path: mirrorPath(RED_CENTER_PATH),
  },
  {
    mapId: 3014,
    pid: 107,
    team: 1,
    teamNumber: 7,
    classId: CLASS_ID.Sentry,
    level: 1,
    hpMax: 500,
    ammoMax: 140,
    heatMax: 260,
    phase: 0.58,
    path: mirrorPath([
      { x: -540, y: -1190, z: 74 },
      { x: -520, y: -820, z: 76 },
      { x: -470, y: -420, z: 92 },
      { x: -530, y: -760, z: 76 },
    ]),
  },
  {
    mapId: 3016,
    pid: 106,
    team: 1,
    teamNumber: 6,
    classId: CLASS_ID.Aerial,
    level: 1,
    hpMax: 50,
    ammoMax: 0,
    heatMax: 100,
    phase: 0.76,
    path: mirrorPath(RED_CENTER_PATH),
  },
];

const STRUCTURES: ReplayStructure[] = [
  { mapId: 120, kind: 'base', team: 0, hpMax: 200, pos: { x: 8, y: -1130, z: 4 }, yaw: 90 },
  { mapId: 121, kind: 'base', team: 1, hpMax: 200, pos: { x: 7, y: 1185, z: 4 }, yaw: -90 },
  { mapId: 122, kind: 'outpost', team: 0, hpMax: 1500, pos: { x: -381, y: -283, z: 20 }, yaw: -90 },
  { mapId: 123, kind: 'outpost', team: 1, hpMax: 1500, pos: { x: 393, y: 333, z: 20 }, yaw: 90 },
  { mapId: 124, kind: 'rune', hpMax: 1, pos: { x: 0, y: 0, z: 90 }, yaw: 0 },
];

function aimTargetFor(r: ReplayRobot, u: number): Vec3 {
  const enemyTeam = r.team === 0 ? 1 : 0;
  const targetKind = activeWindow(u + r.phase, 0.32, 0.24) ? 'outpost' : 'base';
  const target =
    STRUCTURES.find((s) => s.team === enemyTeam && s.kind === targetKind) ??
    STRUCTURES.find((s) => s.team === enemyTeam && s.kind === 'base');
  const base = target?.pos ?? { x: 0, y: r.team === 0 ? FIELD_Y : -FIELD_Y, z: 0 };
  const sweep = Math.sin((u + r.phase) * Math.PI * 6) * 70;
  return {
    x: base.x + sweep,
    y: base.y - sweep * (r.team === 0 ? 0.36 : -0.36),
    z: base.z + 95,
  };
}

function robotAttributes(r: ReplayRobot, replayT: number): Record<string, number> {
  const u = (replayT / REPLAY_SECONDS + r.phase) % 1;
  const { pos, yaw } = samplePath(r.path, u);
  const target = aimTargetFor(r, u);
  const turretSweep = Math.sin((u + r.phase * 0.7) * Math.PI * 8) * 7;
  const turretYaw = normalizeDeg(headingTo(pos, target) + turretSweep);
  const turretPitch = -5 - wave01(u * 2.6, r.phase) * 4;
  const damage = 0.1 + wave01(u, r.team * 0.17 + r.teamNumber * 0.09) * 0.36;
  const heat = Math.round((0.08 + wave01(u * 3.2, r.phase) * 0.88) * r.heatMax);
  const dartCycle = ((replayT + r.phase * REPLAY_SECONDS) % 34) / 34;
  const ammo =
    r.classId === CLASS_ID.Dart
      ? Math.max(0, r.ammoMax - Math.floor(dartCycle * r.ammoMax))
      : Math.max(0, r.ammoMax - Math.floor(((u + r.phase) % 1) * r.ammoMax * 0.82));
  const ammo42 =
    r.classId === CLASS_ID.Hero
      ? Math.max(0, 8 - Math.floor(((u * 0.34 + r.phase * 0.23) % 1) * 6))
      : 0;
  const deploymentMode =
    r.classId === CLASS_ID.Hero && activeWindow(u + r.phase * 0.3, 0.58, 0.22);
  // Sentry modes: 1=Defense, 2=Cooling, 3=Movement. There is NO attack mode — the
  // damage slot is an always-on base. Each mode drives exactly one gain slot
  // positive (def / cool / power), mirroring real recordings; enhanced amplifies it.
  const sentryMode =
    r.classId === CLASS_ID.Sentry ? (Math.floor(u * 3) % 3) + 1 : undefined;
  const sentryEnhanced =
    sentryMode != null && activeWindow(u, 0.14, 0.34) ? 1 : 0;

  return {
    [AttrId.PlayerID]: r.pid,
    [AttrId.TeamID]: r.team,
    [AttrId.TeamNumber]: r.teamNumber,
    [AttrId.Class]: r.classId,
    [AttrId.Level]: r.level,
    [AttrId.Health]: Math.max(1, Math.round(r.hpMax * (1 - damage))),
    [AttrId.HealthMax]: r.hpMax,
    [AttrId.FiringHeat1]: heat,
    [AttrId.FiringHeatMax1]: r.heatMax,
    [AttrId.Ammo17mmCount]: ammo,
    ...(r.classId === CLASS_ID.Hero ? { [AttrId.Ammo42mmCount]: ammo42 } : {}),
    [AttrId.FiringLocked]: ammo + ammo42 === 0 || heat > r.heatMax * 0.92 ? 1 : 0,
    [AttrId.WorldPosX]: Math.round(pos.x),
    [AttrId.WorldPosY]: Math.round(pos.y),
    [AttrId.WorldPosZ]: Math.round(pos.z),
    [AttrId.ChassisYaw]: Math.round(yaw),
    [AttrId.TurretYaw]: Math.round(turretYaw),
    [AttrId.TurretPitch]: Math.round(turretPitch),
    [AttrId.Invincible]: activeWindow(u, 0.05, 0.08) && r.teamNumber === 1 ? 1 : 0,
    [AttrId.Overheated]: heat > r.heatMax * 0.92 ? 1 : 0,
    [AttrId.DefenseMultiplierThou]: activeWindow(u, 0.24, 0.16) && r.teamNumber === 2 ? 1500 : 0,
    [AttrId.AttackMultiplierThou]: activeWindow(u, 0.42, 0.14) && r.teamNumber === 3 ? 1500 : 0,
    [AttrId.RecoverMultiplierThou]: activeWindow(u, 0.66, 0.12) ? 1200 : 0,
    [AttrId.PowerMultiplierThou]: activeWindow(u, 0.36, 0.12) && r.team === 1 ? 1200 : 0,
    [AttrId.ColdMultiplierThou]: activeWindow(u, 0.76, 0.1) ? 1300 : 0,
    [AttrId.Weakened]: activeWindow(u, 0.52, 0.08) && r.teamNumber === 3 ? 1 : 0,
    [AttrId.Blocked]: activeWindow(u, 0.82, 0.06) && r.teamNumber === 7 ? 1 : 0,
    ...(r.classId === CLASS_ID.Dart
      ? {
          [AttrId.RealDartAmmoCount]: ammo,
          [AttrId.AmmoDartCount]: ammo,
          [AttrId.DartRemainingShots]: ammo,
        }
      : {}),
    // 易伤 debuff (damage taken), independent of attack — fires on its own.
    [AttrId.DamageMultiplierThou]: activeWindow(u, 0.48, 0.1) && r.teamNumber === 4 ? 1000 : 0,
    ...(r.classId === CLASS_ID.Hero
      ? { [AttrId.IsInDeploymentMode]: deploymentMode ? 1 : 0 }
      : {}),
    ...(sentryMode != null
      ? {
          [AttrId.SentryMode]: sentryMode,
          [AttrId.SentryModeEnhanced]: sentryEnhanced,
          // Damage slot = always-on ~250 base, NEVER a mode gain.
          [AttrId.SentryDamageMultiplierThou]: 250,
          // Defense mode: small positive defense gain (enhanced ≈990, else 500).
          [AttrId.SentryDefenseMultiplierThou]: sentryMode === 1 ? (sentryEnhanced ? 990 : 500) : 0,
          // Cooling mode: large cooling gain (enhanced amplifies hugely).
          [AttrId.SentryColdMultiplierThou]: sentryMode === 2 ? (sentryEnhanced ? 1_000_000 : 2000) : 0,
          // Movement mode: the power coefficient goes POSITIVE (it is negative — a
          // debuff — in the other two modes); that positive value is the move gain.
          [AttrId.SentryPowerCoefficientThou]: sentryMode === 3 ? (sentryEnhanced ? 5000 : 500) : -500,
        }
      : {}),
  } as Record<string, number>;
}

function structureAttributes(s: ReplayStructure, replayT: number): Record<string, number> {
  const pulse = wave01(replayT / REPLAY_SECONDS, s.mapId * 0.01);
  const hp =
    s.kind === 'base'
      ? s.hpMax
      : s.kind === 'outpost'
        ? Math.round(s.hpMax * (0.72 + pulse * 0.18))
        : 1;
  const healthRatio = s.hpMax > 0 ? hp / s.hpMax : 1;
  const deployed =
    s.kind === 'base' ? wave01(replayT / 9, (s.team ?? 0) * 0.31) > 0.68 : false;
  const dartHits =
    s.kind === 'base' && s.team != null
      ? Math.floor(((replayT + (s.team === 0 ? 17 : 0)) % 136) / 34)
      : undefined;
  return {
    [AttrId.Class]:
      s.kind === 'base'
        ? CLASS_ID.Base
        : s.kind === 'outpost'
          ? CLASS_ID.Outpost
          : CLASS_ID.Building,
    ...(s.team != null ? { [AttrId.TeamID]: s.team } : {}),
    [AttrId.Health]: hp,
    [AttrId.HealthMax]: s.hpMax,
    [AttrId.HP_Progress]: healthRatio,
    [AttrId.WorldPosX]: s.pos.x,
    [AttrId.WorldPosY]: s.pos.y,
    [AttrId.WorldPosZ]: s.pos.z,
    ...(s.yaw != null ? { [AttrId.ChassisYaw]: s.yaw } : {}),
    ...(s.kind === 'base' && s.team != null
      ? {
          [AttrId.TM_Coins]: Math.round(200 + pulse * 160 + s.team * 40),
          [AttrId.TM_BaseDamageCount]: dartHits ?? 0,
          [AttrId.TM_OutPostRebuildCount]: 0,
          [AttrId.BC_State]: deployed ? 1 : 0, // base 展开/deploy state
        }
      : {}),
    ...(s.kind === 'outpost'
      ? {
          [AttrId.ReviveCount]: 0,
          [AttrId.ReviveProgress]: 0,
          [AttrId.ReviveSpeed]: 1,
          [AttrId.ReviveProgressMax]: 90,
        }
      : {}),
    ...(s.kind === 'rune'
      ? {
          [AttrId.BS_State]: Math.floor((replayT / 5) % 3),
          [AttrId.BS_CurOmega]: Math.round(120 + pulse * 240),
        }
      : {}),
  } as Record<string, number>;
}

function replayFrame(replayT: number): WatchAttributeMapsResult {
  return {
    cycle_event_type: 0,
    watch_attribute_maps_results: [
      {
        sync_type: 0,
        attribute_map_id: 80,
        attributes: {
          [AttrId.G_BaseId_0]: 120,
          [AttrId.G_BaseId_0 + 1]: 121,
          [AttrId.G_OutpostId_0]: 122,
          [AttrId.G_OutpostId_0 + 1]: 123,
          [AttrId.G_BuffStationId_0]: 124,
        } as Record<string, number>,
      },
      ...ROBOTS.map((r) => ({
        sync_type: 0,
        attribute_map_id: r.mapId,
        attributes: robotAttributes(r, replayT),
      })),
      ...STRUCTURES.map((s) => ({
        sync_type: 0,
        attribute_map_id: s.mapId,
        attributes: structureAttributes(s, replayT),
      })),
    ],
  };
}

function recordedDartTargetIds(replay: RecordedReplay): { bases: number[]; robots: number[] } {
  const bases = new Set<number>();
  const robots = new Set<number>();
  for (const frame of replay.frames) {
    for (const entry of frame.result.watch_attribute_maps_results) {
      const classId = entry.attributes?.[AttrId.Class];
      if (classId === CLASS_ID.Base) bases.add(entry.attribute_map_id);
      else if (classId !== CLASS_ID.Dart && entry.attributes?.[AttrId.Blocked] != null) {
        robots.add(entry.attribute_map_id);
      }
    }
    if (bases.size >= 2 && robots.size >= 2) break;
  }
  return {
    bases: bases.size > 0 ? [...bases] : RECORDED_DART_FALLBACK_TARGET_IDS,
    robots: [...robots],
  };
}

function recordedDartOverlay(
  replayTMs: number,
  targets: { bases: number[]; robots: number[] }
): WatchAttributeMapsResult {
  if (targets.bases.length === 0 && targets.robots.length === 0) {
    return { cycle_event_type: 0, watch_attribute_maps_results: [] };
  }
  const cycleMs = 34_000;
  const phase = replayTMs % cycleMs;
  const cycle = Math.floor(replayTMs / cycleMs);
  const hitApplied = phase >= 18_000;
  const active = hitApplied && phase < 19_250;
  const baseCount = Math.max(1, targets.bases.length);
  const baseIndex = cycle % baseCount;
  const robotTarget = targets.robots[cycle % Math.max(1, targets.robots.length)];
  return {
    cycle_event_type: 0,
    watch_attribute_maps_results: [
      ...targets.bases.map((id, i) => ({
        sync_type: 1,
        attribute_map_id: id,
        attributes: {
          [AttrId.TM_BaseDamageCount]:
            Math.floor((cycle + baseCount - 1 - i) / baseCount) +
            (hitApplied && i === baseIndex ? 1 : 0),
        } as Record<string, number>,
      })),
      ...targets.robots.map((id) => ({
        sync_type: 1,
        attribute_map_id: id,
        attributes: {
          [AttrId.Blocked]: active && id === robotTarget ? 1 : 0,
        } as Record<string, number>,
      })),
    ],
  };
}

function isRecordedReplay(value: unknown): value is RecordedReplay {
  if (!value || typeof value !== 'object') return false;
  const replay = value as Partial<RecordedReplay>;
  return (
    Array.isArray(replay.frames) &&
    replay.frames.length > 0 &&
    replay.frames.every(
      (frame) =>
        typeof frame?.t === 'number' &&
        Number.isFinite(frame.t) &&
        Array.isArray(frame.result?.watch_attribute_maps_results)
    )
  );
}

async function loadRecordedReplay(): Promise<RecordedReplay | null> {
  try {
    const res = await fetch(RECORDED_REPLAY_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return isRecordedReplay(data) ? data : null;
  } catch {
    return null;
  }
}

export function createMockFeed(): FeedSource {
  let store = new AttributeStore();
  const fallbackMap: MapWireframe = {
    mapId: 'RMUC2026AI',
    lines: [oval(600, 1211), oval(360, 727)],
    bounds: { min: { x: -FIELD_X, y: -FIELD_Y, z: 0 }, max: { x: FIELD_X, y: FIELD_Y, z: 0 } },
  };

  let frame = 0;
  let recordedReplay: RecordedReplay | null = null;
  let recordedReplayStartedAt = 0;
  let recordedReplayIndex = 0;
  let recordedDartTargets: { bases: number[]; robots: number[] } = { bases: [], robots: [] };
  let lastRecordedReplayT = 0;
  let startToken = 0;
  let mapCb: ((m: MapWireframe) => void) | null = null;
  let snapCb: ((s: WorldSnapshot) => void) | null = null;
  let statusCb: ((s: FeedStatus) => void) | null = null;
  let timer: number | null = null;

  function recordedDurationMs(replay: RecordedReplay): number {
    return Math.max(
      1,
      replay.durationMs ?? replay.frames[replay.frames.length - 1]?.t ?? TICK_MS
    );
  }

  function tickRecorded(replay: RecordedReplay) {
    const replayT = (performance.now() - recordedReplayStartedAt) % recordedDurationMs(replay);
    if (replayT < lastRecordedReplayT) {
      store = new AttributeStore();
      recordedReplayIndex = 0;
    }

    while (
      recordedReplayIndex < replay.frames.length &&
      replay.frames[recordedReplayIndex].t <= replayT
    ) {
      store.applyResult(replay.frames[recordedReplayIndex].result);
      recordedReplayIndex++;
    }
    store.applyResult(recordedDartOverlay(replayT, recordedDartTargets));

    lastRecordedReplayT = replayT;
    snapCb?.(store.toSnapshot());
  }

  function tickProcedural() {
    const replayT = ((frame * TICK_MS) / 1000) % REPLAY_SECONDS;
    store.applyResult(replayFrame(replayT));
    snapCb?.(store.toSnapshot());
    frame++;
  }

  function tick() {
    if (recordedReplay) tickRecorded(recordedReplay);
    else tickProcedural();
  }

  function startTimer(map: MapWireframe) {
    statusCb?.('open');
    mapCb?.(map);
    tick();
    timer = window.setInterval(tick, TICK_MS);
  }

  return {
    label: 'mock replay',
    onMap: (cb) => (mapCb = cb),
    onSnapshot: (cb) => (snapCb = cb),
    onStatus: (cb) => (statusCb = cb),
    setActive: () => {}, // the mock is lightweight and not visibility-gated
    start: () => {
      if (timer != null) return;
      const token = ++startToken;
      statusCb?.('connecting');
      loadRecordedReplay().then((replay) => {
        if (token !== startToken || timer != null) return;
        store = new AttributeStore();
        frame = 0;
        recordedReplay = replay;
        recordedDartTargets = replay ? recordedDartTargetIds(replay) : { bases: [], robots: [] };
        recordedReplayStartedAt = performance.now();
        recordedReplayIndex = 0;
        lastRecordedReplayT = 0;
        startTimer(replay?.map ?? fallbackMap);
      });
    },
    close: () => {
      startToken++;
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
      recordedReplay = null;
      recordedDartTargets = { bases: [], robots: [] };
      statusCb?.('closed');
    },
  };
}

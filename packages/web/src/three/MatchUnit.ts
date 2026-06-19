import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { MapWireframe, VehicleState, WorldSnapshot } from '@gsm/protocol';
import { ueToThree } from './coords';
import {
  mapModelFor,
  loadMapModel,
  disposeMapModel,
  type LoadedMapModel,
} from './mapModels';
import {
  disposeBuildingModel,
  loadBuildingModel,
  styleBuildingModel,
  updateBuildingModel,
  type BuildingModelKind,
  type LoadedBuildingModel,
} from './buildingModels';
import {
  clearSurfaceProjectionMaterial,
  installSurfaceProjectionMaterial,
  MAX_SURFACE_PROJECTIONS,
  updateSurfaceProjectionMaterial,
  type SurfaceProjection,
} from './surfaceProjectionMaterial';
import {
  createSurfaceCorruptionUniforms,
  installSurfaceCorruptionMaterial,
  type SurfaceCorruptionUniforms,
} from './surfaceCorruptionMaterial';

// Spectator panel team colours: blue #1FA3F6, red #F03A30.
const TEAM_COLORS: Record<string, number> = { red: 0xf03a30, blue: 0x1fa3f6 };
const NEUTRAL = 0x8ad36b;

/** Buff pip order + icons, matching the spectator panel's curated slots. */
const BUFF_ORDER = [
  'inv',
  'heat',
  'def',
  'atk',
  'heal',
  'power',
  'cool',
  'weak',
  'blind',
] as const;
type BuffKey = (typeof BUFF_ORDER)[number];
const SENTRY_MODE_MARKERS: Record<string, BuffKey> = {
  'sentry-mode-def': 'def',
  'sentry-mode-power': 'power',
  'sentry-mode-cool': 'cool',
};
interface BuffIconDef {
  color: string;
  title: string;
  path: string;
  fill?: boolean;
}
const BUFF_ICONS: Record<BuffKey, BuffIconDef> = {
  inv: {
    color: '#5cd6ff',
    title: '无敌',
    path: 'M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z',
  }, // shield
  heat: {
    color: '#ff7a45',
    title: '过热',
    path: 'M12 2c1 4 5 5 5 10a5 5 0 1 1-10 0c0-2 1-4 2-5 .5 2 1.5 2 1.5 0 0-2 .5-4 1.5-5z',
  }, // flame
  def: {
    color: '#4e8ce5',
    title: '防御增益',
    path: 'M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5zM8.5 11.5l2.5 2.5 4.5-4.5',
  }, // shield+check
  atk: {
    color: '#ff6b6b',
    title: '攻击增益',
    path: 'M14 3l7 7-2 2-7-7zM4 19l8-8 2 2-8 8-3 1z',
  }, // sword
  heal: {
    color: '#3ec07a',
    title: '恢复增益',
    path: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z',
  }, // cross
  power: {
    color: '#ffce54',
    title: '功率增益',
    path: 'M13 2L5 13h5l-1 9 8-12h-5z',
  }, // lightning bolt
  cool: {
    color: '#7ad6ff',
    title: '冷却增益',
    path: 'M12 2v20M3.5 7l17 10M20.5 7l-17 10',
  }, // snowflake
  weak: {
    color: '#c77dff',
    title: '虚弱',
    fill: true,
    // 虚弱 — skull (filled; eye sockets + nose are evenodd holes)
    path: 'M12 2a7 7 0 00-7 7c0 2.6 1.3 4.3 2.8 5.3v1.7A1.5 1.5 0 009.3 17.5h.7v2h1.3v-2h1.4v2h1.3v-2h.7a1.5 1.5 0 001.5-1.5v-1.7C17.7 13.3 19 11.6 19 9a7 7 0 00-7-7zM9 8.4a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4zm6 0a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4zm-3 4.1l1 2h-2z',
  }, // 虚弱 — purple skull
  blind: {
    color: '#ff5b6e',
    title: '致盲',
    path: 'M2 12s4-6.5 10-6.5S22 12 22 12s-4 6.5-10 6.5S2 12 2 12zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5M3 3l18 18',
  }, // eye + slash
};
/** A vehicle not seen for this long is dropped. */
const STALE_MS = 2000;
const PLINTH_HEIGHT = 0.4;
const PLINTH_TOP_Y = -0.05;
const PROJECTION_RAY_PAD = 4;
const PROJECTION_MIN_LINE = 0.04;
const PROJECTION_SURFACE_UPDATE_MS = 180;
const PROJECTION_SURFACE_FORCE_UPDATE_MS = 650;
const PROJECTION_SURFACE_MOVE_EPS_SQ = 0.01;
const PROJECTION_RING_INNER = 0.24;
const PROJECTION_RING_OUTER = 0.4;
const PROJECTION_RING_OPACITY = 0.78;
const SANDBOX_CALIBRATION_EPS = 1e-4;
const PROJECTILE_MIN_INTERVAL_MS = 160;
const PROJECTILE_PENDING_MS = 230;
const PROJECTILE_HIT_MAX = 24;
const PROJECTILE_MISS_MAX = 5.2;
const PROJECTILE_TRAIL_LENGTH = 1.15;
const PROJECTILE_TRAIL_FADE_MS = 160;
const PROJECTILE_SPEED = 55;
const PROJECTILE_MIN_TRAVEL_MS = 70;
const PROJECTILE_MAX_TRAVEL_MS = 320;
const PROJECTILE_MUZZLE_FORWARD = 0.24;
const PROJECTILE_MUZZLE_HEIGHT = 0.18;
const PROJECTILE_DAMAGE_WINDOW_MS = 360;
const PROJECTILE_SPARK_TTL_MS = 520;
const PROJECTILE_SPARK_COUNT = 14;
const PROJECTILE_TRAIL_OPACITY = 0.82;
const PROJECTILE_SPARK_OPACITY = 0.95;
const HERO_DIRECT_BEAM_RADIUS = 0.035;
const HERO_DIRECT_TRAIL_OPACITY = 0.95;
const HERO_BIG_SPARK_DAMAGE = 100;
const HERO_BIG_SPARK_SCALE = 1.55;
const HERO_LOB_MIN_DAMAGE = 150;
const ARC_TRAIL_SAMPLES = 10;
const HERO_LOB_MIN_TRAVEL_MS = 900;
const HERO_LOB_MAX_TRAVEL_MS = 1450;
const DART_MIN_TRAVEL_MS = 1200;
const DART_MAX_TRAVEL_MS = 1900;
const HERO_LOB_SPEED = 12;
const DART_SPEED = 17;
const HERO_LOB_ARC_MIN = 2.4;
const DART_ARC_MIN = 4.2;
const EXPLOSION_SMALL_TTL_MS = 620;
const EXPLOSION_LARGE_TTL_MS = 900;
const CLASS_HERO = 1001;
const CLASS_AERIAL = 1005;
/**
 * Exponential-smoothing rate (1/sec) used to interpolate vehicle transforms
 * toward the latest snapshot every frame. `alpha = 1 - exp(-SMOOTH*dt)` is
 * frame-rate independent: the time constant τ = 1/SMOOTH ≈ 83ms stays the same
 * whether we render at 30 or 144 fps, so motion looks identical. Lower = smoother
 * but laggier; higher = snappier but can re-expose the 20–30fps snapshot steps.
 */
const SMOOTH = 12;

/** Line-material look per visual state. */
const LINE_FOCUSED = 0x82c0ff;
const LINE_NORMAL = 0x4f8fcf;
const LINE_DIM = 0x2c4358;
const OPACITY_FOCUSED = 0.95;
const OPACITY_NORMAL = 0.7;
const OPACITY_DIM = 0.28;

/**
 * Visual state of a unit. `normal` = overview, nothing focused (all units lit so
 * you can watch them at once). `focused` = the picked unit (bright + per-vehicle
 * panels + spotlight). `dim` = a non-focused unit while another is focused.
 */
export type UnitState = 'normal' | 'focused' | 'dim';

/** Geometry shared across all units — allocated once by DioramaScene. */
export interface SharedAssets {
  bodyGeo: THREE.BufferGeometry;
}

function teamColor(team: string | number | undefined): number {
  return typeof team === 'string' && team in TEAM_COLORS ? TEAM_COLORS[team] : NEUTRAL;
}

function sparkColor(team: string | number | undefined): number {
  if (team === 'red') return 0xff9a90;
  if (team === 'blue') return 0xa6edff;
  return 0xc8ffd6;
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, n));

/** Max discrete 50-HP cells before the bar collapses to one continuous fill. */
const MAX_CELLS = 10;
const RESPAWN_DEFAULT_MS = 60_000;
const RESPAWN_MAX_MS = 120_000;
const RESPAWN_SEGMENT_MS = 15_000;
const RESPAWN_FILL = 'rgba(62, 192, 122, 0.58)';
const RESPAWN_FILL_DIM = 'rgba(62, 192, 122, 0.32)';

/** Cached references into a built panel, so updates touch only changed nodes. */
interface PanelDom {
  root: HTMLElement;
  /** Fixed known buff pip slots, keyed by buff. */
  buffPips: Record<string, HTMLElement>;
  /** team-coloured "B3"/"R1" text */
  tag: HTMLElement;
  /** "Lv3" */
  lv: HTMLElement;
  /** ⊘ firing-locked prohibition (hidden unless locked) */
  lock: HTMLElement;
  /** top-right metadata wrapper: ammo for robots/bases, repair count for outposts */
  ammoWrap: HTMLElement;
  /** ammo number (dims when firing-locked) */
  ammo: HTMLElement;
  /** the MAX_CELLS HP cell containers + their fills */
  cells: HTMLElement[];
  fills: HTMLElement[];
  heatRow: HTMLElement;
  heatBar: HTMLElement;
  last: {
    buffs?: string;
    tag?: string;
    team?: string | number;
    lv?: string;
    ammo?: string;
    locked?: boolean | null;
    hp?: number;
    hpMax?: number;
    barMode?: 'hp' | 'respawn';
    respawnProgress?: number;
    respawnSegments?: number;
    heat?: number;
  };
}

interface VehicleViz {
  group: THREE.Group;
  body: THREE.Mesh;
  bodyCorruptionUniforms: SurfaceCorruptionUniforms;
  buildingKind: BuildingModelKind | null;
  buildingModel: LoadedBuildingModel | null;
  buildingLoadId: number;
  projectionLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  projectionLinePos: THREE.BufferAttribute;
  projectionSurfaceY: number;
  projectionSurfaceX: number;
  projectionSurfaceZ: number;
  projectionSurfaceUpdatedAt: number;
  projectionSurfaceValid: boolean;
  /** Rendered (interpolated) transform. */
  curPos: THREE.Vector3;
  curQuat: THREE.Quaternion;
  /** Latest snapshot transform we ease toward. */
  tgtPos: THREE.Vector3;
  tgtQuat: THREE.Quaternion;
  /** False until the first snapshot, so a new car snaps in instead of flying from origin. */
  placed: boolean;
  lastSeen: number;
  lastTeam: string | number | undefined;
  lastV: VehicleState | null;
  defeatedSince: number | null;
  /** Per-vehicle info panel — lazily built and only attached while focused. */
  label: CSS2DObject | null;
  panel: PanelDom | null;
  lastShotAt: number;
}

interface SparkBurst {
  line: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  positionAttr: THREE.BufferAttribute;
  velocities: THREE.Vector3[];
  lengths: number[];
  origin: THREE.Vector3;
  bornAt: number;
  ttl: number;
  opacity: number;
}

interface ProjectileViz {
  group: THREE.Group;
  trail: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  trailPos: THREE.BufferAttribute;
  trailSamples: number;
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> | null;
  sparks: SparkBurst | null;
  explosion: ExplosionBurst | null;
  start: THREE.Vector3;
  end: THREE.Vector3;
  distance: number;
  travelMs: number;
  trajectory: 'line' | 'arc';
  arcHeight: number;
  trailOpacity: number;
  bornAt: number;
  ttl: number;
}

type ShotKind = 'direct' | 'hero-lob' | 'dart';
type ExplosionSize = 'none' | 'small' | 'large';

interface PendingShot {
  viz: VehicleViz;
  vehicle: VehicleState;
  start: THREE.Vector3;
  dir: THREE.Vector3;
  fallbackEnd?: THREE.Vector3;
  bornAt: number;
  kind: ShotKind;
  explosionSize: ExplosionSize;
}

interface DamageTarget {
  id: number;
  viz: VehicleViz;
  vehicle: VehicleState;
  amount: number;
  seenAt: number;
}

interface ProjectileImpact {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  damageAmount?: number;
}

interface ExplosionBurst {
  group: THREE.Group;
  rings: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[];
  bornAt: number;
  ttl: number;
  radius: number;
  opacity: number;
}

interface RespawnDisplay {
  progress: number;
  totalMs: number;
  segments: number;
  inferred: boolean;
}

function buffIconMarkup({ color, path, fill }: BuffIconDef): string {
  const body = fill
    ? `<path d="${path}" fill="${color}" fill-rule="evenodd"/>`
    : `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"/>`;
  return `<svg viewBox="0 0 24 24">${body}</svg>`;
}

/**
 * Per-unit nameplate matching the spectator panel: buff pips above a 140px dark
 * card, then header, HP cells, and a thin heat strip.
 */
function buildPanel(): PanelDom {
  const root = document.createElement('div');
  root.className = 'veh-panel';

  // Buff pips above the card: fixed known slots (BUFF_ORDER), toggled per buff.
  const buffsRow = document.createElement('div');
  buffsRow.className = 'vp-buffs';
  const buffPips: Record<string, HTMLElement> = {};
  for (const key of BUFF_ORDER) {
    const icon = BUFF_ICONS[key];
    const pip = document.createElement('span');
    pip.className = 'vp-pip';
    pip.title = icon.title;
    pip.setAttribute('aria-label', icon.title);
    pip.innerHTML = buffIconMarkup(icon);
    pip.hidden = true;
    buffPips[key] = pip;
    buffsRow.appendChild(pip);
  }
  root.appendChild(buffsRow);

  const box = document.createElement('div');
  box.className = 'vp-box';

  const head = document.createElement('div');
  head.className = 'vp-head';
  const tag = document.createElement('span');
  tag.className = 'vp-tag';
  const lv = document.createElement('span');
  lv.className = 'vp-lv';
  const ammoWrap = document.createElement('span');
  ammoWrap.className = 'vp-ammo';
  const lock = document.createElement('i');
  lock.className = 'vp-lock';
  lock.hidden = true;
  const ammo = document.createElement('b');
  ammoWrap.append(lock, ammo);
  head.append(tag, lv, ammoWrap);
  box.appendChild(head);

  // HP cells: MAX_CELLS slots, 50 HP each, shown/hidden + filled per snapshot.
  const cellsRow = document.createElement('div');
  cellsRow.className = 'vp-cells';
  const cells: HTMLElement[] = [];
  const fills: HTMLElement[] = [];
  for (let i = 0; i < MAX_CELLS; i++) {
    const cell = document.createElement('div');
    cell.className = 'vp-cell';
    const fill = document.createElement('i');
    cell.appendChild(fill);
    cellsRow.appendChild(cell);
    cells.push(cell);
    fills.push(fill);
  }
  box.appendChild(cellsRow);

  const heatRow = document.createElement('div');
  heatRow.className = 'vp-heat';
  const heatBar = document.createElement('i');
  heatRow.appendChild(heatBar);
  box.appendChild(heatRow);

  root.appendChild(box);
  return { root, buffPips, tag, lv, lock, ammoWrap, ammo, cells, fills, heatRow, heatBar, last: {} };
}

/** "B3" / "R1" from team + in-team number; falls back to the vehicle name/id. */
function nameplate(v: VehicleState): string {
  if (v.kind === 'base') return 'Base';
  if (v.kind === 'outpost') return 'Outpost';
  if (v.kind === 'rune') return 'RUNE';
  const letter = v.team === 'blue' ? 'B' : v.team === 'red' ? 'R' : '';
  if (letter && v.teamNumber != null) return `${letter}${v.teamNumber}`;
  return v.name ?? `#${v.id}`;
}

function buildingModelKind(v: VehicleState): BuildingModelKind | null {
  return v.kind === 'base' || v.kind === 'outpost' ? v.kind : null;
}

function vehicleDefeated(v: VehicleState | null): boolean {
  if (!v) return false;
  if (v.defeated === true) return true;
  if (typeof v.hp === 'number') return v.hp <= 0;
  return typeof v.health === 'number' && v.health <= 0;
}

function buildingDestroyed(v: VehicleState | null): boolean {
  return !!v && (v.kind === 'base' || v.kind === 'outpost') && vehicleDefeated(v);
}

function robotDestroyed(v: VehicleState | null): boolean {
  return !!v && !buildingModelKind(v) && vehicleDefeated(v);
}

function buildingDeployed(v: VehicleState | null): boolean | undefined {
  return v?.kind === 'base' && typeof v.deployed === 'boolean' ? v.deployed : undefined;
}

/**
 * One match rendered as a self-contained "diorama unit": its map wireframe,
 * vehicle markers, a base plinth (the raycast pick target), and a floating title
 * plaque. Rooted at `root`, which DioramaScene translates to a grid cell — the
 * geometry is origin-centred so a translation is all the placement needed.
 *
 * Owns the per-frame interpolation (so motion is smooth at 60fps regardless of
 * the 20–30fps feed) and the per-vehicle label DOM (built once, diffed, and only
 * shown while focused — in overview just the plaque renders).
 */
export class MatchUnit {
  readonly root = new THREE.Group();
  private mapGroup = new THREE.Group();
  private lines: THREE.Line[] = [];
  private lineMat = new THREE.LineBasicMaterial({
    color: LINE_NORMAL,
    transparent: true,
    opacity: OPACITY_NORMAL,
  });
  private plinth: THREE.Mesh | null = null;
  private plinthMat: THREE.MeshStandardMaterial | null = null;
  private plaque: CSS2DObject;
  private plaqueEl: HTMLElement;
  private vehicles = new Map<number, VehicleViz>();
  private projectiles: ProjectileViz[] = [];
  private pendingShots: PendingShot[] = [];
  private recentDamageTargets: DamageTarget[] = [];
  private state: UnitState = 'normal';
  /** Loaded 3D sandbox model for maps that have one (else the wireframe is shown). */
  private model: LoadedMapModel | null = null;
  private baseAnchorRed = new THREE.Vector3();
  private baseAnchorBlue = new THREE.Vector3();
  private hasBaseAnchorRed = false;
  private hasBaseAnchorBlue = false;
  private sandboxCalibration = { scaleZ: 1, positionZ: 0 };
  /** Bumped each setMap so a stale async model load can be discarded. */
  private modelLoadId = 0;
  private disposed = false;
  private surfaceProjectionPool: SurfaceProjection[] = Array.from(
    { length: MAX_SURFACE_PROJECTIONS },
    () => ({ x: 0, z: 0, color: NEUTRAL })
  );
  private surfaceProjections: SurfaceProjection[] = [];
  private surfaceProjectionActive = false;
  /** Set by DioramaScene — invoked when an async model load changes the footprint. */
  onBoundsChange?: () => void;
  /** Local-space bounds (plinth footprint + a little height); placeholder until setMap. */
  private _localBounds = new THREE.Box3(
    new THREE.Vector3(-20, -0.45, -15),
    new THREE.Vector3(20, 1, 15)
  );

  private tmpDir = new THREE.Vector3();
  private tmpMat = new THREE.Matrix4();
  private tmpQuat = new THREE.Quaternion();
  private tmpBuildingOffset = new THREE.Vector3();
  private tmpRayLocal = new THREE.Vector3();
  private tmpRayWorld = new THREE.Vector3();
  private tmpHitLocal = new THREE.Vector3();
  private tmpProjectileDir = new THREE.Vector3();
  private tmpProjectileFlat = new THREE.Vector3();
  private tmpProjectileNormal = new THREE.Vector3();
  private tmpProjectileWorld = new THREE.Vector3();
  private tmpProjectileBeamTail = new THREE.Vector3();
  private tmpProjectileBeamHead = new THREE.Vector3();
  private tmpProjectileBeamMid = new THREE.Vector3();
  private tmpProjectileBeamQuat = new THREE.Quaternion();
  private projectionRay = new THREE.Raycaster();
  private projectionHits: THREE.Intersection[] = [];
  private projectileRay = new THREE.Raycaster();
  private projectileHits: THREE.Intersection[] = [];
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly DOWN = new THREE.Vector3(0, -1, 0);
  private static readonly ORIGIN = new THREE.Vector3(0, 0, 0);

  constructor(
    readonly key: string,
    label: string,
    private shared: SharedAssets
  ) {
    this.root.add(this.mapGroup);
    this.plaqueEl = document.createElement('div');
    this.plaqueEl.className = 'match-plaque';
    this.plaqueEl.textContent = label;
    this.plaque = new CSS2DObject(this.plaqueEl);
    this.plaque.position.set(0, 2.6, 0);
    this.plaque.center.set(0.5, 1);
    this.root.add(this.plaque);
  }

  setLabel(label: string): void {
    this.plaqueEl.textContent = label;
  }

  setMap(map: MapWireframe): void {
    this.hasBaseAnchorRed = false;
    this.hasBaseAnchorBlue = false;
    for (const line of this.lines) {
      this.mapGroup.remove(line);
      line.geometry.dispose();
    }
    this.lines = [];
    for (const poly of map.lines) {
      const geo = new THREE.BufferGeometry().setFromPoints(poly.map((p) => ueToThree(p)));
      const line = new THREE.Line(geo, this.lineMat);
      this.lines.push(line);
      this.mapGroup.add(line);
    }

    // Footprint: prefer declared bounds, else union the line geometries.
    const box = new THREE.Box3();
    if (map.bounds) {
      box.expandByPoint(ueToThree(map.bounds.min)).expandByPoint(ueToThree(map.bounds.max));
    } else {
      const tmp = new THREE.Box3();
      for (const line of this.lines) {
        line.geometry.computeBoundingBox();
        if (line.geometry.boundingBox) box.union(tmp.copy(line.geometry.boundingBox));
      }
    }
    const cx = (box.max.x + box.min.x) / 2;
    const cz = (box.max.z + box.min.z) / 2;
    const sx = Math.max(box.max.x - box.min.x, 1);
    const sz = Math.max(box.max.z - box.min.z, 1);

    if (this.plinth) {
      this.mapGroup.remove(this.plinth);
      this.plinth.geometry.dispose();
    } else {
      this.plinthMat = new THREE.MeshStandardMaterial({
        color: 0x121a22,
        roughness: 0.9,
        metalness: 0,
        transparent: true,
        opacity: 0.85,
      });
      installSurfaceProjectionMaterial(this.plinthMat);
    }
    this.plinth = new THREE.Mesh(new THREE.BoxGeometry(sx * 1.12, PLINTH_HEIGHT, sz * 1.12), this.plinthMat!);
    this.plinth.position.set(cx, PLINTH_TOP_Y - PLINTH_HEIGHT / 2, cz);
    this.plinth.userData.matchUnit = this;
    this.plinth.layers.enable(1); // picked via a layer-1 raycaster only
    this.mapGroup.add(this.plinth);

    this.plaque.position.set(cx, 2.6, cz);
    this._localBounds.set(
      new THREE.Vector3(cx - sx * 0.56, PLINTH_TOP_Y - PLINTH_HEIGHT, cz - sz * 0.56),
      new THREE.Vector3(cx + sx * 0.56, 1.0, cz + sz * 0.56)
    );

    this.clearSurfaceProjections();
    this.clearProjectiles();
    this.pendingShots.length = 0;
    this.recentDamageTargets.length = 0;
    this.invalidateProjectionSurfaces();
    this.loadSandbox(map.mapId, cx, cz, sx, sz);
  }

  /**
   * If this map has a registered 3D sandbox model, load it (async), fit it to the
   * footprint, and swap out the wireframe. Guards against the unit being disposed
   * or the map changing again before the load resolves.
   */
  private loadSandbox(
    mapId: string | number | undefined,
    cx: number,
    cz: number,
    sx: number,
    sz: number
  ): void {
    if (this.model) {
      this.mapGroup.remove(this.model.object);
      disposeMapModel(this.model);
      this.model = null;
      this.sandboxCalibration = { scaleZ: 1, positionZ: 0 };
      this.clearSurfaceProjections();
      this.invalidateProjectionSurfaces();
    }
    this.setLinesVisible(true);
    const def = mapModelFor(mapId);
    const loadId = ++this.modelLoadId;
    if (!def) return;
    loadMapModel(def)
      .then((m) => {
        if (this.disposed || loadId !== this.modelLoadId) {
          disposeMapModel(m);
          return;
        }
        // Auto-orient: if the model's long axis is perpendicular to the field's
        // (footprint X-long vs the bounds being Z-long, or vice versa), spin it 90°
        // so the arena lines up with the observed world-position attributes.
        const modelX = m.footprint.x;
        const modelZ = m.footprint.z;
        let worldX = modelX;
        let worldZ = modelZ;
        const rotatedForFit = modelX > modelZ !== sx > sz;
        if (rotatedForFit) {
          m.object.rotation.y += Math.PI / 2;
          [worldX, worldZ] = [modelZ, modelX];
        }

        let scaleX = rotatedForFit ? sz / modelX : sx / worldX;
        const scaleY = (sx / worldX + sz / worldZ) / 2;
        let scaleZ = rotatedForFit ? sx / modelZ : sz / worldZ;
        if (m.mirrorLongAxis) {
          // Final long axis is world Z. With a 90° auto-rotation, local Z maps to
          // world X; otherwise local X maps to world X.
          if (rotatedForFit) scaleZ *= -1;
          else scaleX *= -1;
        }
        m.object.scale.set(scaleX, scaleY, scaleZ);
        const sink = m.sinkMeters;
        m.object.position.set(cx, -sink, cz);
        const fittedObject = m.object;
        const calibrationRoot = new THREE.Group();
        calibrationRoot.add(fittedObject);
        m.object = calibrationRoot;
        this.sandboxCalibration = { scaleZ: 1, positionZ: 0 };
        if (this.plinth) {
          const modelPlinthTop = -sink - 0.05;
          this.plinth.position.y = modelPlinthTop - PLINTH_HEIGHT / 2;
          this._localBounds.min.y = Math.min(
            this._localBounds.min.y,
            modelPlinthTop - PLINTH_HEIGHT
          );
        }
        this.applyStateToModel(m.material);
        installSurfaceProjectionMaterial(m.material);
        this.mapGroup.add(m.object);
        this.model = m;
        this.applySandboxBaseCalibration();
        clearSurfaceProjectionMaterial(this.plinthMat);
        this.surfaceProjectionActive = false;
        this.invalidateProjectionSurfaces();
        this.setLinesVisible(false); // the model replaces the oval wireframe
        this._localBounds.min.y = Math.min(this._localBounds.min.y, -sink);
        this._localBounds.max.y = Math.max(this._localBounds.max.y, m.footprint.y * scaleY - sink);
        this.onBoundsChange?.();
      })
      .catch((err) => console.error('[gsm] map model load failed:', err));
  }

  private setLinesVisible(visible: boolean): void {
    for (const line of this.lines) line.visible = visible;
  }

  private applyStateToModel(mat = this.model?.material): void {
    if (!mat) return;
    const s = this.state;
    mat.opacity = s === 'focused' ? 1 : s === 'dim' ? 0.4 : 0.92;
    mat.emissive.setHex(s === 'focused' ? 0x10202c : 0x000000);
  }

  private clearSurfaceProjections(): void {
    this.surfaceProjections.length = 0;
    if (!this.surfaceProjectionActive) return;
    clearSurfaceProjectionMaterial(this.model?.material ?? null);
    clearSurfaceProjectionMaterial(this.plinthMat);
    this.surfaceProjectionActive = false;
  }

  private invalidateProjectionSurfaces(): void {
    for (const viz of this.vehicles.values()) {
      viz.projectionSurfaceValid = false;
      viz.projectionSurfaceUpdatedAt = -Infinity;
    }
  }

  private flushSurfaceProjections(): void {
    const targetMaterial = this.model?.material ?? this.plinthMat;
    if (!targetMaterial) return;
    updateSurfaceProjectionMaterial(
      targetMaterial,
      this.root,
      this.surfaceProjections,
      PROJECTION_RING_INNER,
      PROJECTION_RING_OUTER,
      PROJECTION_RING_OPACITY
    );
    if (this.model) clearSurfaceProjectionMaterial(this.plinthMat);
    this.surfaceProjectionActive = this.surfaceProjections.length > 0;
  }

  updateSnapshot(snap: WorldSnapshot): void {
    const now = performance.now();
    const seen = new Set<number>();
    const damagedThisFrame: DamageTarget[] = [];
    const dartBlindStarts: VehicleState[] = [];
    for (const v of snap.vehicles) {
      seen.add(v.id);
      let viz = this.vehicles.get(v.id);
      if (!viz) viz = this.createVehicle(v);
      const prev = viz.lastV;
      this.applyVehicle(viz, v);
      const damage = prev ? this.damageAmount(prev, v) : 0;
      if (damage > 0) {
        damagedThisFrame.push({ id: v.id, viz, vehicle: v, amount: damage, seenAt: now });
      }
      if (prev && !this.hasBuff(prev, 'blind') && this.hasBuff(v, 'blind')) {
        dartBlindStarts.push(v);
      }
      viz.lastSeen = now;
    }
    for (const target of dartBlindStarts) this.spawnDartStrikeForTarget(target, snap.vehicles, now);
    this.addRecentDamageTargets(damagedThisFrame, now);
    this.resolvePendingShots(now);
    for (const [id, viz] of this.vehicles) {
      if (!seen.has(id) || now - viz.lastSeen > STALE_MS) {
        this.removeVehicle(viz);
        this.vehicles.delete(id);
      }
    }
    this.updateBaseAnchors(snap);
  }

  private updateBaseAnchors(snap: WorldSnapshot): void {
    this.hasBaseAnchorRed = false;
    this.hasBaseAnchorBlue = false;
    for (const v of snap.vehicles) {
      if (v.kind !== 'base') continue;
      if (v.team === 'red') {
        ueToThree(v.pos, this.baseAnchorRed);
        this.hasBaseAnchorRed = true;
      } else if (v.team === 'blue') {
        ueToThree(v.pos, this.baseAnchorBlue);
        this.hasBaseAnchorBlue = true;
      }
    }
    this.applySandboxBaseCalibration();
  }

  private applySandboxBaseCalibration(): void {
    const anchors = this.model?.baseAnchorZ;
    if (!anchors || !this.hasBaseAnchorRed || !this.hasBaseAnchorBlue) {
      this.applySandboxCalibration(1, 0);
      return;
    }

    const nominalSpan = anchors.red - anchors.blue;
    const liveSpan = this.baseAnchorRed.z - this.baseAnchorBlue.z;
    if (Math.abs(nominalSpan) < 1e-3) {
      this.applySandboxCalibration(1, 0);
      return;
    }

    const scaleZ = liveSpan / nominalSpan;
    const positionZ = this.baseAnchorBlue.z - scaleZ * anchors.blue;
    if (
      !Number.isFinite(scaleZ) ||
      !Number.isFinite(positionZ) ||
      scaleZ < 0.5 ||
      scaleZ > 1.5
    ) {
      this.applySandboxCalibration(1, 0);
      return;
    }

    this.applySandboxCalibration(scaleZ, positionZ);
  }

  private applySandboxCalibration(scaleZ: number, positionZ: number): void {
    const changed =
      Math.abs(this.sandboxCalibration.scaleZ - scaleZ) > SANDBOX_CALIBRATION_EPS ||
      Math.abs(this.sandboxCalibration.positionZ - positionZ) > SANDBOX_CALIBRATION_EPS;
    this.sandboxCalibration = { scaleZ, positionZ };
    if (!this.model) return;
    this.model.object.scale.z = scaleZ;
    this.model.object.position.z = positionZ;
    if (changed) {
      this.invalidateProjectionSurfaces();
      for (const viz of this.vehicles.values()) {
        if (viz.lastV && buildingModelKind(viz.lastV)) this.snapBuildingToSurface(viz.tgtPos);
      }
      if (this.surfaceProjectionActive) this.flushSurfaceProjections();
    }
  }

  /** Advance interpolation toward the latest snapshot. Called every frame. */
  update(dt: number): void {
    const alpha = 1 - Math.exp(-SMOOTH * dt);
    const now = performance.now();
    this.root.updateWorldMatrix(true, true);
    const showProjection = this.state === 'focused';
    this.surfaceProjections.length = 0;
    for (const viz of this.vehicles.values()) {
      if (!viz.placed) continue;
      if (now - viz.lastSeen > STALE_MS) continue;
      viz.curPos.lerp(viz.tgtPos, alpha);
      viz.curQuat.slerp(viz.tgtQuat, alpha);
      viz.group.position.copy(viz.curPos);
      viz.group.quaternion.copy(viz.curQuat);
      this.applyBuildingPlacement(viz);
      if (viz.buildingModel) {
        updateBuildingModel(
          viz.buildingModel,
          now * 0.001,
          buildingDestroyed(viz.lastV),
          buildingDeployed(viz.lastV)
        );
      }
      viz.bodyCorruptionUniforms.time.value = now * 0.001 + viz.group.id * 0.017;
      if (this.state === 'focused' && viz.panel && viz.lastV && vehicleDefeated(viz.lastV)) {
        this.updatePanel(viz, viz.lastV, now);
      }
      const showUnitProjection = showProjection && !(viz.lastV && buildingModelKind(viz.lastV));
      if (showUnitProjection) {
        if (
          this.updateProjection(viz, now) &&
          this.surfaceProjections.length < MAX_SURFACE_PROJECTIONS
        ) {
          const projection = this.surfaceProjectionPool[this.surfaceProjections.length];
          projection.x = viz.curPos.x;
          projection.z = viz.curPos.z;
          projection.color = teamColor(viz.lastTeam);
          this.surfaceProjections.push(projection);
        }
      } else viz.projectionLine.visible = false;
    }
    if (showProjection) this.flushSurfaceProjections();
    else this.clearSurfaceProjections();
    this.updateProjectiles(now);
    for (const [id, viz] of this.vehicles) {
      if (now - viz.lastSeen > STALE_MS) {
        this.removeVehicle(viz);
        this.vehicles.delete(id);
      }
    }
  }

  setState(state: UnitState): void {
    if (this.state === state) return;
    this.state = state;
    const focused = state === 'focused';
    // Plaque (overview title) shows in normal/dim; the per-vehicle panels replace it when focused.
    this.plaque.visible = !focused;
    this.lineMat.color.setHex(
      focused ? LINE_FOCUSED : state === 'dim' ? LINE_DIM : LINE_NORMAL
    );
    this.lineMat.opacity = focused ? OPACITY_FOCUSED : state === 'dim' ? OPACITY_DIM : OPACITY_NORMAL;
    this.plinthMat?.emissive.setHex(focused ? 0x10202c : 0x000000);
    this.applyStateToModel();
    if (!focused) this.clearSurfaceProjections();
    for (const viz of this.vehicles.values()) {
      this.applyProjectionStyle(viz);
      this.applyBodyStyle(viz);
      this.applyBuildingStyle(viz);
      if (focused) {
        this.ensurePanel(viz);
        if (viz.lastV) this.updatePanel(viz, viz.lastV);
      } else if (viz.label?.parent) {
        viz.group.remove(viz.label);
      }
    }
  }

  private updateProjectiles(now: number): void {
    const stateOpacity = this.state === 'dim' ? 0.22 : this.state === 'normal' ? 0.72 : 1;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const elapsed = now - p.bornAt;
      if (elapsed >= p.ttl) {
        this.removeProjectile(p);
        this.projectiles.splice(i, 1);
        continue;
      }

      const headU = Math.min(1, elapsed / p.travelMs);
      const trailU =
        p.trajectory === 'arc'
          ? Math.min(0.22, Math.max(0.08, PROJECTILE_TRAIL_LENGTH / Math.max(p.distance, 1)))
          : Math.min(1, PROJECTILE_TRAIL_LENGTH / Math.max(p.distance, 0.001));
      const tailU = Math.max(0, headU - trailU);
      for (let sample = 0; sample <= p.trailSamples; sample++) {
        const s = p.trailSamples === 0 ? 1 : sample / p.trailSamples;
        const u = tailU + (headU - tailU) * s;
        const point = this.projectilePointAt(p, u, new THREE.Vector3());
        p.trailPos.setXYZ(sample, point.x, point.y, point.z);
      }
      p.trailPos.needsUpdate = true;

      const postImpact = Math.max(0, elapsed - p.travelMs);
      const lineFade =
        elapsed <= p.travelMs ? 1 : Math.max(0, 1 - postImpact / PROJECTILE_TRAIL_FADE_MS);
      p.trail.visible = lineFade > 0.02;
      p.trail.material.opacity = p.trailOpacity * lineFade * stateOpacity;
      if (p.beam) {
        p.beam.visible = p.trail.visible;
        p.beam.material.opacity = p.trailOpacity * 0.5 * lineFade * stateOpacity;
        if (p.beam.visible) {
          this.projectilePointAt(p, tailU, this.tmpProjectileBeamTail);
          this.projectilePointAt(p, headU, this.tmpProjectileBeamHead);
          this.updateProjectileBeam(p.beam, this.tmpProjectileBeamTail, this.tmpProjectileBeamHead);
        }
      }
      if (p.sparks) this.updateSparkBurst(p.sparks, now, stateOpacity);
      if (p.explosion) this.updateExplosionBurst(p.explosion, now, stateOpacity);
    }
  }

  private updateProjectileBeam(
    beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>,
    tail: THREE.Vector3,
    head: THREE.Vector3
  ): void {
    this.tmpProjectileDir.subVectors(head, tail);
    const length = this.tmpProjectileDir.length();
    if (length < 0.001) {
      beam.visible = false;
      return;
    }
    this.tmpProjectileBeamMid.addVectors(tail, head).multiplyScalar(0.5);
    this.tmpProjectileDir.multiplyScalar(1 / length);
    beam.position.copy(this.tmpProjectileBeamMid);
    beam.quaternion.copy(
      this.tmpProjectileBeamQuat.setFromUnitVectors(MatchUnit.UP, this.tmpProjectileDir)
    );
    beam.scale.set(1, length, 1);
  }

  private updateSparkBurst(burst: SparkBurst, now: number, stateOpacity: number): void {
    if (now < burst.bornAt) {
      burst.line.visible = false;
      return;
    }
    burst.line.visible = true;
    const u = (now - burst.bornAt) / burst.ttl;
    if (u >= 1) {
      burst.line.material.opacity = 0;
      return;
    }

    const seconds = (now - burst.bornAt) / 1000;
    const fade = Math.pow(1 - u, 1.8) * stateOpacity;
    burst.line.material.opacity = burst.opacity * fade;
    const positions = burst.positionAttr.array as Float32Array;
    for (let i = 0; i < burst.velocities.length; i++) {
      const vel = burst.velocities[i];
      const len = Math.max(vel.length(), 0.0001);
      const tailLen = burst.lengths[i] * (1 - u);
      const headX = burst.origin.x + vel.x * seconds;
      const headY = burst.origin.y + vel.y * seconds;
      const headZ = burst.origin.z + vel.z * seconds;
      const base = i * 6;
      positions[base] = headX;
      positions[base + 1] = headY;
      positions[base + 2] = headZ;
      positions[base + 3] = headX - (vel.x / len) * tailLen;
      positions[base + 4] = headY - (vel.y / len) * tailLen;
      positions[base + 5] = headZ - (vel.z / len) * tailLen;
    }
    burst.positionAttr.needsUpdate = true;
  }

  private createExplosionBurst(
    point: THREE.Vector3,
    color: number,
    size: Exclude<ExplosionSize, 'none'>,
    bornAt: number
  ): ExplosionBurst {
    const ttl = size === 'large' ? EXPLOSION_LARGE_TTL_MS : EXPLOSION_SMALL_TTL_MS;
    const radius = size === 'large' ? 1.9 : 0.9;
    const opacity = size === 'large' ? 0.82 : 0.72;
    const group = new THREE.Group();
    group.position.copy(point);
    group.visible = false;

    const rings: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
    const makeRing = (rotation: [number, number, number], scale: number): void => {
      const points: THREE.Vector3[] = [];
      const segments = 56;
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.Line(geo, mat);
      ring.rotation.set(rotation[0], rotation[1], rotation[2]);
      ring.scale.setScalar(scale);
      ring.frustumCulled = false;
      rings.push(ring);
      group.add(ring);
    };

    makeRing([0, 0, 0], radius);
    makeRing([Math.PI / 2, 0, 0], radius * 0.72);
    if (size === 'large') makeRing([0, 0, Math.PI / 2], radius * 0.58);

    return { group, rings, bornAt, ttl, radius, opacity };
  }

  private updateExplosionBurst(explosion: ExplosionBurst, now: number, stateOpacity: number): void {
    if (now < explosion.bornAt) {
      explosion.group.visible = false;
      return;
    }
    const u = (now - explosion.bornAt) / explosion.ttl;
    if (u >= 1) {
      explosion.group.visible = false;
      return;
    }
    explosion.group.visible = true;
    const pulse = 0.34 + u * 1.28;
    const fade = Math.pow(1 - u, 1.45) * stateOpacity;
    for (let i = 0; i < explosion.rings.length; i++) {
      const ring = explosion.rings[i];
      const ripple = 1 + i * 0.18 + Math.sin((u + i * 0.14) * Math.PI) * 0.08;
      ring.scale.setScalar(explosion.radius * pulse * ripple);
      ring.material.opacity = explosion.opacity * fade * (i === 0 ? 1 : 0.72);
    }
  }

  private clearProjectiles(): void {
    for (const p of this.projectiles) this.removeProjectile(p);
    this.projectiles.length = 0;
  }

  private removeProjectile(p: ProjectileViz): void {
    this.root.remove(p.group);
    p.trail.geometry.dispose();
    p.trail.material.dispose();
    if (p.beam) {
      p.beam.geometry.dispose();
      p.beam.material.dispose();
    }
    if (p.sparks) {
      p.sparks.line.geometry.dispose();
      p.sparks.line.material.dispose();
    }
    if (p.explosion) {
      for (const ring of p.explosion.rings) {
        ring.geometry.dispose();
        ring.material.dispose();
      }
    }
  }

  get center(): THREE.Vector3 {
    return this._localBounds.getCenter(new THREE.Vector3()).add(this.root.position);
  }

  get localBounds(): THREE.Box3 {
    return this._localBounds;
  }

  worldBounds(target = new THREE.Box3()): THREE.Box3 {
    // Valid because root carries only translation (no rotation/scale).
    return target.copy(this._localBounds).translate(this.root.position);
  }

  get pickTargets(): THREE.Object3D[] {
    return this.plinth ? [this.plinth] : [];
  }

  dispose(): void {
    this.disposed = true;
    this.clearSurfaceProjections();
    this.clearProjectiles();
    this.pendingShots.length = 0;
    this.recentDamageTargets.length = 0;
    if (this.model) {
      this.mapGroup.remove(this.model.object);
      disposeMapModel(this.model);
      this.model = null;
    }
    for (const viz of this.vehicles.values()) this.removeVehicle(viz);
    this.vehicles.clear();
    for (const line of this.lines) line.geometry.dispose();
    this.lines = [];
    this.lineMat.dispose();
    if (this.plinth) {
      this.mapGroup.remove(this.plinth);
      this.plinth.geometry.dispose();
    }
    this.plinthMat?.dispose();
    this.plaqueEl.remove();
    this.root.remove(this.plaque);
  }

  private createVehicle(v: VehicleState): VehicleViz {
    const group = new THREE.Group();
    const color = teamColor(v.team);
    const bodyCorruptionUniforms = createSurfaceCorruptionUniforms();
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.05,
      transparent: true,
      opacity: 1,
      depthWrite: true,
    });
    bodyMaterial.toneMapped = false;
    installSurfaceCorruptionMaterial(bodyMaterial, bodyCorruptionUniforms, 'vehicle-body');
    const body = new THREE.Mesh(this.shared.bodyGeo, bodyMaterial);
    group.add(body);
    this.root.add(group);

    const projectionGeo = new THREE.BufferGeometry();
    const projectionLinePos = new THREE.BufferAttribute(new Float32Array(6), 3);
    projectionGeo.setAttribute('position', projectionLinePos);
    const projectionLine = new THREE.Line(
      projectionGeo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.42 })
    );
    projectionLine.frustumCulled = false;
    this.root.add(projectionLine);

    const viz: VehicleViz = {
      group,
      body,
      bodyCorruptionUniforms,
      buildingKind: null,
      buildingModel: null,
      buildingLoadId: 0,
      projectionLine,
      projectionLinePos,
      projectionSurfaceY: 0,
      projectionSurfaceX: 0,
      projectionSurfaceZ: 0,
      projectionSurfaceUpdatedAt: -Infinity,
      projectionSurfaceValid: false,
      curPos: new THREE.Vector3(),
      curQuat: new THREE.Quaternion(),
      tgtPos: new THREE.Vector3(),
      tgtQuat: new THREE.Quaternion(),
      placed: false,
      lastSeen: 0,
      lastTeam: v.team,
      lastV: null,
      defeatedSince: null,
      label: null,
      panel: null,
      lastShotAt: -Infinity,
    };
    this.vehicles.set(v.id, viz);
    this.applyProjectionStyle(viz);
    return viz;
  }

  private syncBuildingModel(viz: VehicleViz, v: VehicleState): void {
    const kind = buildingModelKind(v);
    if (kind === viz.buildingKind) {
      this.applyBuildingStyle(viz);
      return;
    }

    this.disposeVehicleBuilding(viz);
    viz.buildingKind = kind;
    if (!kind) return;

    const loadId = viz.buildingLoadId;
    loadBuildingModel(kind)
      .then((model) => {
        if (
          this.disposed ||
          viz.buildingLoadId !== loadId ||
          viz.buildingKind !== kind
        ) {
          disposeBuildingModel(model);
          return;
        }
        viz.group.add(model.object);
        viz.buildingModel = model;
        this.applyBuildingPlacement(viz);
        viz.body.visible = false;
        this.applyBuildingStyle(viz);
      })
      .catch((err) => console.error('[gsm] building model load failed:', err));
  }

  private applyBuildingStyle(viz: VehicleViz): void {
    if (!viz.buildingModel) return;
    styleBuildingModel(
      viz.buildingModel,
      teamColor(viz.lastTeam),
      this.state,
      buildingDestroyed(viz.lastV)
    );
  }

  private applyBodyStyle(viz: VehicleViz): void {
    const mat = viz.body.material as THREE.MeshStandardMaterial;
    const destroyed = robotDestroyed(viz.lastV);
    const color = destroyed ? 0x8d969b : teamColor(viz.lastTeam);
    const opacity = destroyed
      ? this.state === 'focused' ? 0.38 : this.state === 'dim' ? 0.12 : 0.28
      : 1;
    mat.color.setHex(color);
    mat.emissive.setHex(destroyed ? 0x7f898e : 0x000000);
    mat.emissiveIntensity = destroyed
      ? this.state === 'focused' ? 0.28 : this.state === 'dim' ? 0.06 : 0.16
      : 0;
    mat.opacity = opacity;
    mat.depthWrite = !destroyed;
    viz.body.scale.setScalar(destroyed ? 0.88 : 1);
    viz.bodyCorruptionUniforms.active.value = destroyed ? 1 : 0;
    viz.bodyCorruptionUniforms.intensity.value = destroyed
      ? this.state === 'focused' ? 0.9 : this.state === 'dim' ? 0.28 : 0.62
      : 0;
  }

  private applyBuildingPlacement(viz: VehicleViz): void {
    if (!viz.buildingModel) return;
    const offset = viz.buildingModel.worldOffset;
    if (offset.lengthSq() === 0) {
      viz.buildingModel.object.position.set(0, 0, 0);
      return;
    }
    this.tmpBuildingOffset
      .copy(offset)
      .applyQuaternion(this.tmpQuat.copy(viz.group.quaternion).invert());
    viz.buildingModel.object.position.copy(this.tmpBuildingOffset);
  }

  private disposeVehicleBuilding(viz: VehicleViz): void {
    viz.buildingLoadId++;
    if (!viz.buildingModel) {
      viz.body.visible = true;
      this.applyBodyStyle(viz);
      return;
    }
    viz.group.remove(viz.buildingModel.object);
    disposeBuildingModel(viz.buildingModel);
    viz.buildingModel = null;
    viz.body.visible = true;
    this.applyBodyStyle(viz);
  }

  private applyVehicle(viz: VehicleViz, v: VehicleState): void {
    ueToThree(v.pos, viz.tgtPos);
    if (buildingModelKind(v)) this.snapBuildingToSurface(viz.tgtPos);
    if (typeof v.yaw === 'number') {
      const a = THREE.MathUtils.degToRad(v.yaw);
      // Heading as a direction in three-space, then the same orientation
      // Object3D.lookAt would produce (local +Z points along the heading).
      ueToThree({ x: Math.cos(a), y: Math.sin(a), z: 0 }, this.tmpDir);
      this.tmpMat.lookAt(this.tmpDir, MatchUnit.ORIGIN, MatchUnit.UP);
      viz.tgtQuat.setFromRotationMatrix(this.tmpMat);
    }
    if (!viz.placed) {
      viz.curPos.copy(viz.tgtPos);
      viz.curQuat.copy(viz.tgtQuat);
      viz.group.position.copy(viz.curPos);
      viz.group.quaternion.copy(viz.curQuat);
      viz.placed = true;
    }
    const wasDefeated = vehicleDefeated(viz.lastV);
    const isDefeated = vehicleDefeated(v);
    if (isDefeated && (!wasDefeated || viz.defeatedSince == null)) {
      viz.defeatedSince = performance.now();
    } else if (!isDefeated) {
      viz.defeatedSince = null;
    }
    const teamChanged = v.team !== viz.lastTeam;
    if (teamChanged) {
      viz.lastTeam = v.team;
      this.applyProjectionStyle(viz);
    }
    this.queueProjectileShot(viz, v);
    viz.lastV = v;
    this.applyBodyStyle(viz);
    this.syncBuildingModel(viz, v);
    if (this.state === 'focused') {
      this.ensurePanel(viz);
      this.updatePanel(viz, v);
    }
  }

  private queueProjectileShot(viz: VehicleViz, v: VehicleState): void {
    const prev = viz.lastV;
    if (!prev || prev.kind !== 'robot' || v.kind !== 'robot') return;
    if (vehicleDefeated(prev) || vehicleDefeated(v)) return;
    const totalDrop =
      typeof prev.ammo === 'number' && typeof v.ammo === 'number' ? prev.ammo - v.ammo : 0;
    const ammo42Drop =
      typeof prev.ammo42 === 'number' && typeof v.ammo42 === 'number'
        ? prev.ammo42 - v.ammo42
        : 0;
    const heroLob = v.classId === CLASS_HERO && v.deployed === true && ammo42Drop >= 0.9;
    if (heroLob ? ammo42Drop > 4 : totalDrop < 0.9 || totalDrop > 16) return;

    const now = performance.now();
    if (now - viz.lastShotAt < PROJECTILE_MIN_INTERVAL_MS) return;

    const preferredTarget = heroLob ? this.findEnemyBaseTarget(v) : null;
    const preferredEnd = preferredTarget
      ? this.targetAimPoint(preferredTarget, new THREE.Vector3())
      : null;
    const dir = preferredEnd
      ? preferredEnd.clone().sub(viz.placed ? viz.group.position : viz.tgtPos).normalize()
      : this.projectileDirection(v, new THREE.Vector3());
    this.pendingShots.push({
      viz,
      vehicle: v,
      start: this.projectileMuzzlePoint(viz, dir, new THREE.Vector3()),
      dir: dir.clone(),
      fallbackEnd: preferredEnd?.clone(),
      bornAt: now,
      kind: heroLob ? 'hero-lob' : 'direct',
      explosionSize: heroLob ? 'small' : 'none',
    });
    viz.lastShotAt = now;
  }

  private spawnProjectile(shot: PendingShot, impact: ProjectileImpact | null, now: number): void {
    const heroDirect = shot.kind === 'direct' && shot.vehicle.classId === CLASS_HERO;
    const start = shot.start.clone();
    const fallbackEnd = shot.fallbackEnd?.clone();
    let end: THREE.Vector3;
    if (shot.kind === 'hero-lob' && fallbackEnd) {
      end = fallbackEnd;
    } else if (impact) {
      end = impact.point.clone();
    } else {
      end =
        fallbackEnd ??
        start.clone().addScaledVector(shot.dir, this.projectileMissDistance(shot.kind));
    }
    const distance = Math.max(0.001, start.distanceTo(end));
    const allowMissImpact = shot.explosionSize !== 'none' && shot.kind !== 'hero-lob';
    const visualImpact =
      impact ??
      (allowMissImpact
        ? { point: end.clone(), normal: MatchUnit.UP.clone(), distance }
        : null);
    const trajectory = shot.kind === 'direct' ? 'line' : 'arc';
    const travelMs =
      trajectory === 'arc'
        ? this.arcTravelMs(shot.kind, start, end)
        : THREE.MathUtils.clamp(
            (distance / PROJECTILE_SPEED) * 1000,
            PROJECTILE_MIN_TRAVEL_MS,
            PROJECTILE_MAX_TRAVEL_MS
          );
    const arcHeight = trajectory === 'arc' ? this.arcHeight(shot.kind, distance) : 0;
    const trailSamples = trajectory === 'arc' ? ARC_TRAIL_SAMPLES : 1;
    const trailOpacity = heroDirect ? HERO_DIRECT_TRAIL_OPACITY : PROJECTILE_TRAIL_OPACITY;

    const trailGeo = new THREE.BufferGeometry();
    const trailPos = new THREE.BufferAttribute(new Float32Array((trailSamples + 1) * 3), 3);
    for (let i = 0; i <= trailSamples; i++) trailPos.setXYZ(i, start.x, start.y, start.z);
    trailGeo.setAttribute('position', trailPos);
    const trailMat = new THREE.LineBasicMaterial({
      color: teamColor(shot.vehicle.team),
      transparent: true,
      opacity: trailOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const trail = new THREE.Line(trailGeo, trailMat);
    trail.frustumCulled = false;
    const beam = heroDirect
      ? new THREE.Mesh(
          new THREE.CylinderGeometry(
            HERO_DIRECT_BEAM_RADIUS,
            HERO_DIRECT_BEAM_RADIUS,
            1,
            10,
            1,
            true
          ),
          new THREE.MeshBasicMaterial({
            color: teamColor(shot.vehicle.team),
            transparent: true,
            opacity: trailOpacity * 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          })
        )
      : null;
    if (beam) {
      beam.frustumCulled = false;
      beam.visible = false;
    }

    const impactAt = now + travelMs;
    const sparkScale =
      heroDirect && (visualImpact?.damageAmount ?? 0) > HERO_BIG_SPARK_DAMAGE
        ? HERO_BIG_SPARK_SCALE
        : 1;
    const sparks = visualImpact
      ? this.createSparkBurst(
          visualImpact.point,
          visualImpact.normal,
          shot.dir,
          shot.vehicle,
          impactAt,
          sparkScale
        )
      : null;
    const explosion =
      visualImpact && shot.explosionSize !== 'none'
        ? this.createExplosionBurst(
            visualImpact.point,
            teamColor(shot.vehicle.team),
            shot.explosionSize,
            impactAt
          )
        : null;
    const group = new THREE.Group();
    group.add(trail);
    if (beam) group.add(beam);
    if (sparks) group.add(sparks.line);
    if (explosion) group.add(explosion.group);
    this.root.add(group);
    this.projectiles.push({
      group,
      trail,
      trailPos,
      trailSamples,
      beam,
      sparks,
      explosion,
      start,
      end,
      distance,
      travelMs,
      trajectory,
      arcHeight,
      trailOpacity,
      bornAt: now,
      ttl:
        travelMs +
        Math.max(
          PROJECTILE_SPARK_TTL_MS,
          shot.explosionSize === 'large' ? EXPLOSION_LARGE_TTL_MS : EXPLOSION_SMALL_TTL_MS
        ) +
        80,
    });
  }

  private projectileDirection(v: VehicleState, target: THREE.Vector3): THREE.Vector3 {
    const yaw = THREE.MathUtils.degToRad(v.turretYaw ?? v.yaw ?? 0);
    const pitch = THREE.MathUtils.degToRad(
      THREE.MathUtils.clamp(v.turretPitch ?? -6, -50, 22)
    );
    const cp = Math.cos(pitch);
    return target.set(-Math.cos(yaw) * cp, Math.sin(pitch), -Math.sin(yaw) * cp).normalize();
  }

  private projectilePointAt(p: ProjectileViz, u: number, out: THREE.Vector3): THREE.Vector3 {
    const t = THREE.MathUtils.clamp(u, 0, 1);
    out.lerpVectors(p.start, p.end, t);
    if (p.trajectory === 'arc') out.y += 4 * p.arcHeight * t * (1 - t);
    return out;
  }

  private arcTravelMs(kind: ShotKind, start: THREE.Vector3, end: THREE.Vector3): number {
    const horizontal = Math.hypot(end.x - start.x, end.z - start.z);
    if (kind === 'dart') {
      return THREE.MathUtils.clamp(
        (horizontal / DART_SPEED) * 1000,
        DART_MIN_TRAVEL_MS,
        DART_MAX_TRAVEL_MS
      );
    }
    return THREE.MathUtils.clamp(
      (horizontal / HERO_LOB_SPEED) * 1000,
      HERO_LOB_MIN_TRAVEL_MS,
      HERO_LOB_MAX_TRAVEL_MS
    );
  }

  private arcHeight(kind: ShotKind, distance: number): number {
    return kind === 'dart'
      ? Math.max(DART_ARC_MIN, distance * 0.34)
      : Math.max(HERO_LOB_ARC_MIN, distance * 0.24);
  }

  private projectileMissDistance(kind: ShotKind): number {
    if (kind === 'hero-lob') return 12;
    if (kind === 'dart') return 16;
    return PROJECTILE_MISS_MAX;
  }

  private projectileMuzzlePoint(
    viz: VehicleViz,
    dir: THREE.Vector3,
    target: THREE.Vector3
  ): THREE.Vector3 {
    const flat = this.tmpProjectileFlat.set(dir.x, 0, dir.z);
    if (flat.lengthSq() < 1e-5) flat.set(0, 0, 1);
    else flat.normalize();
    return target
      .copy(viz.placed ? viz.group.position : viz.tgtPos)
      .addScaledVector(flat, PROJECTILE_MUZZLE_FORWARD)
      .addScaledVector(MatchUnit.UP, PROJECTILE_MUZZLE_HEIGHT);
  }

  private damageAmount(prev: VehicleState, next: VehicleState): number {
    const oldHealth = this.healthValue(prev);
    const newHealth = this.healthValue(next);
    if (oldHealth == null || newHealth == null) return 0;
    return Math.max(0, oldHealth - newHealth);
  }

  private healthValue(v: VehicleState): number | null {
    if (typeof v.hp === 'number') return v.hp;
    if (typeof v.health !== 'number') return null;
    return v.health * (typeof v.hpMax === 'number' && v.hpMax > 0 ? v.hpMax : 1000);
  }

  private hasBuff(v: VehicleState, key: string): boolean {
    return (v.buffs ?? []).includes(key);
  }

  private spawnDartStrikeForTarget(
    blindedTarget: VehicleState,
    vehicles: VehicleState[],
    now: number
  ): void {
    const source = this.findDartSourceForTarget(blindedTarget, vehicles);
    const target =
      source?.target ??
      (this.isDartStructureTarget(blindedTarget)
        ? blindedTarget
        : this.findDartStructureTarget(blindedTarget));
    const targetViz = this.vehicles.get(target.id);
    if (!targetViz) return;
    this.spawnDartStrike(source?.viz ?? targetViz, source?.vehicle, targetViz, target, now);
  }

  private findDartSourceForTarget(
    target: VehicleState,
    vehicles: VehicleState[]
  ): { vehicle: VehicleState; viz: VehicleViz; target: VehicleState } | null {
    let fallback: { vehicle: VehicleState; viz: VehicleViz; target: VehicleState } | null = null;
    for (const vehicle of vehicles) {
      if (vehicle.classId !== CLASS_AERIAL || vehicle.dartTargetId == null) continue;
      const resolvedTarget = vehicles.find((v) => v.id === vehicle.dartTargetId);
      if (!resolvedTarget) continue;
      if (!this.isDartStructureTarget(resolvedTarget)) continue;
      const viz = this.vehicles.get(vehicle.id);
      if (!viz) continue;
      const candidate = { vehicle, viz, target: resolvedTarget };
      if (resolvedTarget.id !== target.id) {
        fallback ??= candidate;
        continue;
      }
      if (vehicle.team != null && target.team != null && vehicle.team === target.team) {
        fallback ??= candidate;
        continue;
      }
      return candidate;
    }
    return fallback?.target.id === target.id ? fallback : null;
  }

  private isDartStructureTarget(v: VehicleState): boolean {
    return (v.kind === 'outpost' || v.kind === 'base') && !vehicleDefeated(v);
  }

  private findDartStructureTarget(reference: VehicleState): VehicleState {
    let best: { vehicle: VehicleState; score: number } | null = null;
    for (const viz of this.vehicles.values()) {
      const candidate = viz.lastV;
      if (!candidate || !this.isDartStructureTarget(candidate)) continue;
      const enemy =
        reference.team != null && candidate.team != null && reference.team !== candidate.team;
      const kindScore = candidate.kind === 'outpost' ? 0 : 3;
      const teamScore = enemy ? 0 : 12;
      const score = kindScore + teamScore;
      if (!best || score < best.score) best = { vehicle: candidate, score };
    }
    return best?.vehicle ?? reference;
  }

  private spawnDartStrike(
    sourceViz: VehicleViz,
    source: VehicleState | undefined,
    targetViz: VehicleViz,
    target: VehicleState,
    now: number
  ): void {
    if (!targetViz.placed || vehicleDefeated(target)) return;
    const impactPoint = this.targetAimPoint(
      { id: target.id, viz: targetViz, vehicle: target, amount: 0, seenAt: now },
      new THREE.Vector3()
    );
    const enemyTeam = target.team === 'red' ? 'blue' : target.team === 'blue' ? 'red' : target.team;
    const owner = source ?? { ...target, team: enemyTeam };
    const sourcePoint = sourceViz.placed ? sourceViz.group.position : sourceViz.tgtPos;
    const sourceDir = new THREE.Vector3().subVectors(impactPoint, sourcePoint).normalize();
    const start =
      source && sourceViz.placed
        ? this.projectileMuzzlePoint(sourceViz, sourceDir, new THREE.Vector3())
        : impactPoint
            .clone()
            .add(
              new THREE.Vector3(
                target.team === 'red' ? 2.2 : -2.2,
                4.6,
                target.team === 'red' ? -7.5 : 7.5
              )
            );
    const dir = new THREE.Vector3().subVectors(impactPoint, start).normalize();
    this.spawnProjectile(
      {
        viz: sourceViz,
        vehicle: owner,
        start,
        dir,
        bornAt: now,
        kind: 'dart',
        explosionSize: 'large',
      },
      {
        point: impactPoint,
        normal: MatchUnit.UP.clone(),
        distance: start.distanceTo(impactPoint),
      },
      now
    );
  }

  private respawnDisplay(
    viz: VehicleViz,
    v: VehicleState,
    now = performance.now()
  ): RespawnDisplay | null {
    if (!vehicleDefeated(v)) return null;

    const explicitTotal =
      typeof v.respawnTotalMs === 'number' && v.respawnTotalMs > 0
        ? v.respawnTotalMs
        : undefined;
    const remaining =
      typeof v.respawnRemainingMs === 'number' && v.respawnRemainingMs >= 0
        ? v.respawnRemainingMs
        : undefined;
    const totalMs = THREE.MathUtils.clamp(
      Math.max(explicitTotal ?? RESPAWN_DEFAULT_MS, remaining ?? 0, RESPAWN_SEGMENT_MS),
      RESPAWN_SEGMENT_MS,
      RESPAWN_MAX_MS
    );

    let progress: number;
    let inferred = false;
    if (v.kind === 'outpost' && typeof v.repairProgress === 'number') {
      progress = THREE.MathUtils.clamp(v.repairProgress, 0, 1);
    } else if (typeof v.respawnProgress === 'number') {
      progress = clampPct(v.respawnProgress * 100) / 100;
    } else if (remaining != null) {
      progress = 1 - THREE.MathUtils.clamp(remaining / totalMs, 0, 1);
    } else {
      inferred = true;
      const startedAt = viz.defeatedSince ?? now;
      progress = THREE.MathUtils.clamp((now - startedAt) / RESPAWN_DEFAULT_MS, 0, 1);
    }

    return {
      progress,
      totalMs,
      segments: Math.max(1, Math.min(MAX_CELLS, Math.ceil(totalMs / RESPAWN_SEGMENT_MS))),
      inferred,
    };
  }

  private addRecentDamageTargets(targets: DamageTarget[], now: number): void {
    this.recentDamageTargets.push(...targets);
    this.recentDamageTargets = this.recentDamageTargets.filter(
      (target) =>
        now - target.seenAt <= PROJECTILE_DAMAGE_WINDOW_MS &&
        this.vehicles.get(target.id) === target.viz
    );
  }

  private resolvePendingShots(now: number): void {
    if (this.pendingShots.length === 0) return;
    const keep: PendingShot[] = [];
    for (const shot of this.pendingShots) {
      const impact =
        shot.kind === 'hero-lob'
          ? this.findDamagedImpact(shot, now, HERO_LOB_MIN_DAMAGE)
          : this.findDamagedImpact(shot, now);
      const expired = now - shot.bornAt >= PROJECTILE_PENDING_MS;
      if (impact) this.spawnProjectile(shot, impact, now);
      else if (!expired) keep.push(shot);
      else this.spawnProjectile(shot, null, now);
    }
    this.pendingShots = keep;
  }

  private findEnemyBaseTarget(source: VehicleState): DamageTarget | null {
    let best: DamageTarget | null = null;
    let bestDistance = Infinity;
    const sourceViz = this.vehicles.get(source.id);
    const sourcePoint = sourceViz
      ? sourceViz.placed
        ? sourceViz.group.position
        : sourceViz.tgtPos
      : MatchUnit.ORIGIN;
    for (const [id, viz] of this.vehicles) {
      const target = viz.lastV;
      if (!target || target.kind !== 'base' || vehicleDefeated(target)) continue;
      if (source.team != null && target.team != null && source.team === target.team) continue;
      const distance = (viz.placed ? viz.group.position : viz.tgtPos).distanceTo(sourcePoint);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = { id, viz, vehicle: target, amount: 0, seenAt: performance.now() };
    }
    return best;
  }

  private findDamagedImpact(
    shot: PendingShot,
    now: number,
    minimumDamage = 0
  ): ProjectileImpact | null {
    let best: { impact: ProjectileImpact; score: number } | null = null;
    for (const target of this.recentDamageTargets) {
      if (target.id === shot.vehicle.id) continue;
      if (target.amount < minimumDamage) continue;
      if (now - target.seenAt > PROJECTILE_DAMAGE_WINDOW_MS) continue;
      if (this.vehicles.get(target.id) !== target.viz) continue;

      const impact =
        shot.kind === 'hero-lob'
          ? this.approximateArcTargetImpact(shot, target)
          : this.intersectDamagedTarget(shot, target) ??
            this.approximateDamagedTargetImpact(shot, target);
      if (!impact) continue;
      const damageImpact = { ...impact, damageAmount: target.amount };

      const sameTeam =
        shot.vehicle.team != null &&
        target.vehicle.team != null &&
        shot.vehicle.team === target.vehicle.team;
      const teamPenalty = sameTeam ? 8 : 0;
      const score = damageImpact.distance + teamPenalty - Math.min(2, target.amount * 0.01);
      if (!best || score < best.score) best = { impact: damageImpact, score };
    }
    return best?.impact ?? null;
  }

  private intersectDamagedTarget(shot: PendingShot, target: DamageTarget): ProjectileImpact | null {
    this.root.updateWorldMatrix(true, true);
    this.projectileHits.length = 0;
    this.root.localToWorld(this.tmpProjectileWorld.copy(shot.start));
    this.tmpProjectileDir.copy(shot.dir).transformDirection(this.root.matrixWorld).normalize();
    this.projectileRay.set(this.tmpProjectileWorld, this.tmpProjectileDir);
    this.projectileRay.near = 0.05;
    this.projectileRay.far = PROJECTILE_HIT_MAX;

    const hitObject = target.viz.buildingModel?.object ?? target.viz.body;
    hitObject.updateWorldMatrix(true, true);
    this.projectileRay.intersectObject(hitObject, true, this.projectileHits);
    if (this.projectileHits.length === 0) return null;

    const hit = this.projectileHits[0];
    const point = hit.point.clone();
    this.root.worldToLocal(point);

    const worldNormal = this.tmpProjectileNormal;
    if (hit.face) worldNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    else worldNormal.copy(shot.dir).multiplyScalar(-1).transformDirection(this.root.matrixWorld);
    const normal = worldNormal
      .clone()
      .transformDirection(this.tmpMat.copy(this.root.matrixWorld).invert())
      .normalize();
    return { point, normal, distance: shot.start.distanceTo(point) };
  }

  private approximateDamagedTargetImpact(
    shot: PendingShot,
    target: DamageTarget
  ): ProjectileImpact | null {
    const center = this.targetAimPoint(target, new THREE.Vector3());
    const toCenter = center.sub(shot.start);
    const along = toCenter.dot(shot.dir);
    if (along <= 0.08 || along > PROJECTILE_HIT_MAX) return null;

    const closest = shot.start.clone().addScaledVector(shot.dir, along);
    const radius = this.targetHitRadius(target.vehicle);
    const miss = closest.distanceTo(this.targetAimPoint(target, new THREE.Vector3()));
    if (miss > radius) return null;

    const surfaceOffset = Math.sqrt(Math.max(0, radius * radius - miss * miss));
    const distance = Math.max(0.12, along - surfaceOffset);
    const point = shot.start.clone().addScaledVector(shot.dir, distance);
    const normal = point.clone().sub(this.targetAimPoint(target, new THREE.Vector3()));
    if (normal.lengthSq() < 1e-5) normal.copy(shot.dir).multiplyScalar(-1);
    else normal.normalize();
    return { point, normal, distance };
  }

  private approximateArcTargetImpact(
    shot: PendingShot,
    target: DamageTarget
  ): ProjectileImpact | null {
    const point = this.targetAimPoint(target, new THREE.Vector3());
    const distance = shot.start.distanceTo(point);
    if (distance > PROJECTILE_HIT_MAX * 1.25) return null;
    const normal = point.clone().sub(target.viz.placed ? target.viz.group.position : target.viz.tgtPos);
    if (normal.lengthSq() < 1e-5) normal.copy(shot.dir).multiplyScalar(-1);
    else normal.normalize();
    return { point, normal, distance };
  }

  private targetAimPoint(target: DamageTarget, out: THREE.Vector3): THREE.Vector3 {
    out.copy(target.viz.placed ? target.viz.group.position : target.viz.tgtPos);
    const kind = target.vehicle.kind;
    const lift =
      kind === 'base' ? 0.62 : kind === 'outpost' ? 0.72 : kind === 'rune' ? 0.68 : 0.2;
    return out.addScaledVector(MatchUnit.UP, lift);
  }

  private targetHitRadius(v: VehicleState): number {
    if (v.kind === 'base') return 1.2;
    if (v.kind === 'outpost') return 1.0;
    if (v.kind === 'rune' || v.kind === 'building') return 0.85;
    return 0.72;
  }

  private createSparkBurst(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    incoming: THREE.Vector3,
    v: VehicleState,
    now: number,
    scale = 1
  ): SparkBurst {
    const positions = new Float32Array(PROJECTILE_SPARK_COUNT * 2 * 3);
    for (let i = 0; i < PROJECTILE_SPARK_COUNT * 2; i++) {
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = point.y;
      positions[i * 3 + 2] = point.z;
    }

    const geo = new THREE.BufferGeometry();
    const positionAttr = new THREE.BufferAttribute(positions, 3);
    geo.setAttribute('position', positionAttr);
    const mat = new THREE.LineBasicMaterial({
      color: sparkColor(v.team),
      transparent: true,
      opacity: PROJECTILE_SPARK_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.LineSegments(geo, mat);
    line.frustumCulled = false;
    line.visible = false;

    const tangent =
      Math.abs(normal.y) < 0.92
        ? new THREE.Vector3().crossVectors(normal, MatchUnit.UP).normalize()
        : new THREE.Vector3(1, 0, 0);
    const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    const backscatter = incoming.clone().multiplyScalar(-0.45);
    const velocities: THREE.Vector3[] = [];
    const lengths: number[] = [];
    for (let i = 0; i < PROJECTILE_SPARK_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spread = 0.28 + Math.random() * 1.2;
      const vel = normal
        .clone()
        .multiplyScalar(0.8 + Math.random() * 1.5)
        .addScaledVector(tangent, Math.cos(angle) * spread)
        .addScaledVector(bitangent, Math.sin(angle) * spread)
        .addScaledVector(backscatter, Math.random() * 0.9)
        .normalize()
        .multiplyScalar((1.5 + Math.random() * 3.4) * scale);
      velocities.push(vel);
      lengths.push((0.08 + Math.random() * 0.22) * scale);
    }

    return {
      line,
      positionAttr,
      velocities,
      lengths,
      origin: point.clone(),
      bornAt: now,
      ttl: PROJECTILE_SPARK_TTL_MS,
      opacity: Math.min(1, PROJECTILE_SPARK_OPACITY * (scale > 1 ? 1.08 : 1)),
    };
  }

  private snapBuildingToSurface(pos: THREE.Vector3): void {
    if (this.projectToSurface(pos.x, pos.z, this.tmpHitLocal)) pos.y = this.tmpHitLocal.y;
  }

  private ensurePanel(viz: VehicleViz): void {
    if (!viz.panel) {
      viz.panel = buildPanel();
      viz.label = new CSS2DObject(viz.panel.root);
      viz.label.position.set(0, 1.6, 0);
      viz.label.center.set(0.5, 1);
    }
    if (viz.label && !viz.label.parent) viz.group.add(viz.label);
  }

  private applyProjectionStyle(viz: VehicleViz): void {
    const color = teamColor(viz.lastTeam);
    const opacity = this.state === 'focused' ? 0.72 : this.state === 'dim' ? 0.16 : 0.42;
    viz.projectionLine.material.color.setHex(color);
    viz.projectionLine.material.opacity = opacity;
  }

  private updateProjection(viz: VehicleViz, now: number): boolean {
    const dx = viz.curPos.x - viz.projectionSurfaceX;
    const dz = viz.curPos.z - viz.projectionSurfaceZ;
    const age = now - viz.projectionSurfaceUpdatedAt;
    const shouldRefresh =
      !viz.projectionSurfaceValid ||
      age >= PROJECTION_SURFACE_FORCE_UPDATE_MS ||
      (age >= PROJECTION_SURFACE_UPDATE_MS && dx * dx + dz * dz >= PROJECTION_SURFACE_MOVE_EPS_SQ);

    if (shouldRefresh) {
      const hit = this.projectToSurface(viz.curPos.x, viz.curPos.z, this.tmpHitLocal);
      viz.projectionSurfaceUpdatedAt = now;
      viz.projectionSurfaceValid = hit;
      if (hit) {
        viz.projectionSurfaceX = viz.curPos.x;
        viz.projectionSurfaceZ = viz.curPos.z;
        viz.projectionSurfaceY = this.tmpHitLocal.y;
      }
    }

    if (!viz.projectionSurfaceValid) {
      viz.projectionLine.visible = false;
      return false;
    }

    const surfaceY = viz.projectionSurfaceY;
    const lineVisible = Math.abs(viz.curPos.y - surfaceY) >= PROJECTION_MIN_LINE;
    viz.projectionLine.visible = lineVisible;
    if (!lineVisible) return true;

    viz.projectionLinePos.setXYZ(0, viz.curPos.x, viz.curPos.y, viz.curPos.z);
    viz.projectionLinePos.setXYZ(1, viz.curPos.x, surfaceY, viz.curPos.z);
    viz.projectionLinePos.needsUpdate = true;
    return true;
  }

  private projectToSurface(
    x: number,
    z: number,
    targetPoint: THREE.Vector3
  ): boolean {
    this.projectionHits.length = 0;
    this.tmpRayLocal.set(x, this._localBounds.max.y + PROJECTION_RAY_PAD, z);
    this.root.localToWorld(this.tmpRayWorld.copy(this.tmpRayLocal));
    this.projectionRay.set(this.tmpRayWorld, MatchUnit.DOWN);

    if (this.model) {
      this.projectionRay.intersectObject(this.model.object, true, this.projectionHits);
    }
    if (this.projectionHits.length === 0 && this.plinth) {
      this.projectionRay.intersectObject(this.plinth, false, this.projectionHits);
    }
    if (this.projectionHits.length === 0) return false;

    const hit = this.projectionHits[0];
    this.root.worldToLocal(targetPoint.copy(hit.point));
    return true;
  }

  private updatePanel(viz: VehicleViz, v: VehicleState, now = performance.now()): void {
    const p = viz.panel;
    if (!p) return;
    const teamChanged = v.team !== p.last.team;
    const teamCss =
      v.team === 'blue' ? '#1FA3F6' : v.team === 'red' ? '#F03A30' : '#8ad36b';

    // Header: team-coloured tag.
    const tag = nameplate(v);
    if (tag !== p.last.tag) {
      p.tag.textContent = tag;
      p.last.tag = tag;
    }
    if (teamChanged) p.tag.style.color = teamCss;

    const lv = v.level != null ? `Lv${v.level}` : '';
    if (lv !== p.last.lv) {
      p.lv.textContent = lv;
      p.lv.hidden = !lv;
      p.last.lv = lv;
    }

    const showingRepairCount = v.kind === 'outpost' && v.repairCount != null;
    p.ammoWrap.classList.toggle('repair-count', showingRepairCount);

    // ⊘ + ammo: lock shows + ammo dims when firing-locked. Outposts use this
    // corner for remaining repair count instead.
    const locked = showingRepairCount ? null : (v.firingLocked ?? null);
    if (locked !== p.last.locked) {
      p.lock.hidden = locked !== true;
      p.ammo.classList.toggle('dim', locked === true);
      p.last.locked = locked;
    }
    const topRight = showingRepairCount
      ? String(Math.max(0, Math.round(v.repairCount!)))
      : v.ammo != null
        ? String(v.ammo)
        : '—';
    if (topRight !== p.last.ammo) {
      p.ammo.textContent = topRight;
      p.last.ammo = topRight;
    }

    const hpMax = v.hpMax && v.hpMax > 0 ? v.hpMax : null;
    const hp = v.hp != null ? v.hp : Math.round((v.health ?? 1) * (hpMax ?? 100));
    const respawn = this.respawnDisplay(viz, v, now);
    const barMode = respawn ? 'respawn' : 'hp';
    p.root.classList.toggle('is-defeated', barMode === 'respawn');

    if (respawn) {
      const progress = Math.round(respawn.progress * 1000) / 1000;
      if (
        p.last.barMode !== barMode ||
        p.last.respawnProgress !== progress ||
        p.last.respawnSegments !== respawn.segments
      ) {
        for (let i = 0; i < MAX_CELLS; i++) {
          const cell = p.cells[i];
          cell.classList.toggle('respawn', i < respawn.segments);
          if (i >= respawn.segments) {
            cell.style.display = 'none';
            p.fills[i].style.width = '0';
            continue;
          }
          cell.style.display = '';
          const frac = respawn.progress * respawn.segments - i;
          p.fills[i].style.width = `${clampPct(frac * 100)}%`;
          p.fills[i].style.background = respawn.inferred ? RESPAWN_FILL_DIM : RESPAWN_FILL;
        }
        p.last.barMode = barMode;
        p.last.respawnProgress = progress;
        p.last.respawnSegments = respawn.segments;
      }
    } else if (
      p.last.barMode !== barMode ||
      hp !== p.last.hp ||
      hpMax !== p.last.hpMax ||
      teamChanged
    ) {
      // HP cells: 50 HP each (1-HP-precision fill via the partial last cell). Beyond
      // MAX_CELLS the row collapses to one continuous bar (big structures).
      const needed = hpMax ? Math.ceil(hpMax / 50) : 1;
      const continuous = needed > MAX_CELLS;
      const shown = continuous ? 1 : Math.max(1, Math.min(needed, MAX_CELLS));
      for (let i = 0; i < MAX_CELLS; i++) {
        const cell = p.cells[i];
        cell.classList.remove('respawn');
        if (i >= shown) {
          cell.style.display = 'none';
          p.fills[i].style.width = '0';
          continue;
        }
        cell.style.display = '';
        const frac = continuous ? (hpMax ? hp / hpMax : (v.health ?? 1)) : (hp - i * 50) / 50;
        p.fills[i].style.width = `${clampPct(frac * 100)}%`;
        p.fills[i].style.background = teamCss;
      }
      p.last.barMode = barMode;
      p.last.hp = hp;
      p.last.hpMax = hpMax ?? undefined;
      p.last.respawnProgress = undefined;
      p.last.respawnSegments = undefined;
    }

    // Heat strip (amber → red over 85%); hidden when no heat channel.
    const hasHeat = v.heat != null;
    const heat = hasHeat ? Math.round(v.heat! * 100) : 0;
    if (heat !== p.last.heat) {
      p.heatRow.style.display = hasHeat ? '' : 'none';
      p.heatBar.style.width = `${heat}%`;
      p.heatBar.style.background = heat > 85 ? '#ef4444' : '#f59e0b';
      p.last.heat = heat;
    }

    // Buff pips.
    const buffs = (v.buffs ?? []).join(',');
    if (buffs !== p.last.buffs) {
      const set = new Set(v.buffs ?? []);
      let enhancedModeKey: BuffKey | null = null;
      if (set.has('sentry-enhanced')) {
        for (const [marker, key] of Object.entries(SENTRY_MODE_MARKERS)) {
          if (set.has(marker)) {
            enhancedModeKey = key;
            break;
          }
        }
      }
      for (const key of BUFF_ORDER) {
        const pip = p.buffPips[key];
        pip.hidden = !set.has(key);
        pip.classList.toggle('enhanced', enhancedModeKey === key);
      }
      p.last.buffs = buffs;
    }

    p.last.team = v.team;
  }

  private removeVehicle(viz: VehicleViz): void {
    this.pendingShots = this.pendingShots.filter((shot) => shot.viz !== viz);
    this.recentDamageTargets = this.recentDamageTargets.filter((target) => target.viz !== viz);
    this.disposeVehicleBuilding(viz);
    this.root.remove(viz.group);
    this.root.remove(viz.projectionLine);
    (viz.body.material as THREE.Material).dispose();
    viz.projectionLine.geometry.dispose();
    viz.projectionLine.material.dispose();
    if (viz.label) {
      viz.label.element.remove();
      viz.group.remove(viz.label);
    }
  }
}

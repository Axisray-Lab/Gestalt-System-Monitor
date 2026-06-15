import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { MapWireframe, VehicleState, WorldSnapshot } from '@gsm/protocol';
import { ueToThree } from './coords';
import { mapModelFor, loadMapModel, disposeMapModel, type LoadedMapModel } from './mapModels';

const TEAM_COLORS: Record<string, number> = { red: 0xe5564e, blue: 0x4e8ce5 };
const NEUTRAL = 0x8ad36b;
/** A vehicle not seen for this long is dropped. */
const STALE_MS = 2000;
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

/** Cached references into a built panel, so updates touch only changed nodes. */
interface PanelDom {
  root: HTMLElement;
  name: HTMLElement;
  spd: HTMLElement;
  pts: HTMLElement;
  ptsRow: HTMLElement;
  hpBar: HTMLElement;
  last: { name?: string; spd?: string; pts?: number | null; hp?: number };
}

interface VehicleViz {
  group: THREE.Group;
  body: THREE.Mesh;
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
  /** Per-vehicle info panel — lazily built and only attached while focused. */
  label: CSS2DObject | null;
  panel: PanelDom | null;
}

function buildPanel(): PanelDom {
  const root = document.createElement('div');
  root.className = 'veh-panel';

  const name = document.createElement('div');
  name.className = 'vp-name';
  root.appendChild(name);

  const spdRow = document.createElement('div');
  spdRow.className = 'vp-row';
  const spdLabel = document.createElement('span');
  spdLabel.textContent = 'spd';
  const spd = document.createElement('b');
  spdRow.append(spdLabel, spd);
  root.appendChild(spdRow);

  const ptsRow = document.createElement('div');
  ptsRow.className = 'vp-row';
  const ptsLabel = document.createElement('span');
  ptsLabel.textContent = 'pts';
  const pts = document.createElement('b');
  ptsRow.append(ptsLabel, pts);
  root.appendChild(ptsRow);

  const hp = document.createElement('div');
  hp.className = 'vp-hp';
  const hpBar = document.createElement('i');
  hp.appendChild(hpBar);
  root.appendChild(hp);

  return { root, name, spd, pts, ptsRow, hpBar, last: {} };
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
  private state: UnitState = 'normal';
  /** Loaded 3D sandbox model for maps that have one (else the wireframe is shown). */
  private model: LoadedMapModel | null = null;
  /** Bumped each setMap so a stale async model load can be discarded. */
  private modelLoadId = 0;
  private disposed = false;
  /** Set by DioramaScene — invoked when an async model load changes the footprint. */
  onBoundsChange?: () => void;
  /** Local-space bounds (plinth footprint + a little height); placeholder until setMap. */
  private _localBounds = new THREE.Box3(
    new THREE.Vector3(-20, -0.45, -15),
    new THREE.Vector3(20, 1, 15)
  );

  private tmpDir = new THREE.Vector3();
  private tmpMat = new THREE.Matrix4();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
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
    }
    this.plinth = new THREE.Mesh(new THREE.BoxGeometry(sx * 1.12, 0.4, sz * 1.12), this.plinthMat!);
    this.plinth.position.set(cx, -0.25, cz);
    this.plinth.userData.matchUnit = this;
    this.plinth.layers.enable(1); // picked via a layer-1 raycaster only
    this.mapGroup.add(this.plinth);

    this.plaque.position.set(cx, 2.6, cz);
    this._localBounds.set(
      new THREE.Vector3(cx - sx * 0.56, -0.45, cz - sz * 0.56),
      new THREE.Vector3(cx + sx * 0.56, 1.0, cz + sz * 0.56)
    );

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
        const fit = Math.min(sx / m.footprint.x, sz / m.footprint.z) * 0.95;
        m.object.scale.setScalar(fit);
        m.object.position.set(cx, 0, cz);
        this.applyStateToModel(m.material);
        this.mapGroup.add(m.object);
        this.model = m;
        this.setLinesVisible(false); // the model replaces the oval wireframe
        this._localBounds.max.y = Math.max(this._localBounds.max.y, m.footprint.y * fit);
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

  updateSnapshot(snap: WorldSnapshot): void {
    const now = performance.now();
    for (const v of snap.vehicles) {
      let viz = this.vehicles.get(v.id);
      if (!viz) viz = this.createVehicle(v);
      this.applyVehicle(viz, v);
      viz.lastSeen = now;
    }
    for (const [id, viz] of this.vehicles) {
      if (now - viz.lastSeen > STALE_MS) {
        this.removeVehicle(viz);
        this.vehicles.delete(id);
      }
    }
  }

  /** Advance interpolation toward the latest snapshot. Called every frame. */
  update(dt: number): void {
    const alpha = 1 - Math.exp(-SMOOTH * dt);
    for (const viz of this.vehicles.values()) {
      if (!viz.placed) continue;
      viz.curPos.lerp(viz.tgtPos, alpha);
      viz.curQuat.slerp(viz.tgtQuat, alpha);
      viz.group.position.copy(viz.curPos);
      viz.group.quaternion.copy(viz.curQuat);
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
    for (const viz of this.vehicles.values()) {
      if (focused) {
        this.ensurePanel(viz);
        if (viz.lastV) this.updatePanel(viz, viz.lastV);
      } else if (viz.label?.parent) {
        viz.group.remove(viz.label);
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
    const body = new THREE.Mesh(this.shared.bodyGeo, new THREE.MeshStandardMaterial({ color }));
    group.add(body);
    this.root.add(group);
    const viz: VehicleViz = {
      group,
      body,
      curPos: new THREE.Vector3(),
      curQuat: new THREE.Quaternion(),
      tgtPos: new THREE.Vector3(),
      tgtQuat: new THREE.Quaternion(),
      placed: false,
      lastSeen: 0,
      lastTeam: v.team,
      lastV: null,
      label: null,
      panel: null,
    };
    this.vehicles.set(v.id, viz);
    return viz;
  }

  private applyVehicle(viz: VehicleViz, v: VehicleState): void {
    ueToThree(v.pos, viz.tgtPos);
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
    if (v.team !== viz.lastTeam) {
      (viz.body.material as THREE.MeshStandardMaterial).color.setHex(teamColor(v.team));
      viz.lastTeam = v.team;
    }
    viz.lastV = v;
    if (this.state === 'focused') {
      this.ensurePanel(viz);
      this.updatePanel(viz, v);
    }
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

  private updatePanel(viz: VehicleViz, v: VehicleState): void {
    const p = viz.panel;
    if (!p) return;
    const name = v.name ?? `Car ${v.id}`;
    if (name !== p.last.name) {
      p.name.textContent = name;
      p.last.name = name;
    }
    const spd = v.speed != null ? String(v.speed) : '—';
    if (spd !== p.last.spd) {
      p.spd.textContent = spd;
      p.last.spd = spd;
    }
    if (v.score !== p.last.pts) {
      if (v.score != null) {
        p.pts.textContent = String(v.score);
        p.ptsRow.hidden = false;
      } else {
        p.ptsRow.hidden = true;
      }
      p.last.pts = v.score ?? null;
    }
    const hp = Math.round((v.health ?? 1) * 100);
    if (hp !== p.last.hp) {
      p.hpBar.style.width = `${hp}%`;
      p.last.hp = hp;
    }
  }

  private removeVehicle(viz: VehicleViz): void {
    this.root.remove(viz.group);
    (viz.body.material as THREE.Material).dispose();
    if (viz.label) {
      viz.label.element.remove();
      viz.group.remove(viz.label);
    }
  }
}

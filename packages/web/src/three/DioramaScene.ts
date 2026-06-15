import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { MapWireframe, WorldSnapshot } from '@gsm/protocol';
import { MatchUnit, type SharedAssets } from './MatchUnit';

/** Gap (m) between grid cells. */
const GAP = 14;
/** Approach directions (normalized in ctor) for the two camera framings. */
const OVERVIEW_DIR = new THREE.Vector3(0, 1, 0.62).normalize();
const FOCUS_DIR = new THREE.Vector3(0, 0.6, 1).normalize();
const FOCUS_MARGIN = 1.25;
const OVERVIEW_MARGIN = 1.4;
const TWEEN_DUR = 0.6;
const SPOT_HEIGHT = 60;
const SPOT_INTENSITY = 3.2;

interface CameraTween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTgt: THREE.Vector3;
  toTgt: THREE.Vector3;
  fromSpot: number;
  toSpot: number;
  t: number;
  dur: number;
}

interface DioramaOptions {
  /** Called when the user focuses/unfocuses by interacting with the scene (click/Esc). */
  onFocusChange?: (key: string | null) => void;
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Renders many matches at once in a single shared scene. Each match is a
 * `MatchUnit` placed on an auto-sized grid; the camera flies between an overview
 * of all units and a focused close-up (with a spotlight on the focused unit and
 * the rest dimmed). One WebGLRenderer + one CSS2DRenderer for the whole view.
 */
export class DioramaScene {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private controls: OrbitControls;
  private spot: THREE.SpotLight;
  private grid: THREE.GridHelper;
  private units = new Map<string, MatchUnit>();
  private shared: SharedAssets;
  private ro: ResizeObserver;
  private raf = 0;
  private last = performance.now();

  private focusKey: string | null = null;
  private tween: CameraTween | null = null;
  private gridBounds = new THREE.Box3();

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDown: { x: number; y: number } | null = null;

  // scratch
  private tmpBox = new THREE.Box3();
  private tmpSphere = new THREE.Sphere();
  private tmpPos = new THREE.Vector3();
  private tmpTgt = new THREE.Vector3();

  constructor(
    private container: HTMLElement,
    private opts: DioramaOptions = {}
  ) {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 20000);
    this.camera.position.set(80, 120, 80);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(w, h);
    const le = this.labelRenderer.domElement;
    le.style.position = 'absolute';
    le.style.top = '0';
    le.style.left = '0';
    le.style.pointerEvents = 'none';
    container.appendChild(le);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(60, 120, 40);
    this.scene.add(dir);

    this.spot = new THREE.SpotLight(0xffffff, 0, 0, Math.PI / 6, 0.4, 0);
    this.scene.add(this.spot);
    this.scene.add(this.spot.target);

    this.grid = new THREE.GridHelper(1600, 160, 0x2a4a66, 0x1c2a38);
    const gm = this.grid.material as THREE.Material;
    gm.transparent = true;
    gm.opacity = 0.3;
    this.scene.add(this.grid);

    // Shared vehicle marker: a small (~0.5m, real robot footprint) triangular
    // prism that points along the heading. Allocated once, reused by every unit.
    const bodyGeo = new THREE.ConeGeometry(0.28, 0.5, 3);
    bodyGeo.rotateX(Math.PI / 2); // tip points +Z so heading orients via quaternion
    this.shared = { bodyGeo };

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.animate();
  }

  // ---- unit management ----------------------------------------------------

  addUnit(key: string, label: string): MatchUnit {
    let unit = this.units.get(key);
    if (unit) {
      unit.setLabel(label);
      return unit;
    }
    unit = new MatchUnit(key, label, this.shared);
    unit.onBoundsChange = () => this.relayout(); // async model load can change the footprint
    this.scene.add(unit.root);
    this.units.set(key, unit);
    this.relayout();
    return unit;
  }

  removeUnit(key: string): void {
    const unit = this.units.get(key);
    if (!unit) return;
    if (this.focusKey === key) this.focusKey = null;
    unit.dispose();
    this.scene.remove(unit.root);
    this.units.delete(key);
    this.relayout();
  }

  getUnit(key: string): MatchUnit | undefined {
    return this.units.get(key);
  }

  setMap(key: string, map: MapWireframe): void {
    const unit = this.units.get(key);
    if (!unit) return;
    unit.setMap(map);
    this.relayout(); // footprint may have changed
  }

  updateSnapshot(key: string, snap: WorldSnapshot): void {
    this.units.get(key)?.updateSnapshot(snap);
  }

  // ---- focus --------------------------------------------------------------

  /** Programmatic focus driver (from the sidebar). Idempotent — no-op if already on `key`. */
  applyFocus(key: string | null): void {
    if (key) this.focus(key);
    else this.overview();
  }

  focus(key: string): void {
    const unit = this.units.get(key);
    if (!unit || this.focusKey === key) return;
    this.focusKey = key;
    for (const u of this.units.values()) u.setState(u.key === key ? 'focused' : 'dim');
    this.frameUnit(unit, TWEEN_DUR);
  }

  overview(): void {
    if (this.focusKey === null) return;
    this.focusKey = null;
    for (const u of this.units.values()) u.setState('normal');
    this.frameOverview(TWEEN_DUR);
  }

  // ---- layout & framing ---------------------------------------------------

  private relayout(): void {
    const list = [...this.units.values()];
    if (list.length === 0) {
      this.gridBounds.makeEmpty();
      return;
    }
    const cols = Math.ceil(Math.sqrt(list.length));
    let maxW = 0;
    let maxD = 0;
    for (const u of list) {
      const b = u.localBounds;
      maxW = Math.max(maxW, b.max.x - b.min.x);
      maxD = Math.max(maxD, b.max.z - b.min.z);
    }
    const cellW = maxW + GAP;
    const cellD = maxD + GAP;
    const rows = Math.ceil(list.length / cols);
    const gridW = cols * cellW;
    const gridD = rows * cellD;
    list.forEach((u, i) => {
      const cx = i % cols;
      const cz = Math.floor(i / cols);
      u.root.position.set((cx + 0.5) * cellW - gridW / 2, 0, (cz + 0.5) * cellD - gridD / 2);
    });
    this.gridBounds.makeEmpty();
    for (const u of list) this.gridBounds.union(u.worldBounds(this.tmpBox));

    // Re-aim after topology/size changes so the new arrangement is in view.
    this.reframe(TWEEN_DUR);
  }

  private reframe(dur: number): void {
    if (this.units.size === 0) return;
    const focused = this.focusKey ? this.units.get(this.focusKey) : null;
    if (focused) this.frameUnit(focused, dur);
    else this.frameOverview(dur);
  }

  private frameOverview(dur: number): void {
    if (this.gridBounds.isEmpty()) return;
    this.frameBox(this.gridBounds, OVERVIEW_MARGIN, OVERVIEW_DIR, 0, dur);
  }

  private frameUnit(unit: MatchUnit, dur: number): void {
    const c = unit.center;
    this.spot.position.set(c.x, SPOT_HEIGHT, c.z);
    this.spot.target.position.copy(c);
    const box = unit.worldBounds(this.tmpBox);
    const r = box.getBoundingSphere(this.tmpSphere).radius;
    this.spot.angle = Math.min(Math.PI / 3, Math.atan((r * 1.15) / SPOT_HEIGHT));
    this.frameBox(box, FOCUS_MARGIN, FOCUS_DIR, SPOT_INTENSITY, dur);
  }

  private frameBox(
    box: THREE.Box3,
    margin: number,
    dir: THREE.Vector3,
    spotTo: number,
    dur: number
  ): void {
    const sphere = box.getBoundingSphere(this.tmpSphere);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    const dist = Math.max(sphere.radius / Math.sin(fov / 2), sphere.radius / Math.sin(hFov / 2)) * margin;
    this.tmpTgt.copy(sphere.center);
    this.tmpPos.copy(sphere.center).addScaledVector(dir, dist);
    this.startTween(this.tmpPos, this.tmpTgt, spotTo, dur);
  }

  private startTween(toPos: THREE.Vector3, toTgt: THREE.Vector3, toSpot: number, dur: number): void {
    if (dur <= 0) {
      this.camera.position.copy(toPos);
      this.controls.target.copy(toTgt);
      this.spot.intensity = toSpot;
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this.tween = null;
      this.controls.enabled = true;
      return;
    }
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone(),
      fromTgt: this.controls.target.clone(),
      toTgt: toTgt.clone(),
      fromSpot: this.spot.intensity,
      toSpot,
      t: 0,
      dur,
    };
    this.controls.enabled = false; // don't let damping fight the directly-driven camera
  }

  // ---- interaction --------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    const dn = this.pointerDown;
    this.pointerDown = null;
    if (!dn || this.tween) return;
    if (Math.hypot(e.clientX - dn.x, e.clientY - dn.y) > 6) return; // it was an orbit drag

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.layers.set(1);
    const targets: THREE.Object3D[] = [];
    for (const u of this.units.values()) targets.push(...u.pickTargets);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length) {
      const unit = hits[0].object.userData.matchUnit as MatchUnit | undefined;
      if (unit && unit.key !== this.focusKey) {
        this.focus(unit.key);
        this.opts.onFocusChange?.(unit.key);
      }
    } else if (this.focusKey !== null) {
      this.overview();
      this.opts.onFocusChange?.(null);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.focusKey !== null) {
      this.overview();
      this.opts.onFocusChange?.(null);
    }
  };

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  // ---- loop & teardown ----------------------------------------------------

  private animate = (): void => {
    this.raf = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1); // clamp so a backgrounded tab doesn't teleport
    this.last = now;

    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const u = Math.min(1, tw.t / tw.dur);
      const e = easeInOutCubic(u);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromTgt, tw.toTgt, e);
      this.spot.intensity = tw.fromSpot + (tw.toSpot - tw.fromSpot) * e;
      this.camera.lookAt(this.controls.target);
      if (u >= 1) {
        this.tween = null;
        this.controls.enabled = true;
      }
    } else {
      this.controls.update();
    }

    for (const unit of this.units.values()) unit.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    for (const unit of this.units.values()) {
      unit.dispose();
      this.scene.remove(unit.root);
    }
    this.units.clear();
    this.controls.dispose();
    this.shared.bodyGeo.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { MapWireframe, WorldSnapshot } from '@gsm/protocol';
import { MatchUnit, type SharedAssets } from './MatchUnit';

/** Gap (m) between grid cells. */
const GAP = 14;
/** Y-stack tight gap between non-focused sandboxes. */
const Y_TIGHT = 4;
/** Y-stack gap above the focused sandbox (wider to avoid occlusion). */
const Y_WIDE = 56;
/** Duration (s) of the Y-position slide when switching iterations. */
const Y_SHIFT_DUR = 0.32;
/** Full polar-angle range. */
const MAX_POLAR = Math.PI * 0.49;
/** Approach directions (normalized in ctor) for the two camera framings. */
const OVERVIEW_DIR = new THREE.Vector3(0, 1, 0.62).normalize();
const FOCUS_DIR = new THREE.Vector3(0, 0.6, 1).normalize();
const FOCUS_MARGIN = 1.25;
const OVERVIEW_MARGIN = 1.4;
const TWEEN_DUR = 0.6;
const SPOT_HEIGHT = 60;
const SPOT_INTENSITY = 3.2;
/** World grid plane: aligned to the sandbox plinth underside, below the model contents. */
const WORLD_GRID_Y = -1.05;
/** A frame slower than this (≈30fps) counts as a "hitch" in the perf HUD. */
const LONG_FRAME_MS = 33;
/** How many recent frame times the perf HUD sparkline retains (~2s @ 60fps). */
const FRAME_TRACE_LEN = 120;

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
  /** Called periodically with renderer/frame statistics for the app HUD. */
  onPerformanceStats?: (stats: ThreePerformanceStats) => void;
  /** Called whenever the visible (non-occluded) board set changes, so the feed
   *  layer can stop processing snapshots for hidden boards. */
  onActiveKeysChange?: (keys: Set<string>) => void;
}

export interface ThreePerformanceStats {
  fps: number;
  /** Average rAF-to-rAF delta over the window. */
  frameMs: number;
  /** Fastest frame in the window — reveals the display's native refresh cadence. */
  frameMsMin: number;
  /** 95th-percentile and worst frame in the window — surfaces jank an average hides. */
  frameMsP95: number;
  frameMsMax: number;
  /** Count of frames slower than LONG_FRAME_MS in the window (hitches). */
  longFrames: number;
  /** Average time spent inside the render loop this window (update+render+labels). */
  cpuMs: number;
  /** Per-phase averages (ms): vehicle interpolation, WebGL submit, CSS2D labels. */
  updateMs: number;
  renderMs: number;
  labelMs: number;
  /** frameMs - cpuMs: time outside the loop — feed processing, GC, layout/paint, vsync wait. */
  otherMs: number;
  /** Real GPU time per frame via EXT_disjoint_timer_query_webgl2 (0 if unsupported). */
  gpuMs: number;
  gpuSupported: boolean;
  /** Active GPU name (WEBGL_debug_renderer_info) — reveals integrated vs discrete. */
  gpuRenderer: string;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  pixelRatio: number;
  /** Total matches vs. those actually rendering (non-occluded). */
  unitCount: number;
  activeUnitCount: number;
  /** Vehicles being interpolated across the visible boards. */
  vehicleCount: number;
  focused: boolean;
  width: number;
  height: number;
  /** Recent frame times for the HUD sparkline (most recent last). */
  frameSamples: number[];
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
  private perfFrames = 0;
  private perfElapsedMs = 0;
  // Per-window phase accumulators (averaged on emit).
  private perfUpdateMs = 0;
  private perfRenderMs = 0;
  private perfLabelMs = 0;
  private perfCpuMs = 0;
  private perfFrameMaxMs = 0;
  private perfLongFrames = 0;
  private perfWindowSamples: number[] = []; // frame times this window, for the percentile
  private frameTrace: number[] = []; // rolling ring (FRAME_TRACE_LEN) for the sparkline
  // GPU timer query (EXT_disjoint_timer_query_webgl2): one query in flight at a time;
  // the result lands a few frames later, so we poll and carry the last good reading.
  private gpuTimerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private gpuQuery: WebGLQuery | null = null;
  private gpuMsLast = 0;
  private gpuSupported = false;
  private gpuRenderer = '';

  private focusKey: string | null = null;
  /** Suppress auto-framing once the user has manually moved the camera. */
  private userMovedCamera = false;
  /** Debounce handle so a burst of relayouts re-frames the overview only once. */
  private overviewFrameTimer: ReturnType<typeof setTimeout> | null = null;
  private tween: CameraTween | null = null;
  private yShift: {
    units: MatchUnit[];
    fromYs: number[];
    toYs: number[];
    t: number;
    dur: number;
  } | null = null;
  private gridBounds = new THREE.Box3();

  // Saved original labels for iteration units (overwritten in overview)
  private _savedLabels = new Map<string, string>();

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

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // Hint the OS to pick the discrete/high-perf GPU and hold higher clocks. A
      // static scene on an integrated GPU otherwise downclocks and stutters, while
      // a continuous drag keeps it boosted — the "smooth while moving, slow while
      // idle" symptom.
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    // GPU diagnostics: real per-frame GPU time (WebGL2 timer query) + the active
    // GPU's name, so the HUD reveals whether we're on the integrated or discrete GPU.
    const gl = this.renderer.getContext();
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      this.gpuTimerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.gpuSupported = this.gpuTimerExt !== null;
    }
    const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbgInfo) {
      this.gpuRenderer = String(gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) ?? '');
    }

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
    this.controls.maxPolarAngle = MAX_POLAR;
    // Once the user drags/zooms, stop auto-framing so the async model loads (which
    // keep firing relayouts during initial load) don't yank the camera back.
    this.controls.addEventListener('start', () => { this.userMovedCamera = true; });

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(60, 120, 40);
    this.scene.add(dir);

    this.spot = new THREE.SpotLight(0xffffff, 0, 0, Math.PI / 6, 0.4, 0);
    this.scene.add(this.spot);
    this.scene.add(this.spot.target);

    this.grid = new THREE.GridHelper(1600, 160, 0x2a4a66, 0x1c2a38);
    this.grid.position.y = WORLD_GRID_Y;
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
    if (this.focusKey === key) {
      this.focusKey = null;
      for (const u of this.units.values()) u.setState('normal');
    }
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

    const wasFocused = this.focusKey !== null;
    // The Y-shift-only path (no camera move) is correct ONLY when switching between
    // iterations of the *same* sandbox column — the focused board always lands at the
    // same XZ/Y=0, so the camera doesn't need to fly. Switching to a *different*
    // sandbox (a different packet, or a single) must re-frame, or the new board just
    // highlights while the camera stays on the old one.
    const samePacket =
      wasFocused &&
      this.focusKey!.includes('iter-') &&
      key.includes('iter-') &&
      this.packetPrefix(this.focusKey!) === this.packetPrefix(key);

    this.focusKey = key;
    const focusedPacket = this.packetOf(key);
    for (const u of this.units.values()) {
      const isFocused = u.key === key;
      u.setState(isFocused ? 'focused' : 'dim');
      // Restore saved label only for focused packet units
      if (focusedPacket?.some(pu => pu.key === u.key)) {
        const saved = this._savedLabels.get(u.key);
        if (saved) u.setLabel(saved);
      }
    }
    // setState('dim') makes all plaques visible — clamp back:
    // focused packet: all plaques stay visible (setState already did that)
    // other packets: only first plaque visible, rest hidden
    for (const packet of this.iterPackets()) {
      if (packet.some(u => u.key === key)) continue;
      packet.forEach((u, i) => u.setPlaqueVisible(i === 0));
    }

    if (samePacket) {
      // Y-shift only the focused packet's units
      const fp = focusedPacket!;
      const fromYs = fp.map(u => u.root.position.y);

      this.relayout();

      const toYs = fp.map(u => u.root.position.y);
      fp.forEach((u, i) => { u.root.position.y = fromYs[i]; });

      this.yShift = { units: fp, fromYs, toYs, t: 0, dur: Y_SHIFT_DUR };
      this.updateSpotForUnit(unit);
    } else {
      this.relayout();
      this.frameUnit(unit, TWEEN_DUR);
    }
  }

  overview(): void {
    if (this.focusKey === null) return;
    this.focusKey = null;
    this.userMovedCamera = false; // returning to overview: re-framing is wanted again
    for (const u of this.units.values()) {
      u.setState('normal');
      u.setPlaqueVisible(true);
    }
    this.controls.minDistance = 0;
    this.yShift = null;
    this.relayout();
    this.frameOverview(TWEEN_DUR);
  }

  // ---- layout & framing ---------------------------------------------------

  /** Iteration units sorted by number, for consistent Y-stack indexing. */
  private sortedIters(): MatchUnit[] {
    const iters = [...this.units.values()].filter(u => u.key.includes('iter-'));
    iters.sort((a, b) => {
      const na = parseInt(a.key.match(/iter-(\d+)/)?.[1] ?? '0', 10);
      const nb = parseInt(b.key.match(/iter-(\d+)/)?.[1] ?? '0', 10);
      return na - nb;
    });
    return iters;
  }

  /** Shared prefix of all iterations of one sandbox column (e.g. "multi-15-iter"). */
  private packetPrefix(key: string): string {
    return key.replace(/iter-\d+.*$/, 'iter');
  }

  /** Which iteration packet a unit belongs to, or null. */
  private packetOf(key: string): MatchUnit[] | null {
    if (!key.includes('iter-')) return null;
    const prefix = this.packetPrefix(key);
    return this.sortedIters().filter(u => u.key.startsWith(prefix));
  }

  /** All iteration packets (each packet = one XZ column). */
  private iterPackets(): MatchUnit[][] {
    const map = new Map<string, MatchUnit[]>();
    for (const u of this.sortedIters()) {
      const prefix = this.packetPrefix(u.key);
      let arr = map.get(prefix);
      if (!arr) { arr = []; map.set(prefix, arr); }
      arr.push(u);
    }
    return [...map.values()];
  }

  private relayout(): void {
    const list = [...this.units.values()];
    if (list.length === 0) {
      this.gridBounds.makeEmpty();
      return;
    }

    const others = list.filter(u => !u.key.includes('iter-'));
    const iterPackets = this.iterPackets();

    let maxW = 0, maxD = 0;
    for (const u of list) {
      const b = u.localBounds;
      maxW = Math.max(maxW, b.max.x - b.min.x);
      maxD = Math.max(maxD, b.max.z - b.min.z);
    }
    const cellW = maxW + GAP;
    const cellD = maxD + GAP;

    // Place non-iteration units and iteration packets in an XZ grid.
    // Treat each iteration packet as one column (stacked along Y).
    const slotCount = others.length + iterPackets.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(slotCount)));

    let col = 0, row = 0;
    const rows = Math.ceil(slotCount / cols);

    // Non-iteration units: one per cell at Y=0
    for (const u of others) {
      const cx = col, cz = row;
      const gw = cols * cellW, gd = rows * cellD;
      u.root.position.set((cx + 0.5) * cellW - gw / 2, 0, (cz + 0.5) * cellD - gd / 2);
      col++;
      if (col >= cols) { col = 0; row++; }
    }

    // Iteration packets: each packet gets its own column, stacked along Y
    const focusedIter = this.focusKey
      ? [...this.units.values()].find(u => u.key === this.focusKey) ?? null
      : null;

    for (const packet of iterPackets) {
      const cx = col, cz = row;
      const gw = cols * cellW, gd = rows * cellD;
      const baseX = (cx + 0.5) * cellW - gw / 2;
      const baseZ = (cz + 0.5) * cellD - gd / 2;

      const focusedInPacket = focusedIter ? packet.find(u => u.key === this.focusKey) : null;
      const focusIdx = focusedInPacket ? packet.indexOf(focusedInPacket) : 0;

      packet.forEach((u, i) => {
        let y: number;
        if (this.focusKey && focusedInPacket) {
          if (i === focusIdx) {
            y = 0;
          } else if (i < focusIdx) {
            const dist = focusIdx - i;
            y = dist === 1 ? Y_WIDE : Y_WIDE + (dist - 1) * Y_TIGHT;
          } else {
            y = -(i - focusIdx) * Y_TIGHT;
          }
        } else {
          y = -i * Y_TIGHT;
        }
        u.root.position.set(baseX, y, baseZ);
      });

      col++;
      if (col >= cols) { col = 0; row++; }
    }

    // Apply deterministic stack visibility, then frame only the boards that
    // actually render (so a deep stack doesn't blow up the overview bounds).
    this.applyStackVisibility();
    this.gridBounds.makeEmpty();
    for (const u of list) {
      if (u.occluded) continue;
      this.gridBounds.union(u.worldBounds(this.tmpBox));
    }

    // In overview, hide plaques for non-first iteration units in each packet,
    // and set the first unit's plaque to the packet label.
    // Save original labels so we can restore when focusing.
    if (!this.focusKey) {
      for (const packet of iterPackets) {
        const n = packet.length;
        packet.forEach((u, i) => {
          if (i === 0) {
            if (!this._savedLabels.has(u.key)) this._savedLabels.set(u.key, u.plaqueText());
            u.setLabel(`\u{1F4E6} ${n}`);
          }
          u.setPlaqueVisible(i === 0);
        });
      }
    }

    // Re-frame the overview, but debounced and only if the user hasn't taken over
    // the camera: async model loads fire many relayouts during initial load, and
    // framing on each one snaps the view back to the origin every time.
    if (!this.focusKey) {
      this.scheduleOverviewFrame();
    } else {
      // A relayout while focused (a new live match arrived, or bounds settled) can
      // shift the focused board; re-aim the spotlight so its lighting doesn't drift.
      const focused = this.units.get(this.focusKey);
      if (focused) this.updateSpotForUnit(focused);
    }
  }

  /**
   * Debounced overview re-frame: collapses a burst of relayouts (e.g. 66 async
   * model loads) into a single camera move, and skips it once the user has taken
   * over the camera.
   */
  private scheduleOverviewFrame(): void {
    if (this.overviewFrameTimer) clearTimeout(this.overviewFrameTimer);
    this.overviewFrameTimer = setTimeout(() => {
      this.overviewFrameTimer = null;
      if (!this.focusKey && !this.userMovedCamera) this.frameOverview(TWEEN_DUR);
    }, 300);
  }

  private frameOverview(dur: number): void {
    if (this.gridBounds.isEmpty()) return;
    this.frameBox(this.gridBounds, OVERVIEW_MARGIN, OVERVIEW_DIR, 0, dur);
  }

  private frameUnit(unit: MatchUnit, dur: number): void {
    const box = this.updateSpotForUnit(unit);
    this.frameBox(box, FOCUS_MARGIN, FOCUS_DIR, SPOT_INTENSITY, dur);
  }

  private updateSpotForUnit(unit: MatchUnit): THREE.Box3 {
    const c = unit.center;
    this.spot.position.set(c.x, SPOT_HEIGHT, c.z);
    this.spot.target.position.copy(c);
    const box = unit.worldBounds(this.tmpBox);
    const r = box.getBoundingSphere(this.tmpSphere).radius;
    this.spot.angle = Math.min(Math.PI / 3, Math.atan((r * 1.15) / SPOT_HEIGHT));
    return box;
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
    // Three's raycaster ignores `.visible`, so occluded (hidden) stacked boards would
    // still be pickable — a click could resolve to a board that isn't on screen.
    for (const u of this.units.values()) {
      if (u.occluded) continue;
      targets.push(...u.pickTargets);
    }
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
    const frameMs = now - this.last;
    const dt = Math.min(frameMs / 1000, 0.1); // clamp so a backgrounded tab doesn't teleport
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
    } else if (this.yShift) {
      const ys = this.yShift;
      ys.t += dt;
      const u = Math.min(1, ys.t / ys.dur);
      const e = easeInOutCubic(u);
      for (let i = 0; i < ys.units.length; i++) {
        ys.units[i].root.position.y = ys.fromYs[i] + (ys.toYs[i] - ys.fromYs[i]) * e;
      }
      if (u >= 1) this.yShift = null;
      this.controls.update();
    } else {
      this.controls.update();
    }

    for (const unit of this.units.values()) unit.update(dt);
    const afterUpdate = performance.now();

    // GPU timer wraps only the WebGL pass (CSS2D labels are DOM, not GL). Poll the
    // previous frame's query first so a completed result frees the slot for a new one.
    this.pollGpuQuery();
    const gpuMeasuring = this.maybeBeginGpuQuery();
    this.renderer.render(this.scene, this.camera);
    if (gpuMeasuring) this.endGpuQuery();
    const afterRender = performance.now();

    this.labelRenderer.render(this.scene, this.camera);
    const afterLabels = performance.now();

    this.emitPerformanceStats(
      frameMs,
      afterUpdate - now,
      afterRender - afterUpdate,
      afterLabels - afterRender
    );
  };

  // ---- GPU timer query ----------------------------------------------------

  /** Begin a GPU timer query if the ext is available and none is in flight. */
  private maybeBeginGpuQuery(): boolean {
    if (!this.gpuTimerExt || this.gpuQuery) return false;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const query = gl.createQuery();
    if (!query) return false;
    gl.beginQuery(this.gpuTimerExt.TIME_ELAPSED_EXT, query);
    this.gpuQuery = query;
    return true;
  }

  private endGpuQuery(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    gl.endQuery(this.gpuTimerExt!.TIME_ELAPSED_EXT);
  }

  /** Non-blocking: read the in-flight query if its result is ready, else leave it. */
  private pollGpuQuery(): void {
    if (!this.gpuTimerExt || !this.gpuQuery) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const available = gl.getQueryParameter(this.gpuQuery, gl.QUERY_RESULT_AVAILABLE) as boolean;
    const disjoint = gl.getParameter(this.gpuTimerExt.GPU_DISJOINT_EXT) as boolean;
    if (!available && !disjoint) return; // still pending — check again next frame
    if (available && !disjoint) {
      const ns = gl.getQueryParameter(this.gpuQuery, gl.QUERY_RESULT) as number;
      this.gpuMsLast = ns / 1e6;
    }
    gl.deleteQuery(this.gpuQuery);
    this.gpuQuery = null;
  }

  // ---- stack visibility ---------------------------------------------------

  /**
   * Deterministic per-stack visibility (replaces the old screen-space occlusion
   * culling, which flickered as the camera moved). A stacked packet collapses to
   * just its top board in overview, and to just the focused board when one of its
   * iterations is focused; every other packet always shows only its top board.
   * Singles are always visible. This keeps the overview cheap and stable and stops
   * the boards lower in a stack bleeding through to the top.
   */
  private applyStackVisibility(): void {
    for (const u of this.units.values()) {
      if (!u.key.includes('iter-')) u.setOccluded(false); // singles always visible
    }
    for (const packet of this.iterPackets()) {
      const focusedInPacket =
        this.focusKey != null && packet.some((u) => u.key === this.focusKey);
      packet.forEach((u, i) => {
        const visible =
          this.focusKey == null
            ? i === 0
            : focusedInPacket
              ? u.key === this.focusKey
              : i === 0;
        u.setOccluded(!visible);
      });
    }
    // Tell the feed layer which boards actually render, so hidden feeds can skip
    // the expensive snapshot projection — the dominant main-thread cost at many
    // simultaneous matches.
    if (this.opts.onActiveKeysChange) {
      const active = new Set<string>();
      for (const u of this.units.values()) if (!u.occluded) active.add(u.key);
      this.opts.onActiveKeysChange(active);
    }
  }

  private emitPerformanceStats(
    frameMs: number,
    updateMs: number,
    renderMs: number,
    labelMs: number
  ): void {
    if (!this.opts.onPerformanceStats) return;
    this.perfFrames += 1;
    this.perfElapsedMs += frameMs;
    this.perfUpdateMs += updateMs;
    this.perfRenderMs += renderMs;
    this.perfLabelMs += labelMs;
    this.perfCpuMs += updateMs + renderMs + labelMs;
    if (frameMs > this.perfFrameMaxMs) this.perfFrameMaxMs = frameMs;
    if (frameMs > LONG_FRAME_MS) this.perfLongFrames += 1;
    this.perfWindowSamples.push(frameMs);
    this.frameTrace.push(frameMs);
    if (this.frameTrace.length > FRAME_TRACE_LEN) this.frameTrace.shift();

    if (this.perfElapsedMs < 500) return;

    const n = this.perfFrames;
    const sorted = [...this.perfWindowSamples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    const avgFrame = this.perfElapsedMs / n;
    const avgCpu = this.perfCpuMs / n;

    let activeUnits = 0;
    let vehicles = 0;
    for (const u of this.units.values()) {
      if (u.occluded) continue;
      activeUnits += 1;
      vehicles += u.vehicleCount;
    }

    const info = this.renderer.info;
    const canvas = this.renderer.domElement;
    this.opts.onPerformanceStats({
      fps: (n * 1000) / this.perfElapsedMs,
      frameMs: avgFrame,
      frameMsMin: sorted[0] ?? 0,
      frameMsP95: p95,
      frameMsMax: this.perfFrameMaxMs,
      longFrames: this.perfLongFrames,
      cpuMs: avgCpu,
      updateMs: this.perfUpdateMs / n,
      renderMs: this.perfRenderMs / n,
      labelMs: this.perfLabelMs / n,
      otherMs: Math.max(0, avgFrame - avgCpu),
      gpuMs: this.gpuMsLast,
      gpuSupported: this.gpuSupported,
      gpuRenderer: this.gpuRenderer,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      pixelRatio: this.renderer.getPixelRatio(),
      unitCount: this.units.size,
      activeUnitCount: activeUnits,
      vehicleCount: vehicles,
      focused: this.focusKey !== null,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      frameSamples: [...this.frameTrace],
    });

    this.perfFrames = 0;
    this.perfElapsedMs = 0;
    this.perfUpdateMs = 0;
    this.perfRenderMs = 0;
    this.perfLabelMs = 0;
    this.perfCpuMs = 0;
    this.perfFrameMaxMs = 0;
    this.perfLongFrames = 0;
    this.perfWindowSamples.length = 0;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    if (this.overviewFrameTimer) clearTimeout(this.overviewFrameTimer);
    if (this.gpuQuery) {
      (this.renderer.getContext() as WebGL2RenderingContext).deleteQuery(this.gpuQuery);
      this.gpuQuery = null;
    }
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

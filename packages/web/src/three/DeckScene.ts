import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { MapWireframe, WorldSnapshot } from '@gsm/protocol';
import { MatchUnit, type SharedAssets } from './MatchUnit';

/**
 * Standalone single-arena viewer for the deck dock. It holds a pool of fed
 * MatchUnits (all parked at the origin, hidden) and shows exactly ONE at a time
 * — the card you opened — with OrbitControls. No grid / "plaza" overview: the
 * card blooms into its own 3D scene (the CSS bloom lives in DeckApp; this just
 * frames + orbits the active arena).
 */
export class DeckScene {
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
  private activeKey: string | null = null;

  private tmpBox = new THREE.Box3();
  private tmpSphere = new THREE.Sphere();

  constructor(private container: HTMLElement) {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 20000);
    this.camera.position.set(20, 18, 26);

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
    this.controls.enabled = false;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(60, 120, 40);
    this.scene.add(dir);

    this.spot = new THREE.SpotLight(0xffffff, 0, 0, Math.PI / 6, 0.4, 0);
    this.scene.add(this.spot, this.spot.target);

    this.grid = new THREE.GridHelper(120, 60, 0x2a4a66, 0x16242f);
    const gm = this.grid.material as THREE.Material;
    gm.transparent = true;
    gm.opacity = 0.22;
    this.grid.visible = false;
    this.scene.add(this.grid);

    const bodyGeo = new THREE.ConeGeometry(0.28, 0.5, 3);
    bodyGeo.rotateX(Math.PI / 2);
    this.shared = { bodyGeo };

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.animate();
  }

  addUnit(key: string, label: string): MatchUnit {
    let u = this.units.get(key);
    if (u) {
      u.setLabel(label);
      return u;
    }
    u = new MatchUnit(key, label, this.shared);
    u.root.visible = false;
    this.scene.add(u.root);
    this.units.set(key, u);
    return u;
  }

  removeUnit(key: string): void {
    const u = this.units.get(key);
    if (!u) return;
    if (this.activeKey === key) this.hide();
    u.dispose();
    this.scene.remove(u.root);
    this.units.delete(key);
  }

  setMap(key: string, map: MapWireframe): void {
    this.units.get(key)?.setMap(map);
    if (key === this.activeKey) this.frame(key);
  }

  updateSnapshot(key: string, snap: WorldSnapshot): void {
    this.units.get(key)?.updateSnapshot(snap);
  }

  /** Reveal one match's arena (hide the rest) and enable orbit. */
  show(key: string): void {
    const u = this.units.get(key);
    if (!u) return;
    this.activeKey = key;
    for (const x of this.units.values()) x.root.visible = x.key === key;
    u.setState('focused');
    this.grid.visible = true;
    this.frame(key);
    this.controls.enabled = true;
  }

  hide(): void {
    if (this.activeKey) this.units.get(this.activeKey)?.setState('normal');
    this.activeKey = null;
    for (const x of this.units.values()) x.root.visible = false;
    this.grid.visible = false;
    this.controls.enabled = false;
    this.spot.intensity = 0;
  }

  private frame(key: string): void {
    const u = this.units.get(key);
    if (!u) return;
    const sph = u.worldBounds(this.tmpBox).getBoundingSphere(this.tmpSphere);
    const c = sph.center;
    this.spot.position.set(c.x, 60, c.z);
    this.spot.target.position.copy(c);
    this.spot.intensity = 3;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    const dist = Math.max(sph.radius / Math.sin(fov / 2), sph.radius / Math.sin(hFov / 2)) * 1.2;
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(new THREE.Vector3(0, 0.62, 1).normalize(), dist);
    this.camera.lookAt(c);
    this.controls.update();
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  private animate = (): void => {
    this.raf = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.controls.update();
    if (this.activeKey) this.units.get(this.activeKey)?.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const u of this.units.values()) {
      u.dispose();
      this.scene.remove(u.root);
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

import * as THREE from 'three';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';

export interface MapModelDef {
  /** URL of a model asset under web/public (loaded by ThreeMFLoader). */
  url: string;
  /** Extra yaw (radians) applied to the assembled arena, to face it correctly. */
  rotateY?: number;
  /**
   * The asset is half the field — build the full field by adding a second copy
   * rotated 180° about the vertical axis, abutting at the centre line (x=0).
   * RMUC fields are centrally (180°) symmetric, so this reproduces the layout.
   */
  join?: 'half-x-180';
}

/**
 * Game maps that have a 3D "sandbox" model instead of the generic wireframe.
 * Keyed by a normalized mapId (lowercased, alnum only), so `RMUC2026`,
 * `RMUC2026AI`, `RMUC-2026` etc. all resolve. The game sends `mapId` on the
 * `monitor.mapGeometry` feed; the mock does too.
 */
const REGISTRY: Record<string, MapModelDef> = {
  rmuc2026: { url: '/maps/RMUC2026_Half.3mf', join: 'half-x-180' },
  rmuc2026ai: { url: '/maps/RMUC2026_Half.3mf', join: 'half-x-180' },
};

const normalize = (mapId: string | number): string =>
  String(mapId).toLowerCase().replace(/[^a-z0-9]/g, '');

/** The sandbox model for a map, or null if it should fall back to the wireframe. */
export function mapModelFor(mapId: string | number | undefined): MapModelDef | null {
  if (mapId == null) return null;
  return REGISTRY[normalize(mapId)] ?? null;
}

export interface LoadedMapModel {
  /** Group rooted at (0,0,0): Y-up, centred on XZ, sitting on y=0, scale 1. */
  object: THREE.Group;
  /** Shared material across the model's meshes — for focus styling + disposal. */
  material: THREE.MeshStandardMaterial;
  /** Natural-scale bounding-box size, so the caller can fit it to a footprint. */
  footprint: { x: number; y: number; z: number };
}

const cache = new Map<string, Promise<THREE.Group>>();

function rawLoad(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    new ThreeMFLoader().load(url, resolve, undefined, reject);
  });
}

function monitorMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x3b566e,
    roughness: 0.7,
    metalness: 0.15,
    transparent: true,
    opacity: 0.92,
    flatShading: true,
  });
}

/**
 * Loads (cached) the map model and returns a fresh, normalized instance:
 * Y-up (3MF is Z-up — the same rotation `ueToThree` applies to telemetry),
 * centred on XZ, sitting on y=0, with a monitor-styled material that responds
 * to the scene lights / focus spotlight. The raw 3MF carries a print-bed build
 * scale; absolute size is irrelevant because the caller fits it to a footprint.
 */
export async function loadMapModel(def: MapModelDef): Promise<LoadedMapModel> {
  let p = cache.get(def.url);
  if (!p) {
    p = rawLoad(def.url);
    cache.set(def.url, p);
  }
  const base = await p;
  const material = monitorMaterial();

  // One half: cloned (geometry stays shared with the cache; material is per-load),
  // monitor-styled, and rotated Z-up→Y-up inside a wrapper so it can be translated
  // cleanly afterwards.
  const makeHalf = (): { obj: THREE.Object3D; box: THREE.Box3 } => {
    const mesh = base.clone(true);
    mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = material;
    });
    const wrap = new THREE.Group();
    wrap.rotation.x = -Math.PI / 2; // 3MF Z-up -> three Y-up (matches ueToThree)
    wrap.add(mesh);
    wrap.updateMatrixWorld(true);
    return { obj: wrap, box: new THREE.Box3().setFromObject(wrap) };
  };

  // Anchor a half so it spans x:[0,L], z centred, sitting on y=0.
  const anchor = (h: { obj: THREE.Object3D; box: THREE.Box3 }): void => {
    h.obj.position.set(-h.box.min.x, -h.box.min.y, -(h.box.min.z + h.box.max.z) / 2);
  };

  const root = new THREE.Group();
  const a = makeHalf();
  anchor(a);
  root.add(a.obj);

  if (def.join === 'half-x-180') {
    // Full field = this half + the same half rotated 180° about the vertical axis,
    // abutting at the centre line (x=0) → spans x:[-L, L].
    const b = makeHalf();
    anchor(b);
    const rot = new THREE.Group();
    rot.rotation.y = Math.PI; // (x,z) -> (-x,-z): b spans x:[-L,0]
    rot.add(b.obj);
    root.add(rot);
  }

  if (def.rotateY) root.rotation.y = def.rotateY;

  // Centre the assembled arena at the origin, sitting on y=0.
  root.updateMatrixWorld(true);
  const rb = new THREE.Box3().setFromObject(root);
  root.position.set(
    -(rb.min.x + rb.max.x) / 2,
    -rb.min.y,
    -(rb.min.z + rb.max.z) / 2
  );

  const holder = new THREE.Group();
  holder.add(root);
  return {
    object: holder,
    material,
    footprint: { x: rb.max.x - rb.min.x, y: rb.max.y - rb.min.y, z: rb.max.z - rb.min.z },
  };
}

/** Dispose a loaded model's per-instance material. Geometry is shared with the cache — left intact. */
export function disposeMapModel(model: LoadedMapModel): void {
  model.material.dispose();
}

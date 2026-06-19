import * as THREE from 'three';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { UE_TO_M } from './coords';

export interface MapModelDef {
  /** URL of a model asset under web/public (loaded by ThreeMFLoader). */
  url: string;
  /** Extra yaw (radians) applied to the assembled arena, to face it correctly. */
  rotateY?: number;
  /** Extra yaw (radians) applied to each half before anchoring/joining. */
  halfRotateY?: number;
  /** Mirror the assembled model left/right across the final long axis. */
  mirrorLongAxis?: boolean;
  /** World-space vertical offset in metres, applied after fitting. */
  sinkMeters?: number;
  /**
   * Nominal UE Y coordinates of the red/blue base anchors in the sandbox model.
   * Used to align the model against live player-observable base positions.
   */
  baseAnchorY?: { red: number; blue: number };
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
const RMUC2026: MapModelDef = {
  url: '/maps/RMUC2026_Half.3mf',
  join: 'half-x-180',
  halfRotateY: Math.PI,
  mirrorLongAxis: true,
  sinkMeters: 0.6,
  baseAnchorY: { red: -1185, blue: 1185 },
};

const REGISTRY: Record<string, MapModelDef> = {
  rmuc2026: RMUC2026,
  rmuc2026ai: RMUC2026,
};

/**
 * The live LAN beacon advertises a NUMERIC `mapId` (the game's map-select index),
 * not a string — e.g. the full RMUC2026 standard field is index 9 (and 4), and its
 * 1v1 / IF cuts (7, 8) reuse the same arena. Map those onto the RMUC2026 sandbox
 * model so a live match renders the field instead of falling back to the wireframe.
 * (Map indices are part of the player-observable beacon contract.)
 */
const NUMERIC_ALIASES: Record<number, MapModelDef> = {
  4: RMUC2026,
  7: RMUC2026,
  8: RMUC2026,
  9: RMUC2026,
};

const normalize = (mapId: string | number): string =>
  String(mapId).toLowerCase().replace(/[^a-z0-9]/g, '');

/** The sandbox model for a map, or null if it should fall back to the wireframe. */
export function mapModelFor(mapId: string | number | undefined): MapModelDef | null {
  if (mapId == null) return null;
  if (typeof mapId === 'number' && NUMERIC_ALIASES[mapId]) return NUMERIC_ALIASES[mapId];
  // A numeric id can also arrive as a string ("9"); a non-RMUC string still resolves by name.
  const asNum = Number(mapId);
  if (Number.isInteger(asNum) && NUMERIC_ALIASES[asNum]) return NUMERIC_ALIASES[asNum];
  return REGISTRY[normalize(mapId)] ?? null;
}

export interface LoadedMapModel {
  /** Group rooted at (0,0,0): Y-up, centred on XZ, sitting on y=0, scale 1. */
  object: THREE.Group;
  /** Shared material across the model's meshes — for focus styling + disposal. */
  material: THREE.MeshStandardMaterial;
  /** Natural-scale bounding-box size, so the caller can fit it to a footprint. */
  footprint: { x: number; y: number; z: number };
  /** World-space vertical offset in metres to apply after fitting. */
  sinkMeters: number;
  /** Whether the caller should mirror the fitted model across the final long axis. */
  mirrorLongAxis: boolean;
  /** Three-space Z positions for the model's nominal red/blue base anchors. */
  baseAnchorZ?: { red: number; blue: number };
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
    side: THREE.DoubleSide,
    flatShading: true,
  });
}

/**
 * Loads (cached) the map model and returns a fresh, normalized instance:
 * Y-up (3MF is Z-up) with the same X mirror that `ueToThree` applies to
 * telemetry, centred on XZ, sitting on y=0, with a monitor-styled material that
 * responds to the scene lights / focus spotlight. The raw 3MF carries a
 * print-bed build scale; absolute size is irrelevant because the caller fits it
 * to a footprint.
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
    const normalized = new THREE.Group();
    normalized.rotation.x = -Math.PI / 2; // 3MF Z-up -> three Y-up
    normalized.scale.x = -1; // mirror to match ueToThree's field orientation
    normalized.add(mesh);

    const wrap = new THREE.Group();
    if (def.halfRotateY) wrap.rotation.y = def.halfRotateY;
    wrap.add(normalized);
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
    sinkMeters: def.sinkMeters ?? 0,
    mirrorLongAxis: def.mirrorLongAxis === true,
    baseAnchorZ: def.baseAnchorY
      ? { red: -def.baseAnchorY.red * UE_TO_M, blue: -def.baseAnchorY.blue * UE_TO_M }
      : undefined,
  };
}

/** Dispose a loaded model's per-instance material. Geometry is shared with the cache — left intact. */
export function disposeMapModel(model: LoadedMapModel): void {
  model.material.dispose();
}

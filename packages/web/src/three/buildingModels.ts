import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  createSurfaceCorruptionUniforms,
  installSurfaceCorruptionMaterial,
  type SurfaceCorruptionUniforms,
} from './surfaceCorruptionMaterial';

export type BuildingModelKind = 'base' | 'outpost';
type BuildingState = 'normal' | 'focused' | 'dim';

interface BuildingModelDef {
  url: string;
  yawOffset: number;
  worldOffset?: { x: number; y: number; z: number };
}

export interface LoadedBuildingModel {
  kind: BuildingModelKind;
  object: THREE.Group;
  material: THREE.MeshStandardMaterial;
  wireMaterial: THREE.LineBasicMaterial;
  edgeGeometries: THREE.BufferGeometry[];
  corruptionUniforms: SurfaceCorruptionUniforms;
  worldOffset: THREE.Vector3;
  mixer: THREE.AnimationMixer | null;
  baseAction: THREE.AnimationAction | null;
  baseAnimationDuration: number;
  baseOpenAmount: number;
  phaseOffset: number;
  lastUpdateSeconds: number | null;
  rotor: THREE.Object3D | null;
  rotorBaseQuaternion: THREE.Quaternion | null;
}

const DEFS: Record<BuildingModelKind, BuildingModelDef> = {
  base: {
    url: '/models/buildings/base.glb',
    yawOffset: -Math.PI / 2,
    worldOffset: { x: 0.18, y: 0, z: 0 },
  },
  outpost: { url: '/models/buildings/outpost.glb', yawOffset: Math.PI / 2 },
};

interface RawBuildingModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const cache = new Map<BuildingModelKind, Promise<RawBuildingModel>>();
const OUTPOST_SPIN_AXIS = new THREE.Vector3(1, 0, 0);
const DESTROYED_BODY_COLOR = 0x8d969b;
const DESTROYED_WIRE_COLOR = 0xc5cdd2;
const tmpRotorSpin = new THREE.Quaternion();

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function rawLoad(kind: BuildingModelKind): Promise<RawBuildingModel> {
  let p = cache.get(kind);
  if (!p) {
    p = new Promise((resolve, reject) => {
      new GLTFLoader().load(
        DEFS[kind].url,
        (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
        undefined,
        reject
      );
    });
    cache.set(kind, p);
  }
  return p;
}

function holoMaterial(uniforms: SurfaceCorruptionUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0x5cd6ff,
    emissive: 0x5cd6ff,
    emissiveIntensity: 0.38,
    roughness: 0.42,
    metalness: 0.08,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
  material.toneMapped = false;
  installSurfaceCorruptionMaterial(material, uniforms, 'building');
  return material;
}

function holoWireMaterial(): THREE.LineBasicMaterial {
  const material = new THREE.LineBasicMaterial({
    color: 0x7de7ff,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  material.toneMapped = false;
  return material;
}

function countBoneDescendants(object: THREE.Object3D): number {
  let count = 0;
  for (const child of object.children) {
    if ((child as THREE.Bone).isBone) count += 1 + countBoneDescendants(child);
  }
  return count;
}

function findOutpostRotor(object: THREE.Object3D): THREE.Object3D | null {
  const bones: THREE.Bone[] = [];
  object.traverse((o) => {
    const bone = o as THREE.Bone;
    if (bone.isBone) bones.push(bone);
  });
  if (bones.length === 0) return null;

  const candidates = bones
    .filter((bone) => bone.parent && (bone.parent as THREE.Bone).isBone)
    .map((bone) => ({ bone, descendants: countBoneDescendants(bone) }))
    .filter((candidate) => candidate.descendants > 0)
    .sort((a, b) => b.descendants - a.descendants);

  return candidates[0]?.bone ?? bones[1] ?? null;
}

export async function loadBuildingModel(kind: BuildingModelKind): Promise<LoadedBuildingModel> {
  const raw = await rawLoad(kind);
  const def = DEFS[kind];
  const object = SkeletonUtils.clone(raw.scene) as THREE.Group;
  object.rotation.y += def.yawOffset;
  const corruptionUniforms = createSurfaceCorruptionUniforms();
  const material = holoMaterial(corruptionUniforms);
  const wireMaterial = holoWireMaterial();
  const meshes: THREE.Mesh[] = [];
  const edgeGeometries: THREE.BufferGeometry[] = [];
  const worldOffset = new THREE.Vector3(
    def.worldOffset?.x ?? 0,
    def.worldOffset?.y ?? 0,
    def.worldOffset?.z ?? 0
  );

  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes.push(mesh);
  });

  for (const mesh of meshes) {
    mesh.material = material;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;

    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) continue;

    const edgeGeometry = new THREE.EdgesGeometry(mesh.geometry, 34);
    edgeGeometries.push(edgeGeometry);
    const wire = new THREE.LineSegments(edgeGeometry, wireMaterial);
    wire.renderOrder = 4;
    wire.frustumCulled = false;
    mesh.add(wire);
  }

  let mixer: THREE.AnimationMixer | null = null;
  let baseAction: THREE.AnimationAction | null = null;
  let baseAnimationDuration = 0;
  if (kind === 'base' && raw.animations.length > 0) {
    const clip = raw.animations[0];
    mixer = new THREE.AnimationMixer(object);
    baseAction = mixer.clipAction(clip);
    baseAction.setLoop(THREE.LoopOnce, 1);
    baseAction.clampWhenFinished = true;
    baseAction.enabled = true;
    baseAction.play();
    baseAnimationDuration = clip.duration;
    mixer.setTime(0);
  }

  const rotor = kind === 'outpost' ? findOutpostRotor(object) : null;

  return {
    kind,
    object,
    material,
    wireMaterial,
    edgeGeometries,
    corruptionUniforms,
    worldOffset,
    mixer,
    baseAction,
    baseAnimationDuration,
    baseOpenAmount: 0,
    phaseOffset: Math.random(),
    lastUpdateSeconds: null,
    rotor,
    rotorBaseQuaternion: rotor ? rotor.quaternion.clone() : null,
  };
}

export function styleBuildingModel(
  model: LoadedBuildingModel,
  color: number,
  state: BuildingState,
  destroyed = false
): void {
  const displayColor = destroyed ? DESTROYED_BODY_COLOR : color;
  const opacity = destroyed
    ? state === 'focused' ? 0.34 : state === 'dim' ? 0.08 : 0.24
    : state === 'focused' ? 0.38 : state === 'dim' ? 0.1 : 0.24;
  const wireOpacity = destroyed
    ? state === 'focused' ? 0.48 : state === 'dim' ? 0.1 : 0.34
    : state === 'focused' ? 0.38 : state === 'dim' ? 0.07 : 0.2;
  const corruptionIntensity = destroyed
    ? state === 'focused' ? 0.85 : state === 'dim' ? 0.28 : 0.62
    : 0;
  model.object.scale.y = 1;
  model.material.color.setHex(displayColor);
  model.material.emissive.setHex(displayColor);
  model.material.emissiveIntensity = destroyed
    ? state === 'focused' ? 0.36 : state === 'dim' ? 0.08 : 0.22
    : state === 'focused' ? 0.62 : state === 'dim' ? 0.12 : 0.32;
  model.material.opacity = opacity;
  model.wireMaterial.color.setHex(destroyed ? DESTROYED_WIRE_COLOR : displayColor);
  model.wireMaterial.opacity = wireOpacity;
  model.corruptionUniforms.active.value = destroyed ? 1 : 0;
  model.corruptionUniforms.intensity.value = corruptionIntensity;
}

export function updateBuildingModel(
  model: LoadedBuildingModel,
  elapsedSeconds: number,
  destroyed = false,
  deployed?: boolean
): void {
  if (model.kind === 'base' && model.mixer && model.baseAction && model.baseAnimationDuration > 0) {
    const dt =
      model.lastUpdateSeconds == null
        ? 0
        : Math.max(0, Math.min(0.25, elapsedSeconds - model.lastUpdateSeconds));
    const targetOpenAmount = destroyed
      ? 0.86 + Math.sin(elapsedSeconds * 14 + model.phaseOffset * 8) * 0.025
      : deployed === true
        ? 1
        : 0;
    if (model.lastUpdateSeconds == null || destroyed) {
      model.baseOpenAmount = targetOpenAmount;
    } else {
      const alpha = 1 - Math.exp(-7.5 * dt);
      model.baseOpenAmount += (targetOpenAmount - model.baseOpenAmount) * alpha;
      if (Math.abs(model.baseOpenAmount - targetOpenAmount) < 0.001) {
        model.baseOpenAmount = targetOpenAmount;
      }
    }
    model.baseAction.enabled = true;
    model.baseAction.paused = false;
    model.mixer.setTime(model.baseAnimationDuration * clamp01(model.baseOpenAmount));
  }
  model.lastUpdateSeconds = elapsedSeconds;

  if (model.kind === 'outpost' && model.rotor && model.rotorBaseQuaternion) {
    const spinSpeed = destroyed ? 0.08 : 1.45;
    const stutter = destroyed ? Math.sin(elapsedSeconds * 18 + model.phaseOffset * 6) * 0.025 : 0;
    tmpRotorSpin.setFromAxisAngle(OUTPOST_SPIN_AXIS, elapsedSeconds * spinSpeed + stutter);
    model.rotor.quaternion.copy(model.rotorBaseQuaternion).multiply(tmpRotorSpin);
    model.rotor.updateMatrixWorld(true);
  }

  model.corruptionUniforms.time.value = elapsedSeconds + model.phaseOffset * 9;
}

export function disposeBuildingModel(model: LoadedBuildingModel): void {
  model.baseAction?.stop();
  model.mixer?.stopAllAction();
  model.mixer?.uncacheRoot(model.object);
  model.material.dispose();
  model.wireMaterial.dispose();
  for (const geometry of model.edgeGeometries) geometry.dispose();
}

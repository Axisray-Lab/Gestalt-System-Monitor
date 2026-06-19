import * as THREE from 'three';
import type { Vec3 } from '@gsm/protocol';

/**
 * Coordinate mapping Unreal -> Three.js.
 *   UE:    centimetres, Z-up, left-handed  (X forward, Y right, Z up)
 *   Three: metres,      Y-up, right-handed
 * Mapping: three.x = -ue.x, three.y = ue.z, three.z = -ue.y, scaled cm -> m.
 * Uniform scale means directions are preserved (safe to reuse for headings).
 */
export const UE_TO_M = 0.01;

export function ueToThree(v: Vec3, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(-v.x * UE_TO_M, v.z * UE_TO_M, -v.y * UE_TO_M);
}

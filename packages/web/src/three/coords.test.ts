import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@gsm/protocol';
import { UE_TO_M, ueToThree } from './coords';

describe('ueToThree', () => {
  it('maps UE origin to Three.js origin', () => {
    const ue: Vec3 = { x: 0, y: 0, z: 0 };
    const result = ueToThree(ue);
    // toBeCloseTo, not toBe: -0 * scale === -0, which !== +0 under Object.is.
    expect(result.x).toBeCloseTo(0, 6);
    expect(result.y).toBeCloseTo(0, 6);
    expect(result.z).toBeCloseTo(0, 6);
  });

  it('applies cm→m scale, X flip, Y/Z swap, and Z sign flip', () => {
    // Mapping (UE cm, Z-up, left-handed → Three m, Y-up, right-handed):
    //   three.x = -ue.x * 0.01
    //   three.y =  ue.z * 0.01
    //   three.z = -ue.y * 0.01
    // UE: X=200cm forward, Y=100cm right, Z=300cm up
    const ue: Vec3 = { x: 200, y: 100, z: 300 };
    const result = ueToThree(ue);
    expect(result.x).toBeCloseTo(-2, 6);
    expect(result.y).toBeCloseTo(3, 6);
    expect(result.z).toBeCloseTo(-1, 6);
  });

  it('preserves direction under uniform scale', () => {
    // A direction vector whose length is not 1 — the uniform ×0.01 scale
    // applies to every axis, so normalizing the result cancels the scale.
    const ueDir: Vec3 = { x: 3, y: -2, z: 7 };
    const ueLen = Math.sqrt(ueDir.x ** 2 + ueDir.y ** 2 + ueDir.z ** 2);

    const threeDir = ueToThree(ueDir);

    // Length scales uniformly by UE_TO_M.
    expect(threeDir.length()).toBeCloseTo(ueLen * UE_TO_M, 6);

    // After removing the scale via normalize(), the direction should match
    // the X-flipped, Y/Z-swapped, Z-flipped UE direction.
    const normalized = threeDir.clone().normalize();
    expect(normalized.x).toBeCloseTo(-(ueDir.x / ueLen), 6);
    expect(normalized.y).toBeCloseTo(ueDir.z / ueLen, 6);
    expect(normalized.z).toBeCloseTo(-(ueDir.y / ueLen), 6);
  });
});

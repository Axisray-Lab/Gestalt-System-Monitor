import * as THREE from 'three';

export interface SurfaceCorruptionUniforms {
  active: { value: number };
  time: { value: number };
  intensity: { value: number };
}

export function createSurfaceCorruptionUniforms(): SurfaceCorruptionUniforms {
  return {
    active: { value: 0 },
    time: { value: 0 },
    intensity: { value: 0 },
  };
}

export function installSurfaceCorruptionMaterial(
  material: THREE.MeshStandardMaterial,
  uniforms: SurfaceCorruptionUniforms,
  cacheKey = 'default'
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCorruptActive = uniforms.active;
    shader.uniforms.uCorruptTime = uniforms.time;
    shader.uniforms.uCorruptIntensity = uniforms.intensity;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
varying vec3 vCorruptLocal;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vCorruptLocal = position;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform float uCorruptActive;
uniform float uCorruptTime;
uniform float uCorruptIntensity;
varying vec3 vCorruptLocal;

float gsmCorruptHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphamap_fragment>',
      `#include <alphamap_fragment>
if (uCorruptActive > 0.001) {
  vec3 cell = floor(vCorruptLocal * vec3(9.0, 15.0, 9.0));
  float timeCell = floor(uCorruptTime * 9.0);
  float noise = gsmCorruptHash(cell.xz + vec2(cell.y * 13.0 + timeCell, timeCell * 0.37));
  float band = gsmCorruptHash(vec2(cell.y, timeCell * 0.71));
  float blockMask = step(0.74, noise) * step(0.42, band);
  float scan = step(0.965, sin(vCorruptLocal.y * 34.0 + uCorruptTime * 18.0) * 0.5 + 0.5);
  float corruption = uCorruptActive * uCorruptIntensity * max(blockMask, scan * 0.45);
  vec3 deadGrey = vec3(0.56, 0.60, 0.62);
  vec3 dataWhite = vec3(0.80, 0.90, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(deadGrey, dataWhite, noise), corruption);
  diffuseColor.a *= 1.0 - uCorruptActive * step(0.9, gsmCorruptHash(cell.xy + timeCell)) * 0.22;
}`
    );
  };
  material.customProgramCacheKey = () => `gsm-surface-corruption-v1:${cacheKey}`;
}

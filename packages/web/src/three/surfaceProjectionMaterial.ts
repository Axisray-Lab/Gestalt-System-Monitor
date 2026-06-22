import * as THREE from 'three';

export const MAX_SURFACE_PROJECTIONS = 32;

export interface SurfaceProjection {
  x: number;
  z: number;
  color: number;
}

interface ProjectionUniforms {
  count: { value: number };
  rings: { value: THREE.Vector4[] };
  colors: { value: THREE.Color[] };
  worldToRoot: { value: THREE.Matrix4 };
  opacity: { value: number };
}

interface ProjectionUserData extends Record<string, unknown> {
  gsmProjectionUniforms?: ProjectionUniforms;
}

function makeUniforms(): ProjectionUniforms {
  return {
    count: { value: 0 },
    rings: { value: Array.from({ length: MAX_SURFACE_PROJECTIONS }, () => new THREE.Vector4()) },
    colors: { value: Array.from({ length: MAX_SURFACE_PROJECTIONS }, () => new THREE.Color()) },
    worldToRoot: { value: new THREE.Matrix4() },
    opacity: { value: 0.62 },
  };
}

export function installSurfaceProjectionMaterial(material: THREE.MeshStandardMaterial): void {
  const userData = material.userData as ProjectionUserData;
  if (userData.gsmProjectionUniforms) return;

  const uniforms = makeUniforms();
  userData.gsmProjectionUniforms = uniforms;
  const previousOnBeforeCompile = material.onBeforeCompile.bind(material);
  const previousCacheKey = material.customProgramCacheKey.bind(material);

  material.onBeforeCompile = (shader, renderer) => {
    previousOnBeforeCompile(shader, renderer);
    const shaderWithExtensions = shader as unknown as {
      extensions?: { derivatives?: boolean };
    };
    shaderWithExtensions.extensions ??= {};
    shaderWithExtensions.extensions.derivatives = true;
    shader.uniforms.gsmProjectionCount = uniforms.count;
    shader.uniforms.gsmProjectionRing = uniforms.rings;
    shader.uniforms.gsmProjectionColor = uniforms.colors;
    shader.uniforms.gsmProjectionWorldToRoot = uniforms.worldToRoot;
    shader.uniforms.gsmProjectionOpacity = uniforms.opacity;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform mat4 gsmProjectionWorldToRoot;
varying vec3 gsmProjectionRootPosition;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
gsmProjectionRootPosition = (gsmProjectionWorldToRoot * modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
#define GSM_MAX_SURFACE_PROJECTIONS ${MAX_SURFACE_PROJECTIONS}
uniform int gsmProjectionCount;
uniform vec4 gsmProjectionRing[GSM_MAX_SURFACE_PROJECTIONS];
uniform vec3 gsmProjectionColor[GSM_MAX_SURFACE_PROJECTIONS];
uniform float gsmProjectionOpacity;
varying vec3 gsmProjectionRootPosition;`
      )
      .replace(
        '#include <dithering_fragment>',
        `
// All work here is gated on a uniform count, so a board with no active
// projections (overview, dimmed, or any non-focused board — count stays 0)
// pays only one uniform branch instead of a full 32-iteration per-fragment
// loop. This matters most in focus, where the (transparent, overdrawn) sandbox
// model fills the viewport. Because the loop bound is a uniform, control flow
// stays uniform across the quad and the in-loop fwidth derivatives are valid.
if (gsmProjectionCount > 0) {
  vec3 gsmProjectionBestColor = vec3(0.0);
  float gsmProjectionBestAlpha = 0.0;
  vec3 gsmProjectionDx = dFdx(gsmProjectionRootPosition);
  vec3 gsmProjectionDy = dFdy(gsmProjectionRootPosition);
  vec3 gsmProjectionFaceNormal = cross(gsmProjectionDx, gsmProjectionDy);
  float gsmProjectionUp = abs(gsmProjectionFaceNormal.y / max(length(gsmProjectionFaceNormal), 0.0001));
  float gsmProjectionSurfaceMask = smoothstep(0.025, 0.08, gsmProjectionUp);
  for (int gsmProjectionIndex = 0; gsmProjectionIndex < GSM_MAX_SURFACE_PROJECTIONS; gsmProjectionIndex++) {
    if (gsmProjectionIndex >= gsmProjectionCount) break;
    vec4 gsmRing = gsmProjectionRing[gsmProjectionIndex];
    float gsmDistance = length(gsmProjectionRootPosition.xz - gsmRing.xy);
    float gsmEdge = max(fwidth(gsmDistance) * 1.5, 0.008);
    float gsmRingMask =
      smoothstep(gsmRing.z - gsmEdge, gsmRing.z + gsmEdge, gsmDistance) *
      (1.0 - smoothstep(gsmRing.w - gsmEdge, gsmRing.w + gsmEdge, gsmDistance)) *
      gsmProjectionSurfaceMask;
    float gsmAlpha = gsmRingMask * gsmProjectionOpacity;
    if (gsmAlpha > gsmProjectionBestAlpha) {
      gsmProjectionBestAlpha = gsmAlpha;
      gsmProjectionBestColor = gsmProjectionColor[gsmProjectionIndex];
    }
  }
  if (gsmProjectionBestAlpha > 0.0) {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, gsmProjectionBestColor, min(gsmProjectionBestAlpha, 0.86));
    gl_FragColor.rgb += gsmProjectionBestColor * gsmProjectionBestAlpha * 0.24;
  }
}
#include <dithering_fragment>`
      );
  };

  material.customProgramCacheKey = () =>
    `${previousCacheKey()}|gsm-surface-projection-v2`;
  material.needsUpdate = true;
}

export function updateSurfaceProjectionMaterial(
  material: THREE.MeshStandardMaterial,
  root: THREE.Object3D,
  projections: readonly SurfaceProjection[],
  inner: number,
  outer: number,
  opacity: number
): void {
  installSurfaceProjectionMaterial(material);
  const uniforms = (material.userData as ProjectionUserData).gsmProjectionUniforms;
  if (!uniforms) return;

  root.updateWorldMatrix(true, true);
  uniforms.worldToRoot.value.copy(root.matrixWorld).invert();
  uniforms.opacity.value = opacity;
  uniforms.count.value = Math.min(projections.length, MAX_SURFACE_PROJECTIONS);
  for (let i = 0; i < uniforms.count.value; i++) {
    const projection = projections[i];
    uniforms.rings.value[i].set(projection.x, projection.z, inner, outer);
    uniforms.colors.value[i].setHex(projection.color);
  }
}

export function clearSurfaceProjectionMaterial(material: THREE.MeshStandardMaterial | null): void {
  const uniforms = (material?.userData as ProjectionUserData | undefined)?.gsmProjectionUniforms;
  if (uniforms) uniforms.count.value = 0;
}

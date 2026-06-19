import * as THREE from 'three';
import { mapModelFor, loadMapModel, disposeMapModel } from './mapModels';

/**
 * One-off offscreen render of a map's sandbox model into a data-URL, used as the
 * static face of deck cards (a real 3D render, not a faux drawing). The deck
 * cards all show this; the live, orbitable 3D appears on focus via DioramaScene.
 */
export async function renderArenaThumbnail(
  mapId: string | number,
  width = 440,
  height = 230
): Promise<string | null> {
  const def = mapModelFor(mapId);
  if (!def) return null;

  let model;
  try {
    model = await loadMapModel(def);
  } catch (err) {
    console.error('[gsm] thumbnail load failed:', err);
    return null;
  }

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 1.05);
  dir.position.set(40, 90, 30);
  scene.add(dir);
  scene.add(model.object);

  const span = Math.max(model.footprint.x, model.footprint.z) * 1.3;
  const grid = new THREE.GridHelper(span, 24, 0x2a4a66, 0x16242f);
  const gm = grid.material as THREE.Material;
  gm.transparent = true;
  gm.opacity = 0.28;
  scene.add(grid);

  const sphere = new THREE.Box3().setFromObject(model.object).getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.PerspectiveCamera(46, width / height, 0.1, 5000);
  const fov = THREE.MathUtils.degToRad(cam.fov);
  const dist = (sphere.radius / Math.sin(fov / 2)) * 0.92;
  cam.position.copy(sphere.center).addScaledVector(new THREE.Vector3(0.32, 0.92, 0.62).normalize(), dist);
  cam.lookAt(sphere.center);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.setClearColor(0x0e151c, 1);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');

  renderer.dispose();
  renderer.domElement.remove();
  disposeMapModel(model);
  return url;
}

import * as THREE from 'three';
import type { CamerasResponse } from '@/api/types';

/**
 * Build a three.js group with a small frustum per camera frame plus a
 * polyline through the camera centres. Positions are in scene units (metres)
 * with +Y down (gravity); quaternions are [w, x, y, z] camera-to-world.
 */
export function buildTrajectory(cameras: CamerasResponse, opts: { size?: number } = {}): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trajectory';
  const frames = cameras.frames;
  if (frames.length === 0) return group;

  // Auto size the frustums from the spread of the path.
  const box = new THREE.Box3();
  for (const f of frames) box.expandByPoint(new THREE.Vector3(...f.position));
  const extent = box.getSize(new THREE.Vector3()).length() || 1;
  const s = opts.size ?? Math.max(0.03, Math.min(0.25, extent * 0.012));

  // Camera looks along +Z, +X right, +Y down (COLMAP convention).
  const w = s * 0.8;
  const h = s * 0.6;
  const d = s;
  const local: THREE.Vector3[] = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-w, -h, d),
    new THREE.Vector3(w, -h, d),
    new THREE.Vector3(w, h, d),
    new THREE.Vector3(-w, h, d),
  ];
  const edges: [number, number][] = [
    [0, 1], [0, 2], [0, 3], [0, 4],
    [1, 2], [2, 3], [3, 4], [4, 1],
  ];
  const frustumVerts = new Float32Array(frames.length * edges.length * 2 * 3);
  const frustumColors = new Float32Array(frames.length * edges.length * 2 * 3);
  const pathVerts = new Float32Array(frames.length * 3);
  const tmp = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  let k = 0;
  frames.forEach((f, i) => {
    const [qw, qx, qy, qz] = f.quaternion;
    q.set(qx, qy, qz, qw);
    const p = new THREE.Vector3(...f.position);
    pathVerts.set([p.x, p.y, p.z], i * 3);
    col.setHSL(0.6 - (i / Math.max(1, frames.length - 1)) * 0.45, 0.85, 0.55);
    for (const [a, b] of edges) {
      for (const idx of [a, b]) {
        tmp.copy(local[idx]).applyQuaternion(q).add(p);
        frustumVerts.set([tmp.x, tmp.y, tmp.z], k);
        frustumColors.set([col.r, col.g, col.b], k);
        k += 3;
      }
    }
  });

  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(frustumVerts, 3));
  fg.setAttribute('color', new THREE.BufferAttribute(frustumColors, 3));
  const fm = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false });
  const frustums = new THREE.LineSegments(fg, fm);
  frustums.renderOrder = 10;
  group.add(frustums);

  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pathVerts, 3));
  const pm = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false });
  const path = new THREE.Line(pg, pm);
  path.renderOrder = 9;
  group.add(path);

  return group;
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
}

/** Camera position ~4 m from the origin, slightly above the floor (+Y is down). */
export const DEFAULT_CAMERA_POS: [number, number, number] = [0, -1.2, 4];
export const DEFAULT_LOOK_AT: [number, number, number] = [0, 0, 0];
export const CAMERA_UP: [number, number, number] = [0, -1, 0];

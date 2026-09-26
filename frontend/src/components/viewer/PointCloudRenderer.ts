import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PointCloud } from '@/lib/ply';
import { CAMERA_UP, DEFAULT_CAMERA_POS, DEFAULT_LOOK_AT, disposeObject } from './trajectory';

/** Plain three.js renderer for the sparse point-cloud preview (no splat yet). */
export class PointCloudRenderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private points: THREE.Points | null = null;
  private raf = 0;
  private ro: ResizeObserver | null = null;
  private disposed = false;

  constructor(private root: HTMLElement) {
    const w = Math.max(1, root.clientWidth);
    const h = Math.max(1, root.clientHeight);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    root.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.05, 1000);
    this.camera.up.set(...CAMERA_UP);
    this.camera.position.set(...DEFAULT_CAMERA_POS);
    this.camera.lookAt(...DEFAULT_LOOK_AT);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(...DEFAULT_LOOK_AT);
    this.controls.update();
    this.scene.add(new THREE.GridHelper(10, 20, 0x446688, 0x223344));
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(root);
    }
    const loop = () => {
      if (this.disposed) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  resize() {
    const w = Math.max(1, this.root.clientWidth);
    const h = Math.max(1, this.root.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setPoints(cloud: PointCloud) {
    if (this.points) {
      this.scene.remove(this.points);
      disposeObject(this.points);
      this.points = null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
    if (cloud.colors) geo.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3));
    const mat = new THREE.PointsMaterial({ size: 0.02, vertexColors: !!cloud.colors, color: cloud.colors ? undefined : 0x9ec5ff, sizeAttenuation: true });
    this.points = new THREE.Points(geo, mat);
    this.scene.add(this.points);
  }

  resetView() {
    this.camera.position.set(...DEFAULT_CAMERA_POS);
    this.controls.target.set(...DEFAULT_LOOK_AT);
    this.controls.update();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => disposeObject(o));
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

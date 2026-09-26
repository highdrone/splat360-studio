import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Box, Maximize2, Minimize2, RefreshCw, Route } from 'lucide-react';
import type { Artifact, CamerasResponse } from '@/api/types';
import { api } from '@/api/endpoints';
import { ApiError, errorMessage } from '@/api/client';
import { parsePly } from '@/lib/ply';
import { formatNumber } from '@/lib/format';
import { ProgressBar, cx } from '@/components/ui';
import { PointCloudRenderer } from './viewer/PointCloudRenderer';
import { buildTrajectory, CAMERA_UP, DEFAULT_CAMERA_POS, DEFAULT_LOOK_AT, disposeObject } from './viewer/trajectory';
import type { Viewer as GsViewer } from '@mkkellogg/gaussian-splats-3d';

export type ViewerMode = 'splat' | 'points' | 'none';

export interface SplatViewerProps {
  projectId: string;
  artifacts: Artifact[];
  /** Bump to force a reload (e.g. after a job finishes). */
  reloadKey?: number;
  className?: string;
}

export function pickSource(artifacts: Artifact[]): { mode: ViewerMode; name: string | null } {
  const names = new Set(artifacts.map((a) => a.name));
  if (names.has('splat.ply')) return { mode: 'splat', name: 'splat.ply' };
  if (names.has('splat.splat')) return { mode: 'splat', name: 'splat.splat' };
  const ckpts = artifacts.filter((a) => /^checkpoint_(\d+)\.ply$/.test(a.name)).sort((a, b) => ckptIter(b.name) - ckptIter(a.name));
  if (ckpts.length > 0) return { mode: 'splat', name: ckpts[0].name };
  if (names.has('sparse_points.ply')) return { mode: 'points', name: 'sparse_points.ply' };
  return { mode: 'none', name: null };
}

function ckptIter(name: string): number {
  const m = name.match(/^checkpoint_(\d+)\.ply$/);
  return m ? parseInt(m[1], 10) : 0;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'empty';

export function SplatViewer({ projectId, artifacts, reloadKey = 0, className = '' }: SplatViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const gsRef = useRef<GsViewer | null>(null);
  const pcRef = useRef<PointCloudRenderer | null>(null);
  const trajRef = useRef<THREE.Group | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pointCount, setPointCount] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showTraj, setShowTraj] = useState(false);
  const [trajState, setTrajState] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'error'>('idle');
  const [cameras, setCameras] = useState<CamerasResponse | null>(null);
  const source = pickSource(artifacts);
  const sourceKey = `${source.mode}:${source.name}:${reloadKey}`;

  // --- load the scene ------------------------------------------------------
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    let cancelled = false;
    let abortLoad: (() => void) | null = null;
    const ctrl = new AbortController();
    setError(null);
    setProgress(0);
    setPointCount(null);
    trajRef.current = null;

    if (source.mode === 'none' || !source.name) {
      setPhase('empty');
      return;
    }
    setPhase('loading');
    const url = api.artifactUrl(projectId, source.name, true);

    if (source.mode === 'points') {
      let pc: PointCloudRenderer | null = null;
      try {
        pc = new PointCloudRenderer(host);
        pcRef.current = pc;
      } catch (e) {
        setPhase('error');
        setError(`WebGL is not available: ${errorMessage(e)}`);
        return;
      }
      (async () => {
        try {
          const res = await fetch(url, { signal: ctrl.signal });
          if (!res.ok) throw new ApiError(res.status, res.status === 404 ? 'Sparse point cloud not found.' : `${res.status} ${res.statusText}`);
          const total = Number(res.headers.get('content-length') ?? 0);
          const buf = await readWithProgress(res, total, (p) => !cancelled && setProgress(p));
          if (cancelled) return;
          const cloud = parsePly(buf, 1_500_000);
          pc?.setPoints(cloud);
          setPointCount(cloud.count);
          setPhase('ready');
        } catch (e) {
          if (cancelled || (e instanceof DOMException && e.name === 'AbortError')) return;
          setPhase('error');
          setError(errorMessage(e));
        }
      })();
      return () => {
        cancelled = true;
        ctrl.abort();
        pc?.dispose();
        if (pcRef.current === pc) pcRef.current = null;
      };
    }

    // Splat mode: the Gaussian splat viewer is loaded lazily to keep the main bundle small.
    let viewer: GsViewer | null = null;
    (async () => {
      try {
        const GS = await import('@mkkellogg/gaussian-splats-3d');
        if (cancelled) return;
        viewer = new GS.Viewer({
          rootElement: host,
          cameraUp: CAMERA_UP,
          initialCameraPosition: DEFAULT_CAMERA_POS,
          initialCameraLookAt: DEFAULT_LOOK_AT,
          sharedMemoryForWorkers: false,
          gpuAcceleratedSort: false,
          integerBasedSort: false,
          selfDrivenMode: true,
          useBuiltInControls: true,
          sceneRevealMode: GS.SceneRevealMode.Instant,
          logLevel: GS.LogLevel.None,
          threeScene: new THREE.Scene(),
        });
        gsRef.current = viewer;
        const format = source.name!.endsWith('.splat') ? GS.SceneFormat.Splat : GS.SceneFormat.Ply;
        const p = viewer.addSplatScene(url, {
          format,
          showLoadingUI: false,
          splatAlphaRemovalThreshold: 5,
          progressiveLoad: false,
          onProgress: (pct) => !cancelled && setProgress(Math.max(0, Math.min(1, pct / 100))),
        });
        abortLoad = () => {
          try {
            p.abort();
          } catch {
            /* ignore */
          }
        };
        await p;
        if (cancelled) return;
        viewer.start();
        setPhase('ready');
      } catch (e) {
        if (cancelled) return;
        setPhase('error');
        const msg = errorMessage(e);
        setError(/404|not found/i.test(msg) ? 'The splat file is missing on disk.' : msg);
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
      abortLoad?.();
      const v = viewer;
      if (gsRef.current === v) gsRef.current = null;
      if (v) {
        // dispose() removes the canvas and frees the GL context itself. It ends by
        // detaching rootElement from document.body, which rejects for a nested root;
        // that is expected and harmless, so the rejection is swallowed.
        const canvasEl = v.renderer?.domElement ?? null;
        try {
          v.stop();
        } catch {
          /* ignore */
        }
        let p: Promise<void> | null = null;
        try {
          p = v.dispose();
        } catch {
          p = null;
        }
        const finish = () => {
          if (canvasEl && canvasEl.parentNode === host) host.removeChild(canvasEl);
        };
        if (p && typeof p.then === 'function') p.then(finish, finish);
        else finish();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sourceKey]);

  // --- trajectory overlay --------------------------------------------------
  useEffect(() => {
    if (!showTraj || cameras || trajState === 'loading') return;
    let alive = true;
    setTrajState('loading');
    api
      .cameras(projectId)
      .then((c) => {
        if (!alive) return;
        setCameras(c);
        setTrajState(c.frames.length ? 'ready' : 'missing');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setTrajState(e instanceof ApiError && e.status === 404 ? 'missing' : 'error');
      });
    return () => {
      alive = false;
    };
  }, [showTraj, cameras, trajState, projectId]);

  useEffect(() => {
    const scene: THREE.Scene | null = gsRef.current?.threeScene ?? pcRef.current?.scene ?? null;
    if (!scene) return;
    if (trajRef.current) {
      scene.remove(trajRef.current);
      disposeObject(trajRef.current);
      trajRef.current = null;
    }
    if (showTraj && cameras && cameras.frames.length > 0) {
      const g = buildTrajectory(cameras);
      scene.add(g);
      trajRef.current = g;
      gsRef.current?.forceRenderNextFrame?.();
    }
  }, [showTraj, cameras, phase]);

  // --- fullscreen ----------------------------------------------------------
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen?.().catch(() => undefined);
  }, []);

  const resetView = useCallback(() => {
    const gs = gsRef.current;
    if (gs) {
      gs.camera.up.set(...CAMERA_UP);
      gs.camera.position.set(...DEFAULT_CAMERA_POS);
      if (gs.controls) {
        gs.controls.target.set(...DEFAULT_LOOK_AT);
        gs.controls.update();
      } else {
        gs.camera.lookAt(new THREE.Vector3(...DEFAULT_LOOK_AT));
      }
      gs.forceRenderNextFrame?.();
    }
    pcRef.current?.resetView();
  }, []);

  const busy = phase === 'loading';
  return (
    <div ref={rootRef} className={cx('relative flex flex-col bg-black rounded-md border border-line overflow-hidden', fullscreen ? 'h-screen' : 'h-[520px]', className)}>
      <div className="flex items-center gap-1 px-2 py-1.5 bg-panel border-b border-line text-xs">
        <span className="chip">
          <Box className="h-3 w-3" />
          {source.mode === 'splat' ? `Gaussian splat · ${source.name}` : source.mode === 'points' ? 'Point cloud preview · sparse_points.ply' : 'No scene'}
        </span>
        {pointCount != null && <span className="text-2xs text-faint">{formatNumber(pointCount)} points</span>}
        <span className="ml-auto" />
        <button type="button" className={cx('btn-ghost btn-sm', showTraj && 'text-accent')} aria-pressed={showTraj} onClick={() => setShowTraj((v) => !v)} disabled={phase !== 'ready'} title="Draw the camera path recovered by SfM">
          <Route className="h-3.5 w-3.5" /> Camera path
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={resetView} disabled={phase !== 'ready'} title="Reset view">
          <RefreshCw className="h-3.5 w-3.5" /> Reset
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={toggleFullscreen} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="relative flex-1 min-h-0">
        <div ref={canvasHostRef} className="absolute inset-0 [&>canvas]:!w-full [&>canvas]:!h-full" aria-label="3D viewport" />
        {busy && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
            <div className="text-2xs text-white/80 mb-1">Loading {source.name}… {Math.round(progress * 100)}%</div>
            <ProgressBar value={progress} indeterminate={progress <= 0} />
          </div>
        )}
        {phase === 'empty' && (
          <div className="absolute inset-0 grid place-items-center text-center p-6">
            <div>
              <Box className="h-8 w-8 text-faint mx-auto" />
              <div className="mt-2 text-sm font-medium text-white">No splat yet — run the pipeline</div>
              <div className="mt-1 text-xs text-white/60 max-w-sm">A sparse point-cloud preview appears once camera tracking finishes; the trained splat appears after export.</div>
            </div>
          </div>
        )}
        {phase === 'error' && (
          <div className="absolute inset-0 grid place-items-center text-center p-6">
            <div>
              <div className="text-sm font-medium text-white">Could not load the scene</div>
              <div className="mt-1 text-xs text-white/60 max-w-sm break-words">{error}</div>
            </div>
          </div>
        )}
        {showTraj && trajState === 'missing' && phase === 'ready' && (
          <div className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-2xs text-white/80">No camera poses yet (they appear after the align stage).</div>
        )}
        {showTraj && trajState === 'error' && phase === 'ready' && <div className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-2xs text-danger">Could not load camera poses.</div>}
        {phase === 'ready' && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/50 px-2 py-1 text-2xs text-white/60">Drag to orbit · right-drag to pan · wheel to zoom</div>
        )}
      </div>
    </div>
  );
}

async function readWithProgress(res: Response, total: number, onProgress: (p: number) => void): Promise<ArrayBuffer> {
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      if (total > 0) onProgress(received / total);
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

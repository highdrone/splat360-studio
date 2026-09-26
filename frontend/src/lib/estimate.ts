import type { PipelineSettings, ProbeInfo } from '@/api/types';

export interface RunEstimate {
  keyframes: number;
  viewsPerFrame: number;
  views: number;
  keyframeBytes: number;
  viewBytes: number;
  totalBytes: number;
  clipSeconds: number | null;
}

/** Views per keyframe for a layout: cube6 = 6 faces, ring8 = 8 horizontal + up + down. */
export function viewsPerFrame(layout: PipelineSettings['views']['layout']): number {
  return layout === 'ring8' ? 10 : 6;
}

/**
 * Rough disk estimate: an equirect 8K JPEG keyframe at q95 is ~6-9 MB; a
 * 1600 px square pinhole JPEG is ~0.5-0.8 MB; PNG roughly 3x.
 */
export function estimateRun(settings: PipelineSettings, probe?: ProbeInfo | null): RunEstimate {
  const trimStart = settings.keyframes.start_s ?? 0;
  const duration = probe?.duration_s ?? null;
  const trimEnd = settings.keyframes.end_s ?? duration ?? null;
  let clipSeconds: number | null = null;
  if (trimEnd != null) clipSeconds = Math.max(0, trimEnd - trimStart);

  let keyframes = settings.keyframes.target_count;
  if (probe?.fps && clipSeconds != null) {
    const available = Math.floor(clipSeconds * probe.fps);
    keyframes = Math.max(0, Math.min(keyframes, available));
  }
  const vpf = viewsPerFrame(settings.views.layout);
  const views = keyframes * vpf;

  const srcW = probe?.width ?? 7680;
  const srcH = probe?.height ?? 3840;
  const pngFactor = settings.keyframes.image_format === 'png' ? 3.2 : 1;
  const q = settings.keyframes.jpeg_quality;
  const qFactor = settings.keyframes.image_format === 'png' ? 1 : 0.5 + ((q - 70) / 30) * 0.7; // 0.5 .. 1.2
  const keyframeBytes = keyframes * srcW * srcH * 0.27 * qFactor * pngFactor; // ~8 MB at 8K q95
  const viewPx = settings.views.size_px * settings.views.size_px;
  const viewBytes = views * viewPx * 0.28 * qFactor * pngFactor; // ~0.7 MB at 1600^2
  return {
    keyframes,
    viewsPerFrame: vpf,
    views,
    keyframeBytes,
    viewBytes,
    totalBytes: keyframeBytes + viewBytes,
    clipSeconds,
  };
}

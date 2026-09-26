import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '@/api/endpoints';
import { ApiError, errorMessage } from '@/api/client';
import type { ProjectReport } from '@/api/types';
import { formatDateTime, formatDuration, formatFixed, formatNumber, formatPercent, humanKey } from '@/lib/format';
import { openExternal } from '@/lib/desktop';
import { EmptyState, ErrorState, KeyValue, Note, Panel, SkeletonRows, Stat, cx } from '@/components/ui';
import type { ProjectCtx } from './context';

export function ReportTab({ ctx }: { ctx: ProjectCtx }) {
  const { project, generation } = ctx;
  const [report, setReport] = useState<ProjectReport | null>(null);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await api.report(project.id, false, ctrl.signal);
        if (!alive) return;
        setReport(r);
        setPartial(false);
        setError(null);
        setNotFound(false);
      } catch (e) {
        if (!alive || (e instanceof DOMException && e.name === 'AbortError')) return;
        if (e instanceof ApiError && e.status === 404) {
          try {
            const r = await api.report(project.id, true, ctrl.signal);
            if (!alive) return;
            setReport(r);
            setPartial(true);
            setError(null);
            setNotFound(false);
            return;
          } catch (e2) {
            if (!alive || (e2 instanceof DOMException && e2.name === 'AbortError')) return;
            if (e2 instanceof ApiError && e2.status === 404) {
              setReport(null);
              setNotFound(true);
              setError(null);
              return;
            }
            setError(errorMessage(e2));
            return;
          }
        }
        setError(errorMessage(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [project.id, generation, tick]);

  if (loading && !report) {
    return (
      <div className="panel p-4">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  if (error) return <ErrorState title="Could not load the report" message={error} onRetry={() => setTick((t) => t + 1)} />;
  if (notFound || !report) return <EmptyState title="No report yet">A partial report is available after each stage and the full report after export. Run the pipeline first.</EmptyState>;

  const r = report;
  const hasHtml = r.artifacts.some((a) => a.name === 'report.html') || project.artifacts.some((a) => a.name === 'report.html');
  const timings = Object.entries(r.timings_s);
  const totalTime = timings.reduce((a, [, v]) => a + v, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {partial && <Note kind="info">Partial report: export has not run yet, so some sections are missing.</Note>}
        <span className="text-2xs text-muted">Generated {formatDateTime(r.generated_at)}</span>
        <span className="ml-auto" />
        <button type="button" className="btn-ghost btn-sm" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
        {hasHtml && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => openExternal(api.artifactUrl(project.id, 'report.html', true))}>
            <ExternalLink className="h-3 w-3" /> Open report.html
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[280px_1fr] gap-4 items-start">
        <Panel title="Quality score">
          <QualityGauge score={r.quality_score} />
          {r.quality_notes.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-muted list-disc pl-4">
              {r.quality_notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : (
            <div className="mt-3 text-xs text-faint">No quality notes.</div>
          )}
        </Panel>
        <div className="space-y-4">
          <Panel title="Camera tracking (SfM)">
            {r.sfm ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat label="Registered views" value={`${formatNumber(r.sfm.images_registered)} / ${formatNumber(r.sfm.images_total)}`} hint={formatPercent(r.sfm.registered_fraction)} />
                  <Stat label="Registered frames" value={`${formatNumber(r.sfm.frames_registered)} / ${formatNumber(r.sfm.frames_total)}`} />
                  <Stat label="3D points" value={formatNumber(r.sfm.points3d)} />
                  <Stat label="Reprojection error" value={r.sfm.mean_reprojection_error_px != null ? `${formatFixed(r.sfm.mean_reprojection_error_px, 2)} px` : '—'} hint={r.sfm.mean_track_length != null ? `track length ${formatFixed(r.sfm.mean_track_length, 1)}` : undefined} />
                </div>
                <div className="mt-3 text-2xs text-muted">
                  {r.sfm.engine}
                  {r.sfm.colmap_version ? ` (COLMAP ${r.sfm.colmap_version})` : ''} · {r.sfm.rig_constrained ? 'rig constrained' : 'no rig constraint'} · {r.sfm.models_found} model{r.sfm.models_found === 1 ? '' : 's'}
                </div>
                {r.sfm.models_found > 1 && <div className="mt-2"><Note kind="warning">SfM split the scene into {r.sfm.models_found} models; only the largest is used. Loops probably did not close: see the capture guide.</Note></div>}
                {r.sfm.warnings.length > 0 && (
                  <ul className="mt-2 text-xs text-warn list-disc pl-4">
                    {r.sfm.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="text-xs text-faint">Not run yet.</div>
            )}
          </Panel>
          <Panel title="Alignment (scale and level)">
            {r.alignment ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat label="Method" value={r.alignment.method === 'tags' ? 'AprilTags' : r.alignment.method === 'camera_up' ? 'Camera-up heuristic' : 'None'} />
                  <Stat label="Scale factor" value={r.alignment.scale_factor != null ? formatFixed(r.alignment.scale_factor, 4) : '—'} hint={r.alignment.scale_residual_pct != null ? `residual ${formatFixed(r.alignment.scale_residual_pct, 2)} %` : undefined} />
                  <Stat label="Tags used" value={formatNumber(r.alignment.tags_used)} hint={r.alignment.ground_plane_from_tags ? 'ground plane from tags' : 'ground plane estimated'} />
                  <Stat label="Tag edge RMSE" value={r.alignment.tag_edge_rmse_mm != null ? `${formatFixed(r.alignment.tag_edge_rmse_mm, 1)} mm` : '—'} />
                </div>
                {r.alignment.method !== 'tags' && <div className="mt-2"><Note kind="warning">The scene is not metric: no usable tags. Sizes in the splat are arbitrary.</Note></div>}
                {r.alignment.notes.length > 0 && (
                  <ul className="mt-2 text-xs text-muted list-disc pl-4">
                    {r.alignment.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="text-xs text-faint">Not run yet.</div>
            )}
          </Panel>
          <Panel title="Training">
            {r.train ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <Stat label="Backend" value={r.train.backend} />
                  <Stat label="Iterations" value={formatNumber(r.train.iterations)} />
                  <Stat label="Duration" value={formatDuration(r.train.duration_s)} />
                  <Stat label="Splats" value={formatNumber(r.train.final_splats)} />
                  <Stat label="PSNR / SSIM" value={`${r.train.psnr != null ? formatFixed(r.train.psnr, 1) : '—'} / ${r.train.ssim != null ? formatFixed(r.train.ssim, 3) : '—'}`} />
                </div>
                {r.train.notes.length > 0 && (
                  <ul className="mt-2 text-xs text-muted list-disc pl-4">
                    {r.train.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="text-xs text-faint">Not run yet.</div>
            )}
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <Panel title="Stage timings">
          {timings.length === 0 ? (
            <div className="text-xs text-faint">No timings recorded.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th className="text-right">Time</th>
                  <th className="w-1/2">Share</th>
                </tr>
              </thead>
              <tbody>
                {timings.map(([k, v]) => (
                  <tr key={k}>
                    <td className="font-mono text-xs">{k}</td>
                    <td className="text-right tabular-nums">{formatDuration(v)}</td>
                    <td>
                      <div className="progress">
                        <div style={{ width: `${totalTime > 0 ? (v / totalTime) * 100 : 0}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="font-semibold">Total</td>
                  <td className="text-right tabular-nums font-semibold">{formatDuration(totalTime)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Keyframes and views">
          <KeyValue
            items={[
              ...Object.entries(r.keyframes).map(([k, v]) => ({ k: `Keyframes · ${humanKey(k)}`, v: renderValue(v) })),
              ...Object.entries(r.views).map(([k, v]) => ({ k: `Views · ${humanKey(k)}`, v: renderValue(v) })),
            ]}
          />
          {Object.keys(r.keyframes).length + Object.keys(r.views).length === 0 && <div className="text-xs text-faint">Nothing recorded yet.</div>}
        </Panel>
      </div>
    </div>
  );
}

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? formatNumber(v) : formatFixed(v, 3);
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function QualityGauge({ score }: { score: number | null }) {
  const s = score == null ? null : Math.max(0, Math.min(100, score));
  const r = 52;
  const c = Math.PI * r; // half circle
  const filled = s == null ? 0 : (s / 100) * c;
  const tone = s == null ? 'text-faint' : s >= 75 ? 'text-ok' : s >= 50 ? 'text-warn' : 'text-danger';
  const label = s == null ? 'not scored' : s >= 75 ? 'good' : s >= 50 ? 'fair' : 'poor';
  return (
    <div className="flex flex-col items-center" role="img" aria-label={`Quality score ${s == null ? 'not available' : Math.round(s)} out of 100`}>
      <svg viewBox="0 0 120 70" className="w-48">
        <path d="M8 62 A52 52 0 0 1 112 62" fill="none" stroke="rgb(var(--c-line))" strokeWidth="10" strokeLinecap="round" />
        <path d="M8 62 A52 52 0 0 1 112 62" fill="none" className={cx('stroke-current', tone)} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${filled} ${c}`} />
        <text x="60" y="58" textAnchor="middle" className={cx('fill-current', tone)} fontSize="26" fontWeight="700">
          {s == null ? '—' : Math.round(s)}
        </text>
      </svg>
      <div className={cx('text-xs font-medium -mt-1', tone)}>{label}</div>
    </div>
  );
}

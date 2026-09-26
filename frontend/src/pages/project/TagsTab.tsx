import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/api/endpoints';
import { apiUrl } from '@/api/client';
import { useAsync } from '@/hooks/useAsync';
import { formatNumber, formatPercent } from '@/lib/format';
import { EmptyState, ErrorState, Note, Panel, SkeletonRows, Stat, cx } from '@/components/ui';
import type { ProjectCtx } from './context';

export function TagsTab({ ctx }: { ctx: ProjectCtx }) {
  const { project, generation } = ctx;
  const summary = useAsync((signal) => api.tagSummary(project.id, signal), [project.id, generation]);
  const [tagFilter, setTagFilter] = useState<number | undefined>(undefined);
  const obs = useAsync((signal) => api.tagObservations(project.id, tagFilter, signal), [project.id, tagFilter, generation], { enabled: !!summary.data });
  const s = summary.data;

  if (summary.loading && !s) {
    return (
      <div className="panel p-4">
        <SkeletonRows rows={5} />
      </div>
    );
  }
  if (summary.error) return <ErrorState title="Could not load tag results" message={summary.error} onRetry={summary.reload} />;
  if (!s) {
    return (
      <EmptyState title="No tag results yet">
        {project.settings.tags.enabled ? (
          <>The tags stage has not run for this project. Run the pipeline to detect the printed AprilTags.</>
        ) : (
          <>Tag detection is disabled in the project settings. Enable it to get metric scale and a level floor.</>
        )}
      </EmptyState>
    );
  }
  const counts = Object.entries(s.per_tag_counts)
    .map(([id, n]) => ({ id: Number(id), n }))
    .sort((a, b) => b.n - a.n);
  const maxN = counts[0]?.n ?? 1;
  const weak = new Set(s.weak_tags);
  const lowCoverage = s.coverage_fraction < 0.3;
  const sample = (obs.data ?? []).slice(0, 24);

  return (
    <div className="space-y-4">
      <Panel title="Summary">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Family / size" value={`${s.family}`} hint={`${s.size_mm} mm`} />
          <Stat label="Unique tags" value={formatNumber(s.unique_tags)} hint={s.weak_tags.length ? `${s.weak_tags.length} weak` : 'all well observed'} />
          <Stat label="Observations" value={formatNumber(s.total_observations)} />
          <Stat label="Views with tags" value={`${formatNumber(s.views_with_tags)} / ${formatNumber(s.views_total)}`} />
          <Stat label="Coverage" value={formatPercent(s.coverage_fraction)} hint="share of views seeing ≥ 1 tag" />
        </div>
        {s.unique_tags < 3 && (
          <div className="mt-3">
            <Note kind="error">
              Fewer than 3 unique tags were detected. Scale and levelling from tags need at least 3 well-observed tags; alignment will fall back to the camera-up heuristic. Check the printed size, family and placement (<Link to="/guide#tags" className="underline">guide</Link>).
            </Note>
          </div>
        )}
        {s.unique_tags >= 3 && lowCoverage && (
          <div className="mt-3">
            <Note kind="warning">Only {formatPercent(s.coverage_fraction)} of views see a tag. Scale will still be recovered, but spreading more tags along the route improves the level and scale estimate.</Note>
          </div>
        )}
        {s.weak_tags.length > 0 && (
          <div className="mt-3">
            <Note kind="warning">
              Weak tags (seen in fewer than 3 views): <span className="font-mono">{s.weak_tags.join(', ')}</span>. They are ignored for alignment. Move them closer to the path or make them larger next time.
            </Note>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4 items-start">
        <Panel title="Observations per tag">
          {counts.length === 0 ? (
            <div className="text-xs text-muted">No tags detected.</div>
          ) : (
            <ul className="space-y-1.5">
              <li>
                <button type="button" className={cx('text-2xs underline', tagFilter == null ? 'text-accent' : 'text-muted')} onClick={() => setTagFilter(undefined)}>
                  all tags
                </button>
              </li>
              {counts.map(({ id, n }) => (
                <li key={id}>
                  <button type="button" className="w-full text-left group" onClick={() => setTagFilter(id === tagFilter ? undefined : id)} aria-pressed={tagFilter === id}>
                    <div className="flex justify-between text-2xs mb-0.5">
                      <span className={cx('font-mono', tagFilter === id ? 'text-accent' : 'text-ink')}>
                        id {id}
                        {weak.has(id) && <span className="ml-1 text-warn">weak</span>}
                      </span>
                      <span className="text-muted tabular-nums">{n}</span>
                    </div>
                    <div className="progress">
                      <div className={cx(weak.has(id) && '!bg-warn')} style={{ width: `${(n / maxN) * 100}%` }} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={tagFilter == null ? 'Sample observations' : `Observations of tag ${tagFilter}`} actions={obs.data ? <span className="text-2xs text-muted">{obs.data.length} total</span> : null}>
          {obs.loading && !obs.data && <SkeletonRows rows={4} />}
          {obs.error && <ErrorState message={obs.error} onRetry={obs.reload} />}
          {obs.data && sample.length === 0 && <div className="text-xs text-muted">No observations.</div>}
          {sample.length > 0 && (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
              {sample.map((o, i) => (
                <li key={`${o.view}-${o.tag_id}-${i}`} className="rounded border border-line overflow-hidden bg-panel2">
                  <div className="relative aspect-square">
                    <img src={apiUrl(`/api/projects/${encodeURIComponent(project.id)}/views/${o.view}`)} alt={`View ${o.view}`} className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                    <TagOutline corners={o.corners} />
                  </div>
                  <div className="p-1.5 text-2xs font-mono text-muted leading-4">
                    <div className="text-ink">tag {o.tag_id}</div>
                    <div className="truncate" title={o.view}>
                      frame {o.frame_index} · {o.face}
                    </div>
                    <div>
                      margin {o.decision_margin.toFixed(0)} · ham {o.hamming}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** Draw the tag quad on top of the view thumbnail in normalised coordinates. */
function TagOutline({ corners }: { corners: number[][] }) {
  if (!corners || corners.length !== 4) return null;
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const max = Math.max(...xs, ...ys);
  // Corners are in view pixels; the view is square so normalise by the largest coordinate's power-of-two bound.
  const size = max <= 1 ? 1 : max <= 512 ? 512 : max <= 1024 ? 1024 : max <= 1600 ? 1600 : max <= 2048 ? 2048 : 3072;
  const pts = corners.map(([x, y]) => `${(x / size) * 100},${(y / size) * 100}`).join(' ');
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <polygon points={pts} fill="rgb(var(--c-accent) / 0.2)" stroke="rgb(var(--c-accent))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

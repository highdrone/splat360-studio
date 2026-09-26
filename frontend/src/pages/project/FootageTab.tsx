import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FileVideo } from 'lucide-react';
import { api } from '@/api/endpoints';
import { apiUrl, errorMessage } from '@/api/client';
import type { KeyframeItem, ViewItem } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { bridge, isDesktop } from '@/lib/desktop';
import { formatTimecode } from '@/lib/format';
import { toast } from '@/store/uiStore';
import { ProbeInfoCard } from '@/components/ProbeInfoCard';
import { EmptyState, ErrorState, Field, Panel, Skeleton, Spinner, cx } from '@/components/ui';
import type { ProjectCtx } from './context';

function LazyImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return <img ref={ref} src={visible ? src : undefined} alt={alt} className={cx('bg-panel2', className)} loading="lazy" decoding="async" />;
}

export function FootageTab({ ctx }: { ctx: ProjectCtx }) {
  const { project, generation, reload, jobActive } = ctx;
  const [busy, setBusy] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const keyframes = useAsync((signal) => api.keyframes(project.id, signal), [project.id, generation]);
  const [offset, setOffset] = useState(0);
  const [face, setFace] = useState<string>('all');
  const LIMIT = 120;
  const views = useAsync((signal) => api.views(project.id, offset, LIMIT, signal), [project.id, offset, generation]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLightbox(null);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const setSourcePath = async (path: string) => {
    setBusy(true);
    try {
      await api.setSource(project.id, { path });
      toast.success('Footage updated');
      reload();
    } catch (e) {
      toast.error('Could not set the footage', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    const b = bridge();
    if (!b) return;
    const p = await b.pickVideo();
    if (p) await setSourcePath(p);
  };

  const byFace = new Map<string, ViewItem[]>();
  for (const v of views.data?.items ?? []) {
    if (face !== 'all' && v.face !== face) continue;
    const arr = byFace.get(v.face) ?? [];
    arr.push(v);
    byFace.set(v.face, arr);
  }
  const total = views.data?.count ?? 0;

  return (
    <div className="space-y-4">
      <Panel
        title="Source video"
        actions={
          !jobActive &&
          (isDesktop() ? (
            <button type="button" className="btn-secondary btn-sm" onClick={pick} disabled={busy}>
              {busy ? <Spinner className="h-3 w-3 animate-spin" /> : <FileVideo className="h-3 w-3" />} {project.source ? 'Replace video…' : 'Choose video…'}
            </button>
          ) : null)
        }
      >
        {project.source ? (
          <ProbeInfoCard probe={project.source} />
        ) : (
          <EmptyState icon={<FileVideo className="h-8 w-8" />} title="No footage yet">
            Add an equirectangular MP4 exported from Insta360 Studio. See the <Link to="/guide#export" className="text-accent underline">export guide</Link>.
          </EmptyState>
        )}
        {!isDesktop() && !jobActive && (
          <div className="mt-3 max-w-xl">
            <Field label={project.source ? 'Replace with a path on this machine' : 'Path on this machine'} help="The engine reads the file in place.">
              <div className="flex gap-2">
                <input className="input font-mono" value={manualPath} placeholder="/path/to/export_8k.mp4" onChange={(e) => setManualPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && manualPath.trim() && setSourcePath(manualPath.trim())} />
                <button type="button" className="btn-secondary" disabled={!manualPath.trim() || busy} onClick={() => setSourcePath(manualPath.trim())}>
                  Use path
                </button>
              </div>
            </Field>
          </div>
        )}
      </Panel>

      <Panel title="Keyframes" actions={keyframes.data ? <span className="text-2xs text-muted">{keyframes.data.count} selected</span> : null}>
        {keyframes.loading && !keyframes.data && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[2/1]" />
            ))}
          </div>
        )}
        {keyframes.error && <ErrorState message={keyframes.error} onRetry={keyframes.reload} />}
        {(keyframes.notFound || (keyframes.data && keyframes.data.count === 0)) && !keyframes.loading && (
          <EmptyState title="No keyframes yet">Keyframes are selected by the second stage. Run the pipeline to see them here.</EmptyState>
        )}
        {keyframes.data && keyframes.data.count > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
            {keyframes.data.items.map((k: KeyframeItem) => (
              <li key={k.index} className="min-w-0">
                <button type="button" className="block w-full rounded overflow-hidden border border-line hover:border-accent" onClick={() => setLightbox(apiUrl(k.url))}>
                  <LazyImage src={apiUrl(k.url)} alt={`Keyframe ${k.index} at ${formatTimecode(k.time_s)}`} className="aspect-[2/1] w-full object-cover" />
                </button>
                <div className="mt-0.5 flex justify-between text-2xs text-muted font-mono">
                  <span>#{k.index}</span>
                  <span>{formatTimecode(k.time_s)}</span>
                  <span title="Sharpness">σ {k.sharpness.toFixed(0)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Pinhole views"
        actions={
          views.data && views.data.count > 0 ? (
            <div className="flex items-center gap-2 text-2xs text-muted">
              <select className="select py-0.5 text-2xs" value={face} onChange={(e) => setFace(e.target.value)} aria-label="Filter by face">
                <option value="all">All faces</option>
                {views.data.faces.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <span>
                {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
              </span>
              <button type="button" className="btn-ghost btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))} aria-label="Previous page">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="btn-ghost btn-sm" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)} aria-label="Next page">
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null
        }
      >
        {views.loading && !views.data && <Skeleton className="h-32" />}
        {views.error && <ErrorState message={views.error} onRetry={views.reload} />}
        {(views.notFound || (views.data && views.data.count === 0)) && !views.loading && <EmptyState title="No pinhole views yet">Views are rendered by the reprojection stage.</EmptyState>}
        {views.data && views.data.count > 0 && (
          <div className="space-y-4">
            {[...byFace.entries()].map(([f, items]) => (
              <section key={f}>
                <h4 className="text-xs font-semibold text-muted mb-1.5">
                  Face <span className="font-mono text-ink">{f}</span> <span className="text-faint font-normal">· {items.length} on this page</span>
                </h4>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-1.5">
                  {items.map((v) => (
                    <li key={v.name}>
                      <button type="button" className="block w-full rounded overflow-hidden border border-line hover:border-accent" onClick={() => setLightbox(apiUrl(v.url))} title={v.name}>
                        <LazyImage src={apiUrl(v.url)} alt={`View ${v.name}`} className="aspect-square w-full object-cover" />
                      </button>
                      <div className="text-2xs text-faint font-mono truncate">#{v.frame_index}</div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {byFace.size === 0 && <div className="text-xs text-muted">No views for this face on this page.</div>}
          </div>
        )}
      </Panel>

      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/85 p-6 grid place-items-center" onClick={() => setLightbox(null)} role="dialog" aria-label="Image preview">
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded shadow-2xl" />
        </div>
      )}
    </div>
  );
}

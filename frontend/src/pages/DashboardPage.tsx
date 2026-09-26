import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FlaskConical, FolderOpen, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/api/endpoints';
import { apiUrl, errorMessage } from '@/api/client';
import type { Project } from '@/api/types';
import { STAGE_LABELS } from '@/api/types';
import { useProjectsStore } from '@/store/projectsStore';
import { confirmDialog, toast } from '@/store/uiStore';
import { useNow } from '@/hooks/useNow';
import { formatRelative } from '@/lib/format';
import { EmptyState, ErrorState, PageHeader, ProgressBar, Skeleton, StatusPill, Spinner, cx } from '@/components/ui';

export function DashboardPage() {
  const { projects, loading, loaded, error, fetch, remove, upsert, liveJobs } = useProjectsStore();
  const navigate = useNavigate();
  const now = useNow(10_000);
  const [demoBusy, setDemoBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  const runDemo = async () => {
    setDemoBusy(true);
    try {
      const p = await api.syntheticDemo({});
      upsert(p);
      toast.success('Demo project created', 'A synthetic tagged room was rendered. Run the pipeline to validate your install.');
      navigate(`/projects/${p.id}`);
    } catch (e) {
      toast.error('Could not create the demo', errorMessage(e));
    } finally {
      setDemoBusy(false);
    }
  };

  const run = async (p: Project) => {
    setBusyId(p.id);
    try {
      await api.runProject(p.id, {});
      toast.success('Run started', p.name);
      upsert({ ...p, status: 'running' });
    } catch (e) {
      toast.error('Could not start the run', errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const del = async (p: Project) => {
    const ok = await confirmDialog({
      title: `Delete “${p.name}”?`,
      message: `This removes the project and its whole work directory:\n${p.workdir}\n\nKeyframes, views, the splat and the report are deleted. This cannot be undone.`,
      confirmLabel: 'Delete project',
      danger: true,
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      await api.deleteProject(p.id);
      remove(p.id);
      toast.success('Project deleted', p.name);
    } catch (e) {
      toast.error('Could not delete the project', errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle={loaded && !error ? `${projects.length} project${projects.length === 1 ? '' : 's'}` : undefined}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => void fetch()} disabled={loading} aria-label="Refresh projects">
              <RefreshCw className={cx('h-4 w-4', loading && 'animate-spin')} />
            </button>
            <button type="button" className="btn-secondary" onClick={runDemo} disabled={demoBusy} title="Renders a synthetic tagged room (about a minute) so you can validate the install without a camera">
              {demoBusy ? <Spinner /> : <FlaskConical className="h-4 w-4" />} {demoBusy ? 'Rendering demo clip…' : 'Try a synthetic demo'}
            </button>
            <Link to="/projects/new" className="btn-primary">
              <Plus className="h-4 w-4" /> New project
            </Link>
          </>
        }
      />
      {demoBusy && (
        <div className="panel p-3 mb-4 flex items-center gap-3 text-xs text-muted">
          <Spinner /> Rendering a synthetic equirectangular clip of a tagged room. This takes about a minute; the project opens when it is ready.
        </div>
      )}
      {error && !loading && <ErrorState title="Could not load projects" message={error} onRetry={() => void fetch()} />}
      {!loaded && loading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" role="status" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      )}
      {loaded && !error && projects.length === 0 && (
        <EmptyState
          icon={<FolderOpen className="h-8 w-8" />}
          title="No projects yet"
          action={
            <div className="flex gap-2">
              <Link to="/projects/new" className="btn-primary">
                <Plus className="h-4 w-4" /> New project
              </Link>
              <button type="button" className="btn-secondary" onClick={runDemo} disabled={demoBusy}>
                <FlaskConical className="h-4 w-4" /> Synthetic demo
              </button>
            </div>
          }
        >
          Start from an equirectangular MP4 exported from Insta360 Studio. No footage yet? Read the <Link to="/guide" className="text-accent underline">capture guide</Link>, print{' '}
          <Link to="/tags" className="text-accent underline">AprilTags</Link>, or render a synthetic demo to check that ffmpeg, COLMAP and the trainer are working (<Link to="/doctor" className="text-accent underline">Environment</Link>).
        </EmptyState>
      )}
      {projects.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {projects.map((p) => {
            const job = liveJobs[p.id];
            const running = p.status === 'running';
            const stage = (job?.stages ?? p.stages).find((s) => s.status === 'running');
            const done = (job?.stages ?? p.stages).filter((s) => s.status === 'complete').length;
            const total = (job?.stages ?? p.stages).length || 8;
            const busy = busyId === p.id;
            return (
              <li key={p.id} className="panel flex flex-col overflow-hidden">
                <Link to={`/projects/${p.id}`} className="block relative aspect-[2/1] bg-panel2 overflow-hidden focus-visible:outline-none">
                  {p.thumbnail_url ? (
                    <img src={apiUrl(p.thumbnail_url)} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="grid h-full place-items-center text-faint text-xs">{p.source ? 'No thumbnail yet' : 'No footage yet'}</div>
                  )}
                  <StatusPill status={p.status} className="absolute left-2 top-2 backdrop-blur" />
                </Link>
                <div className="p-3 flex-1 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/projects/${p.id}`} className="text-sm font-medium truncate hover:text-accent" title={p.name}>
                      {p.name}
                    </Link>
                    <span className="text-2xs text-faint whitespace-nowrap" title={p.updated_at}>
                      {formatRelative(p.updated_at, now)}
                    </span>
                  </div>
                  <div className="text-2xs text-muted truncate">{p.source ? p.source.filename : 'No source video'}</div>
                  {running ? (
                    <div>
                      <div className="flex justify-between text-2xs text-muted mb-1">
                        <span className="truncate">{stage ? (stage.label || STAGE_LABELS[stage.name]) : 'Queued'}</span>
                        <span>
                          {done}/{total}
                        </span>
                      </div>
                      <ProgressBar value={stage ? stage.progress : 0} indeterminate={!stage || stage.progress <= 0} />
                    </div>
                  ) : (
                    <div className="text-2xs text-faint">
                      {done > 0 ? `${done}/${total} stages complete` : p.status === 'draft' ? 'Draft: add footage and run' : 'Ready to run'}
                    </div>
                  )}
                  <div className="mt-auto flex items-center gap-1 pt-1">
                    <Link to={`/projects/${p.id}`} className="btn-secondary btn-sm">
                      <FolderOpen className="h-3.5 w-3.5" /> Open
                    </Link>
                    <button type="button" className="btn-secondary btn-sm" disabled={running || busy || !p.source} onClick={() => run(p)} title={!p.source ? 'Add footage first' : running ? 'Already running' : 'Run the whole pipeline'}>
                      {busy ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run
                    </button>
                    <button type="button" className="btn-ghost btn-sm ml-auto text-danger" disabled={busy || running} onClick={() => del(p)} aria-label={`Delete ${p.name}`} title={running ? 'Cancel the run first' : 'Delete project'}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FolderOpen, Play, Square, Trash2 } from 'lucide-react';
import { api } from '@/api/endpoints';
import { errorMessage } from '@/api/client';
import { isJobActive, type StageName } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { useJobStream } from '@/hooks/useJobStream';
import { useProjectsStore } from '@/store/projectsStore';
import { confirmDialog, toast } from '@/store/uiStore';
import { isDesktop, revealPath } from '@/lib/desktop';
import { EmptyState, ErrorState, PageHeader, PathChip, SkeletonRows, Spinner, StatusPill, cx } from '@/components/ui';
import { PipelineTab } from './project/PipelineTab';
import { FootageTab } from './project/FootageTab';
import { TagsTab } from './project/TagsTab';
import { ViewerTab } from './project/ViewerTab';
import { ReportTab } from './project/ReportTab';
import { SettingsTab } from './project/SettingsTab';
import type { ProjectCtx } from './project/context';

const TABS = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'footage', label: 'Footage' },
  { id: 'tags', label: 'Tags' },
  { id: 'viewer', label: 'Viewer' },
  { id: 'report', label: 'Report' },
  { id: 'settings', label: 'Settings' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function ProjectPage() {
  const { id = '', tab: tabParam } = useParams();
  const navigate = useNavigate();
  const tab: TabId = (TABS.find((t) => t.id === tabParam)?.id ?? 'pipeline') as TabId;
  const proj = useAsync((signal) => api.getProject(id, signal), [id]);
  const project = proj.data;
  const upsert = useProjectsStore((s) => s.upsert);
  const removeFromStore = useProjectsStore((s) => s.remove);
  const liveJob = useProjectsStore((s) => (project ? s.liveJobs[project.id] : undefined));
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);

  const jobId = project?.current_job_id ?? project?.last_job_id ?? null;
  const stream = useJobStream(jobId);
  const job = stream.job;
  const jobActive = isJobActive(job) || (!job && !!project?.current_job_id);

  // Keep the projects store in sync so the dashboard reflects what we loaded.
  useEffect(() => {
    if (project) upsert(project);
  }, [project, upsert]);

  // When the streamed job reaches a terminal state, bump the generation and refresh the project (artifacts, status).
  const wasActive = useRef(false);
  useEffect(() => {
    const active = isJobActive(job);
    if (wasActive.current && !active && job) {
      setGeneration((g) => g + 1);
      proj.reload();
      if (job.status === 'complete') toast.success('Pipeline complete', project?.name);
      else if (job.status === 'failed') toast.error('Pipeline failed', job.error ?? 'See the log for details.');
    }
    wasActive.current = active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.id]);

  // A job started elsewhere (dashboard, CLI): the global stream tells us before the project refreshes.
  useEffect(() => {
    if (!project || !liveJob) return;
    if (isJobActive(liveJob) && liveJob.id !== project.current_job_id) proj.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveJob?.id, liveJob?.status]);

  const onRun = useCallback(
    async (fromStage?: StageName | null, force?: boolean) => {
      if (!project) return;
      setBusy(true);
      try {
        await api.runProject(project.id, { from_stage: fromStage ?? null, force: !!force });
        toast.success(fromStage ? `Re-running from ${fromStage}` : 'Run started', project.name);
        proj.reload();
      } catch (e) {
        toast.error('Could not start the run', errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [project, proj],
  );

  const onCancel = useCallback(async () => {
    const jid = project?.current_job_id ?? job?.id;
    if (!jid) return;
    const ok = await confirmDialog({ title: 'Cancel the running job?', message: 'The current stage stops and its child processes are killed. Completed stages are kept and can be resumed with “Re-run from stage…”.', confirmLabel: 'Cancel job', cancelLabel: 'Keep running', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await api.cancelJob(jid);
      toast.info('Cancelling…', 'The job stops at the next checkpoint.');
    } catch (e) {
      toast.error('Could not cancel', errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [project, job]);

  const onDelete = async () => {
    if (!project) return;
    const ok = await confirmDialog({ title: `Delete “${project.name}”?`, message: `This removes the project and its whole work directory:\n${project.workdir}\n\nThis cannot be undone.`, confirmLabel: 'Delete project', danger: true });
    if (!ok) return;
    try {
      await api.deleteProject(project.id);
      removeFromStore(project.id);
      toast.success('Project deleted', project.name);
      navigate('/');
    } catch (e) {
      toast.error('Could not delete the project', errorMessage(e));
    }
  };

  if (proj.loading && !project) {
    return (
      <div className="panel p-4">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  if (proj.notFound) {
    return (
      <EmptyState title="Project not found" action={<Link to="/" className="btn-primary">Back to projects</Link>}>
        It may have been deleted, or the engine's data directory changed.
      </EmptyState>
    );
  }
  if (proj.error || !project) return <ErrorState title="Could not load the project" message={proj.error} onRetry={proj.reload} />;

  const status = jobActive ? 'running' : project.status;
  const ctx: ProjectCtx = { project, job, stream, jobActive, reload: proj.reload, generation, onRun, onCancel, busy };

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {project.name} <StatusPill status={status} />
          </span>
        }
        back={
          <Link to="/" className="text-muted hover:text-ink inline-flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> Projects
          </Link>
        }
        subtitle={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <PathChip path={project.workdir} />
            {isDesktop() && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => revealPath(project.workdir)}>
                <FolderOpen className="h-3 w-3" /> Reveal
              </button>
            )}
          </span>
        }
        actions={
          <>
            {jobActive ? (
              <button type="button" className="btn-danger" onClick={onCancel} disabled={busy}>
                {busy ? <Spinner /> : <Square className="h-4 w-4" />} Cancel
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={() => onRun(null, false)} disabled={busy || !project.source} title={!project.source ? 'Add footage first' : 'Run the pipeline'}>
                {busy ? <Spinner /> : <Play className="h-4 w-4" />} Run
              </button>
            )}
            <button type="button" className="btn-ghost text-danger" onClick={onDelete} disabled={jobActive} title={jobActive ? 'Cancel the job first' : 'Delete project'}>
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        }
      />
      <nav className="mb-4 flex border-b border-line overflow-x-auto" role="tablist" aria-label="Project sections">
        {TABS.map((t) => (
          <NavLink key={t.id} to={`/projects/${encodeURIComponent(project.id)}/${t.id}`} role="tab" aria-selected={tab === t.id} className={cx('tab', tab === t.id && 'tab-active')} replace>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div role="tabpanel">
        {tab === 'pipeline' && <PipelineTab ctx={ctx} />}
        {tab === 'footage' && <FootageTab ctx={ctx} />}
        {tab === 'tags' && <TagsTab ctx={ctx} />}
        {tab === 'viewer' && <ViewerTab ctx={ctx} />}
        {tab === 'report' && <ReportTab ctx={ctx} />}
        {tab === 'settings' && <SettingsTab ctx={ctx} />}
      </div>
    </div>
  );
}

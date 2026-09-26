import { useState } from 'react';
import { ChevronDown, Play, Square } from 'lucide-react';
import { STAGE_LABELS, STAGE_ORDER, type StageName } from '@/api/types';
import { api } from '@/api/endpoints';
import { elapsedSeconds, formatDateTime, formatDuration } from '@/lib/format';
import { useNow } from '@/hooks/useNow';
import { FailureCard, StageList } from '@/components/project/StageList';
import { LogPanel } from '@/components/project/LogPanel';
import { EmptyState, Note, Panel, Spinner, StatusPill, cx } from '@/components/ui';
import type { ProjectCtx } from './context';

export function PipelineTab({ ctx }: { ctx: ProjectCtx }) {
  const { project, job, stream, jobActive, onRun, onCancel, busy } = ctx;
  const now = useNow(1000);
  const [menuOpen, setMenuOpen] = useState(false);
  const stages = job?.stages?.length ? job.stages : project.stages;
  const elapsed = job ? elapsedSeconds(job.started_at ?? job.created_at, job.finished_at, now) : null;
  const canRun = !!project.source && !jobActive && !busy;

  const rerunFrom = async (s: StageName) => {
    setMenuOpen(false);
    await onRun(s, true);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(360px,440px)_1fr] gap-4 items-start">
      <div className="space-y-3">
        <Panel
          title="Stages"
          actions={
            <div className="flex items-center gap-1 relative">
              {jobActive ? (
                <button type="button" className="btn-danger btn-sm" onClick={onCancel} disabled={busy}>
                  {busy ? <Spinner className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />} Cancel
                </button>
              ) : (
                <>
                  <button type="button" className="btn-primary btn-sm" onClick={() => onRun(null, false)} disabled={!canRun} title={!project.source ? 'Add footage first (Footage tab)' : 'Run all stages (cached outputs are reused)'}>
                    {busy ? <Spinner className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setMenuOpen((o) => !o)} disabled={!canRun} aria-haspopup="menu" aria-expanded={menuOpen}>
                    Re-run from stage… <ChevronDown className="h-3 w-3" />
                  </button>
                  {menuOpen && (
                    <ul role="menu" className="absolute right-0 top-full z-20 mt-1 w-64 panel p-1 shadow-lg" onKeyDown={(e) => e.key === 'Escape' && setMenuOpen(false)}>
                      {STAGE_ORDER.map((s) => (
                        <li key={s} role="none">
                          <button type="button" role="menuitem" className="w-full text-left rounded px-2 py-1.5 text-xs hover:bg-panel2 flex items-center gap-2" onClick={() => rerunFrom(s)}>
                            <span className="font-mono text-faint w-16">{s}</span>
                            <span>{STAGE_LABELS[s]}</span>
                          </button>
                        </li>
                      ))}
                      <li className="px-2 py-1 text-2xs text-faint border-t border-line mt-1">Forces the chosen stage and everything after it to run again.</li>
                    </ul>
                  )}
                </>
              )}
            </div>
          }
        >
          {!project.source && (
            <div className="mb-3">
              <Note kind="warning">This project has no footage. Add a source video on the Footage tab before running.</Note>
            </div>
          )}
          {stages.length === 0 ? (
            <EmptyState title="Not run yet">Press Run to start the pipeline. Stages appear here with live progress.</EmptyState>
          ) : (
            <StageList stages={stages} />
          )}
        </Panel>
        {job && (
          <Panel title="Job">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted">Status</dt>
              <dd>
                <StatusPill status={job.status} />
                {!stream.connected && jobActive && <span className="ml-2 text-2xs text-warn">reconnecting{stream.attempts > 0 ? ` (attempt ${stream.attempts})` : ''}…</span>}
              </dd>
              <dt className="text-muted">Job id</dt>
              <dd className="font-mono">{job.id}</dd>
              <dt className="text-muted">From stage</dt>
              <dd className="font-mono">{job.from_stage}</dd>
              <dt className="text-muted">Created</dt>
              <dd>{formatDateTime(job.created_at)}</dd>
              <dt className="text-muted">Elapsed</dt>
              <dd className="tabular-nums">{formatDuration(elapsed)}</dd>
              {job.finished_at && (
                <>
                  <dt className="text-muted">Finished</dt>
                  <dd>{formatDateTime(job.finished_at)}</dd>
                </>
              )}
            </dl>
          </Panel>
        )}
      </div>
      <div className="space-y-3 min-w-0">
        {job && <FailureCard job={job} />}
        {job?.status === 'complete' && (
          <Note kind="success">
            Run complete. Open the <strong>Viewer</strong> tab to explore the splat and download artifacts, or the <strong>Report</strong> tab for quality metrics.
          </Note>
        )}
        {job ? (
          <LogPanel lines={stream.logLines} seq={stream.logSeq} downloadUrl={api.jobLogUrl(job.id)} height={jobActive ? 520 : 440} />
        ) : (
          <div className={cx('panel p-6 text-center text-xs text-muted')}>Logs appear here while a job runs.</div>
        )}
      </div>
    </div>
  );
}

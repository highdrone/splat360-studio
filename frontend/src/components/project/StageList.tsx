import { AlertCircle, Check, Circle, Loader2, MinusCircle, XCircle } from 'lucide-react';
import type { Job, StageState } from '@/api/types';
import { STAGE_LABELS } from '@/api/types';
import { elapsedSeconds, formatDuration, formatMetric, humanKey } from '@/lib/format';
import { useNow } from '@/hooks/useNow';
import { ProgressBar, cx } from '@/components/ui';

function StageIcon({ status }: { status: StageState['status'] }) {
  switch (status) {
    case 'complete':
      return <Check className="h-3.5 w-3.5" />;
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5" />;
    case 'cancelled':
      return <MinusCircle className="h-3.5 w-3.5" />;
    case 'skipped':
      return <MinusCircle className="h-3.5 w-3.5" />;
    default:
      return <Circle className="h-3 w-3" />;
  }
}

const RING: Record<StageState['status'], string> = {
  pending: 'border-line text-faint bg-panel',
  running: 'border-accent text-accent bg-accent/10',
  complete: 'border-ok text-ok bg-ok/10',
  failed: 'border-danger text-danger bg-danger/10',
  skipped: 'border-line text-faint bg-panel2',
  cancelled: 'border-warn text-warn bg-warn/10',
};

export function StageList({ stages, className = '' }: { stages: StageState[]; className?: string }) {
  const now = useNow(1000);
  if (stages.length === 0) return null;
  return (
    <ol className={cx('relative', className)} aria-label="Pipeline stages">
      {stages.map((s, i) => {
        const last = i === stages.length - 1;
        const elapsed = elapsedSeconds(s.started_at, s.finished_at, now);
        const metrics = Object.entries(s.metrics ?? {});
        return (
          <li key={s.name} className="relative flex gap-3 pb-4">
            {!last && <span className={cx('absolute left-[11px] top-6 bottom-0 w-px', s.status === 'complete' ? 'bg-ok/50' : 'bg-line')} aria-hidden />}
            <span className={cx('relative z-10 mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border', RING[s.status])} aria-label={s.status}>
              <StageIcon status={s.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-sm font-medium truncate">
                  {s.label || STAGE_LABELS[s.name] || s.name}
                  <span className="ml-2 font-mono text-2xs text-faint">{s.name}</span>
                </div>
                <div className="text-2xs text-muted whitespace-nowrap tabular-nums">
                  {s.status === 'running' && s.eta_s != null && s.eta_s > 0 && <span className="mr-2">ETA {formatDuration(s.eta_s, { compact: true })}</span>}
                  {elapsed != null && (s.status === 'running' || s.status === 'complete' || s.status === 'failed' || s.status === 'cancelled') && <span>{formatDuration(elapsed)}</span>}
                </div>
              </div>
              {(s.status === 'running' || (s.status === 'complete' && s.progress > 0 && s.progress < 1)) && (
                <div className="mt-1.5 flex items-center gap-2">
                  <ProgressBar value={s.progress} indeterminate={s.status === 'running' && s.progress <= 0} className="flex-1" />
                  <span className="text-2xs text-muted tabular-nums w-9 text-right">{Math.round(s.progress * 100)}%</span>
                </div>
              )}
              {s.message && s.status !== 'pending' && <div className="mt-1 text-xs text-muted break-words">{s.message}</div>}
              {s.error && s.status === 'failed' && <div className="mt-1 text-xs text-danger break-words">{s.error}</div>}
              {metrics.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {metrics.map(([k, v]) => (
                    <span key={k} className="chip" title={k}>
                      <span className="text-faint">{humanKey(k)}</span>
                      <span className="text-ink font-mono">{formatMetric(v)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function FailureCard({ job }: { job: Job }) {
  if (job.status !== 'failed' && job.status !== 'cancelled') return null;
  const failed = job.stages.find((s) => s.status === 'failed');
  const cancelled = job.status === 'cancelled';
  return (
    <div className={cx('rounded-md border p-3 text-sm flex gap-3', cancelled ? 'border-warn/50 bg-warn/10' : 'border-danger/50 bg-danger/10')} role="alert">
      <AlertCircle className={cx('h-4 w-4 mt-0.5 shrink-0', cancelled ? 'text-warn' : 'text-danger')} />
      <div className="min-w-0 space-y-1">
        <div className="font-medium">{cancelled ? 'Run cancelled' : `Failed in “${failed?.label ?? failed?.name ?? 'pipeline'}”`}</div>
        {(failed?.error || job.error) && <pre className="text-xs text-muted whitespace-pre-wrap break-words font-mono">{failed?.error ?? job.error}</pre>}
        {!cancelled && (
          <div className="text-xs text-muted">
            Check the log below, fix the cause (footage, tags, missing tools on the Environment page) and use <em>Re-run from stage</em> to resume from{' '}
            <code className="code">{failed?.name ?? job.from_stage}</code>.
          </div>
        )}
      </div>
    </div>
  );
}

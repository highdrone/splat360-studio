import { CheckCircle2, RefreshCw, XCircle, AlertTriangle } from 'lucide-react';
import { api } from '@/api/endpoints';
import { useAsync } from '@/hooks/useAsync';
import { CopyButton, ErrorState, KeyValue, Note, PageHeader, Panel, PathChip, SkeletonRows, cx } from '@/components/ui';
import { formatNumber } from '@/lib/format';

export function DoctorPage() {
  const doc = useAsync((signal) => api.doctor(signal), []);
  const r = doc.data;
  const banner = r
    ? r.ready
      ? { kind: 'success' as const, title: 'Ready', text: 'Every required tool was found. You can reconstruct and train.' }
      : r.can_reconstruct && !r.can_train
        ? { kind: 'warning' as const, title: 'Can reconstruct, cannot train', text: 'ffmpeg and COLMAP work, but no Gaussian splat trainer (brush or OpenSplat) was found. Runs will stop after alignment; install a trainer to produce splats.' }
        : { kind: 'error' as const, title: 'Missing required tools', text: 'Install the missing tools below, then re-check. The pipeline refuses to start without them.' }
    : null;

  return (
    <div>
      <PageHeader
        title="Environment"
        subtitle="External tools the engine needs, detected on this machine."
        actions={
          <button type="button" className="btn-secondary" onClick={doc.reload} disabled={doc.loading}>
            <RefreshCw className={cx('h-4 w-4', doc.loading && 'animate-spin')} /> Re-check
          </button>
        }
      />
      {doc.error && <ErrorState title="Could not run the environment check" message={doc.error} onRetry={doc.reload} />}
      {doc.loading && !r && (
        <div className="panel p-4">
          <SkeletonRows rows={6} />
        </div>
      )}
      {r && banner && (
        <div className="space-y-4">
          <Note kind={banner.kind}>
            <div className="flex items-start gap-2">
              {banner.kind === 'success' ? <CheckCircle2 className="h-4 w-4 text-ok mt-0.5" /> : banner.kind === 'warning' ? <AlertTriangle className="h-4 w-4 text-warn mt-0.5" /> : <XCircle className="h-4 w-4 text-danger mt-0.5" />}
              <div>
                <div className="text-sm font-semibold">{banner.title}</div>
                <div>{banner.text}</div>
                {r.trainer && <div className="mt-1 text-muted">Trainer selected: <code className="code">{r.trainer}</code></div>}
                {r.messages.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-muted">
                    {r.messages.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Note>

          <Panel title="Tools" bodyClassName="p-0 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Role</th>
                  <th>Path / install hint</th>
                </tr>
              </thead>
              <tbody>
                {r.tools.map((t) => (
                  <tr key={t.name} className={cx(!t.found && t.required && 'bg-danger/5')}>
                    <td className="font-mono text-xs whitespace-nowrap">
                      {t.name}
                      {t.required && <span className="ml-1.5 chip text-2xs">required</span>}
                    </td>
                    <td className="whitespace-nowrap">
                      {t.found ? (
                        <span className="inline-flex items-center gap-1 text-ok">
                          <CheckCircle2 className="h-3.5 w-3.5" /> found
                        </span>
                      ) : (
                        <span className={cx('inline-flex items-center gap-1', t.required ? 'text-danger' : 'text-muted')}>
                          <XCircle className="h-3.5 w-3.5" /> missing
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-xs">{t.version ?? '—'}</td>
                    <td className="text-muted max-w-[260px]">{t.role}</td>
                    <td className="max-w-[420px]">
                      {t.found && t.path ? (
                        <PathChip path={t.path} />
                      ) : (
                        <div className="flex items-start gap-1">
                          <code className="code whitespace-pre-wrap">{t.install_hint}</code>
                          <CopyButton text={t.install_hint} />
                        </div>
                      )}
                      {t.notes.length > 0 && (
                        <ul className="mt-1 text-2xs text-muted list-disc pl-4">
                          {t.notes.map((n, i) => (
                            <li key={i}>{n}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <div className="grid grid-cols-2 gap-4">
            <Panel title="Platform">
              <KeyValue
                items={[
                  { k: 'OS', v: `${r.platform.os} ${r.platform.os_version}` },
                  { k: 'Architecture', v: `${r.platform.arch}${r.platform.apple_silicon ? ' (Apple Silicon)' : ''}` },
                  { k: 'CPU cores', v: formatNumber(r.platform.cpu_count) },
                  { k: 'RAM', v: `${r.platform.ram_gb.toFixed(1)} GB` },
                  { k: 'Free disk', v: `${r.platform.disk_free_gb.toFixed(1)} GB` },
                  { k: 'GPU', v: r.platform.gpu ?? 'none detected' },
                  { k: 'Python', v: r.platform.python },
                ]}
              />
            </Panel>
            <Panel title="Engine">
              <KeyValue
                items={[
                  { k: 'Engine version', v: r.engine_version },
                  { k: 'Data directory', v: <PathChip path={r.data_dir} /> },
                  { k: 'Can reconstruct', v: r.can_reconstruct ? 'yes' : 'no' },
                  { k: 'Can train', v: r.can_train ? 'yes' : 'no' },
                ]}
              />
              <p className="help mt-3">A run needs roughly 3–10 GB of free disk per project at 8K (keyframes, pinhole views, the COLMAP workspace and checkpoints).</p>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

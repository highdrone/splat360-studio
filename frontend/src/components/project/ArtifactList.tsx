import { Download, FolderOpen } from 'lucide-react';
import type { Artifact } from '@/api/types';
import { api } from '@/api/endpoints';
import { formatBytes, formatRelative } from '@/lib/format';
import { isDesktop, revealPath } from '@/lib/desktop';
import { CopyButton, EmptyState, cx } from '@/components/ui';
import { toast } from '@/store/uiStore';

const KIND_LABEL: Record<Artifact['kind'], string> = {
  ply: 'PLY',
  splat: 'SPLAT',
  report: 'Report',
  image: 'Image',
  json: 'JSON',
  pdf: 'PDF',
  video: 'Video',
  log: 'Log',
  other: 'File',
};

const KIND_STYLE: Partial<Record<Artifact['kind'], string>> = {
  ply: 'text-accent border-accent/40 bg-accent/10',
  splat: 'text-accent border-accent/40 bg-accent/10',
  report: 'text-ok border-ok/40 bg-ok/10',
};

export const ARTIFACT_DESCRIPTIONS: Record<string, string> = {
  'splat.ply': 'Trained Gaussian splat (3DGS PLY). Open in any 3DGS editor or viewer.',
  'splat.splat': 'Compact .splat for lightweight web viewers.',
  'report.json': 'Machine-readable project report.',
  'report.html': 'Human-readable report with charts.',
  'sparse_points.ply': 'SfM point cloud, metric and levelled.',
  'tags.json': 'All AprilTag observations.',
  'job.log': 'Combined log of the last job.',
};

export function ArtifactList({ projectId, artifacts, compact = false }: { projectId: string; artifacts: Artifact[]; compact?: boolean }) {
  if (artifacts.length === 0) {
    return (
      <EmptyState title="No artifacts yet">Artifacts appear as stages finish: the sparse point cloud after camera tracking, the splat after training, the report after export.</EmptyState>
    );
  }
  const desktop = isDesktop();
  const sorted = [...artifacts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return (
    <table className="table">
      <thead>
        <tr>
          <th>File</th>
          <th>Kind</th>
          <th className="text-right">Size</th>
          {!compact && <th>Stage</th>}
          {!compact && <th>Created</th>}
          <th className="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((a) => (
          <tr key={a.name}>
            <td>
              <div className="font-mono text-xs">{a.name}</div>
              {ARTIFACT_DESCRIPTIONS[a.name] && !compact && <div className="text-2xs text-faint">{ARTIFACT_DESCRIPTIONS[a.name]}</div>}
              {/^checkpoint_\d+\.ply$/.test(a.name) && !compact && <div className="text-2xs text-faint">Intermediate splat checkpoint.</div>}
            </td>
            <td>
              <span className={cx('chip', KIND_STYLE[a.kind])}>{KIND_LABEL[a.kind]}</span>
            </td>
            <td className="text-right tabular-nums whitespace-nowrap">{formatBytes(a.size_bytes)}</td>
            {!compact && <td className="text-muted">{a.stage ?? '—'}</td>}
            {!compact && <td className="text-muted whitespace-nowrap">{formatRelative(a.created_at)}</td>}
            <td className="text-right whitespace-nowrap">
              <a className="btn-ghost btn-sm" href={api.artifactUrl(projectId, a.name)} download={a.name} title="Download">
                <Download className="h-3.5 w-3.5" />
                {!compact && 'Download'}
              </a>
              {desktop && (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  title="Reveal in file manager"
                  onClick={() => revealPath(a.path).catch((e: unknown) => toast.error('Could not reveal file', String(e)))}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              )}
              <CopyButton text={a.path} label="Copy path" className="!px-1.5" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function rank(a: Artifact): number {
  if (a.name === 'splat.ply') return 0;
  if (a.name === 'splat.splat') return 1;
  if (a.name === 'report.html') return 2;
  if (a.name === 'report.json') return 3;
  if (a.name === 'sparse_points.ply') return 4;
  if (a.name.startsWith('checkpoint_')) return 6;
  return 5;
}

import { api } from '@/api/endpoints';
import { useAsync } from '@/hooks/useAsync';
import { SplatViewer } from '@/components/SplatViewer';
import { ArtifactList } from '@/components/project/ArtifactList';
import { ErrorState, Note, Panel, Skeleton } from '@/components/ui';
import type { ProjectCtx } from './context';

export function ViewerTab({ ctx }: { ctx: ProjectCtx }) {
  const { project, generation, jobActive } = ctx;
  const artifacts = useAsync((signal) => api.artifacts(project.id, signal), [project.id, generation]);
  const list = artifacts.data ?? project.artifacts ?? [];
  return (
    <div className="space-y-4">
      {jobActive && <Note kind="info">A job is running. The viewer shows the last exported scene; it reloads when the job finishes.</Note>}
      {artifacts.loading && !artifacts.data ? <Skeleton className="h-[520px]" /> : <SplatViewer projectId={project.id} artifacts={list} reloadKey={generation} />}
      <Panel title="Artifacts" actions={artifacts.error ? null : <span className="text-2xs text-muted">{list.length} files</span>}>
        {artifacts.error ? <ErrorState message={artifacts.error} onRetry={artifacts.reload} /> : <ArtifactList projectId={project.id} artifacts={list} />}
      </Panel>
    </div>
  );
}

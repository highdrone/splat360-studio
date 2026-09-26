import type { Job, Project } from '@/api/types';
import type { JobStream } from '@/hooks/useJobStream';

export interface ProjectCtx {
  project: Project;
  /** Live job from the websocket (current or last), or null. */
  job: Job | null;
  stream: JobStream;
  jobActive: boolean;
  /** Re-fetch the project from the server. */
  reload: () => void;
  /** Increments whenever a job reaches a terminal state (artifacts changed). */
  generation: number;
  onRun: (fromStage?: Job['from_stage'] | null, force?: boolean) => Promise<void>;
  onCancel: () => Promise<void>;
  busy: boolean;
}

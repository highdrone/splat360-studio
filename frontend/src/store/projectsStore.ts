import { create } from 'zustand';
import { api } from '@/api/endpoints';
import { errorMessage } from '@/api/client';
import type { Job, JobEvent, Project, ProjectStatus, StageState } from '@/api/types';

interface ProjectsState {
  projects: Project[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Latest job snapshot per project id, fed by the global websocket. */
  liveJobs: Record<string, Job>;
  fetch: () => Promise<void>;
  upsert: (p: Project) => void;
  remove: (id: string) => void;
  applyEvent: (ev: JobEvent) => void;
}

function jobToProjectStatus(job: Job): ProjectStatus | null {
  switch (job.status) {
    case 'queued':
    case 'running':
      return 'running';
    case 'complete':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  loading: false,
  loaded: false,
  error: null,
  liveJobs: {},
  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await api.listProjects();
      set({ projects, loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, loaded: true, error: errorMessage(e) });
    }
  },
  upsert: (p) =>
    set((s) => {
      const idx = s.projects.findIndex((x) => x.id === p.id);
      if (idx < 0) return { projects: [p, ...s.projects] };
      return { projects: s.projects.map((x) => (x.id === p.id ? p : x)) };
    }),
  remove: (id) => set((s) => ({ projects: s.projects.filter((p) => p.id !== id) })),
  applyEvent: (ev) => {
    const s = get();
    if (ev.type === 'job' || ev.type === 'snapshot') {
      const job = ev.job;
      if (!job) return;
      const status = jobToProjectStatus(job);
      set({
        liveJobs: { ...s.liveJobs, [job.project_id]: job },
        projects: s.projects.map((p) =>
          p.id === job.project_id
            ? {
                ...p,
                status: status ?? p.status,
                stages: job.stages,
                current_job_id: job.status === 'queued' || job.status === 'running' ? job.id : null,
                last_job_id: job.id,
                updated_at: ev.ts ?? p.updated_at,
              }
            : p,
        ),
      });
    } else if (ev.type === 'stage' && ev.stage) {
      const stage: StageState = ev.stage;
      // Find the project via the job we know about.
      const entry = Object.values(s.liveJobs).find((j) => j.id === ev.job_id);
      const projectId = entry?.project_id ?? s.projects.find((p) => p.current_job_id === ev.job_id)?.id;
      if (!projectId) return;
      const patch = (stages: StageState[]) => {
        const idx = stages.findIndex((x) => x.name === stage.name);
        return idx >= 0 ? stages.map((x, i) => (i === idx ? stage : x)) : [...stages, stage];
      };
      set({
        liveJobs: entry ? { ...s.liveJobs, [projectId]: { ...entry, stages: patch(entry.stages) } } : s.liveJobs,
        projects: s.projects.map((p) => (p.id === projectId ? { ...p, stages: patch(p.stages), status: 'running' } : p)),
      });
    }
  },
}));

/**
 * Pure reducer for the job websocket stream. Kept separate from the hook so
 * it can be unit-tested: apply a `snapshot` first, then `stage` / `log` /
 * `job` events.
 */
import type { Job, JobEvent, StageState } from '@/api/types';

export const MAX_LOG_LINES = 5000;

export interface JobStreamState {
  job: Job | null;
  logLines: string[];
  /** Monotonic counter so consumers can key on log growth cheaply. */
  logSeq: number;
  lastEventAt: string | null;
  hasSnapshot: boolean;
}

export const initialJobStreamState: JobStreamState = {
  job: null,
  logLines: [],
  logSeq: 0,
  lastEventAt: null,
  hasSnapshot: false,
};

export type JobStreamAction =
  | { type: 'event'; event: JobEvent }
  | { type: 'reset' }
  | { type: 'setJob'; job: Job }
  | { type: 'backfillLog'; lines: string[] };

function mergeStage(job: Job, stage: StageState): Job {
  const idx = job.stages.findIndex((s) => s.name === stage.name);
  const stages = idx >= 0 ? job.stages.map((s, i) => (i === idx ? stage : s)) : [...job.stages, stage];
  let currentStage = job.current_stage;
  if (stage.status === 'running') currentStage = stage.name;
  const status = job.status === 'queued' && stage.status === 'running' ? 'running' : job.status;
  return { ...job, stages, current_stage: currentStage, status };
}

function appendLines(existing: string[], incoming: string[]): string[] {
  if (incoming.length === 0) return existing;
  const merged = existing.concat(incoming);
  return merged.length > MAX_LOG_LINES ? merged.slice(merged.length - MAX_LOG_LINES) : merged;
}

export function jobStreamReducer(state: JobStreamState, action: JobStreamAction): JobStreamState {
  switch (action.type) {
    case 'reset':
      return initialJobStreamState;
    case 'setJob':
      return { ...state, job: action.job };
    case 'backfillLog': {
      // Backfill replaces what we have when we have nothing or fewer lines (after a reconnect gap).
      if (state.logLines.length === 0 || action.lines.length >= state.logLines.length) {
        const lines = action.lines.length > MAX_LOG_LINES ? action.lines.slice(-MAX_LOG_LINES) : action.lines;
        return { ...state, logLines: lines, logSeq: state.logSeq + 1 };
      }
      return state;
    }
    case 'event': {
      const ev = action.event;
      switch (ev.type) {
        case 'snapshot':
          if (!ev.job) return state;
          return { ...state, job: ev.job, hasSnapshot: true, lastEventAt: ev.ts };
        case 'job':
          if (!ev.job) return state;
          return { ...state, job: ev.job, lastEventAt: ev.ts };
        case 'stage': {
          if (!ev.stage) return state;
          if (!state.job) {
            // Stage before snapshot: ignore, the snapshot will carry it.
            return { ...state, lastEventAt: ev.ts };
          }
          return { ...state, job: mergeStage(state.job, ev.stage), lastEventAt: ev.ts };
        }
        case 'log': {
          if (ev.line == null) return state;
          const incoming = ev.line.split(/\r?\n/).filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
          return {
            ...state,
            logLines: appendLines(state.logLines, incoming),
            logSeq: state.logSeq + 1,
            lastEventAt: ev.ts,
          };
        }
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

/** Parse a raw websocket message into a JobEvent, or null if malformed. */
export function parseJobEvent(data: unknown): JobEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const obj = JSON.parse(data) as Partial<JobEvent>;
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;
    if (!['job', 'stage', 'log', 'snapshot'].includes(obj.type)) return null;
    return obj as JobEvent;
  } catch {
    return null;
  }
}

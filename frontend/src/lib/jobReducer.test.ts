import { describe, expect, it } from 'vitest';
import { MAX_LOG_LINES, initialJobStreamState, jobStreamReducer, parseJobEvent } from './jobReducer';
import type { Job, StageState } from '@/api/types';

const stage = (name: StageState['name'], status: StageState['status'] = 'pending', extra: Partial<StageState> = {}): StageState => ({
  name,
  label: name,
  status,
  progress: 0,
  message: '',
  started_at: null,
  finished_at: null,
  eta_s: null,
  metrics: {},
  error: null,
  ...extra,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  project_id: 'p1',
  status: 'queued',
  from_stage: 'probe',
  stages: [stage('probe'), stage('extract')],
  created_at: '2026-01-01T00:00:00Z',
  started_at: null,
  finished_at: null,
  error: null,
  current_stage: null,
  ...over,
});

describe('jobStreamReducer', () => {
  it('applies a snapshot first and marks hasSnapshot', () => {
    const s = jobStreamReducer(initialJobStreamState, { type: 'event', event: { type: 'snapshot', job_id: 'j1', ts: 't1', job: job() } });
    expect(s.job?.id).toBe('j1');
    expect(s.hasSnapshot).toBe(true);
    expect(s.lastEventAt).toBe('t1');
  });

  it('ignores stage events that arrive before any job state', () => {
    const s = jobStreamReducer(initialJobStreamState, { type: 'event', event: { type: 'stage', job_id: 'j1', ts: 't0', stage: stage('probe', 'running') } });
    expect(s.job).toBeNull();
  });

  it('merges stage updates into the job and promotes queued -> running', () => {
    let s = jobStreamReducer(initialJobStreamState, { type: 'event', event: { type: 'snapshot', job_id: 'j1', ts: 't1', job: job() } });
    s = jobStreamReducer(s, { type: 'event', event: { type: 'stage', job_id: 'j1', ts: 't2', stage: stage('extract', 'running', { progress: 0.4, message: 'working' }) } });
    expect(s.job?.status).toBe('running');
    expect(s.job?.current_stage).toBe('extract');
    expect(s.job?.stages.find((x) => x.name === 'extract')?.progress).toBe(0.4);
    expect(s.job?.stages).toHaveLength(2);
  });

  it('appends unknown stages instead of dropping them', () => {
    let s = jobStreamReducer(initialJobStreamState, { type: 'event', event: { type: 'snapshot', job_id: 'j1', ts: 't1', job: job() } });
    s = jobStreamReducer(s, { type: 'event', event: { type: 'stage', job_id: 'j1', ts: 't2', stage: stage('train', 'running') } });
    expect(s.job?.stages.map((x) => x.name)).toEqual(['probe', 'extract', 'train']);
  });

  it('collects log lines, splits multi-line payloads and caps the buffer', () => {
    let s = jobStreamReducer(initialJobStreamState, { type: 'event', event: { type: 'log', job_id: 'j1', ts: 't', line: 'a\nb\n' } });
    expect(s.logLines).toEqual(['a', 'b']);
    expect(s.logSeq).toBe(1);
    for (let i = 0; i < MAX_LOG_LINES + 10; i += 1) {
      s = jobStreamReducer(s, { type: 'event', event: { type: 'log', job_id: 'j1', ts: 't', line: `line ${i}` } });
    }
    expect(s.logLines.length).toBe(MAX_LOG_LINES);
    expect(s.logLines[s.logLines.length - 1]).toBe(`line ${MAX_LOG_LINES + 9}`);
  });

  it('replaces the job on a terminal job event', () => {
    let s = jobStreamReducer(initialJobStreamState, { type: 'event', event: { type: 'snapshot', job_id: 'j1', ts: 't1', job: job({ status: 'running' }) } });
    s = jobStreamReducer(s, { type: 'event', event: { type: 'job', job_id: 'j1', ts: 't9', job: job({ status: 'complete', finished_at: 'x' }) } });
    expect(s.job?.status).toBe('complete');
  });

  it('backfills the log only when it has more lines than the buffer', () => {
    let s = jobStreamReducer(initialJobStreamState, { type: 'backfillLog', lines: ['1', '2', '3'] });
    expect(s.logLines).toEqual(['1', '2', '3']);
    s = jobStreamReducer(s, { type: 'backfillLog', lines: ['1'] });
    expect(s.logLines).toEqual(['1', '2', '3']);
  });

  it('resets to the initial state', () => {
    const s = jobStreamReducer({ ...initialJobStreamState, logLines: ['x'], hasSnapshot: true }, { type: 'reset' });
    expect(s).toEqual(initialJobStreamState);
  });
});

describe('parseJobEvent', () => {
  it('parses known event types', () => {
    expect(parseJobEvent(JSON.stringify({ type: 'log', job_id: 'j', ts: 't', line: 'hi' }))?.type).toBe('log');
  });
  it('ignores ping frames, malformed JSON and non-string data', () => {
    expect(parseJobEvent(JSON.stringify({ type: 'ping' }))).toBeNull();
    expect(parseJobEvent('{not json')).toBeNull();
    expect(parseJobEvent(new ArrayBuffer(2))).toBeNull();
    expect(parseJobEvent('null')).toBeNull();
  });
});

/**
 * Typed wrappers for every route in docs/API.md.
 */
import { apiUrl, request, requestBlob, requestText, upload, type UploadHandle } from './client';
import type {
  Artifact,
  CamerasResponse,
  DoctorReport,
  Health,
  Job,
  KeyframeList,
  PipelineSettings,
  Project,
  ProjectCreate,
  ProjectReport,
  ProjectUpdate,
  QualityPreset,
  RunRequest,
  SetSourceRequest,
  StageInfo,
  SyntheticDemoRequest,
  TagFamilyInfo,
  TagObservation,
  TagPlan,
  TagPlanRequest,
  TagSheetLayout,
  TagSheetRequest,
  TagSummary,
  ViewList,
} from './types';

const enc = encodeURIComponent;

export const api = {
  // Health and environment
  health: (signal?: AbortSignal) => request<Health>('/api/health', { signal }),
  doctor: (signal?: AbortSignal) => request<DoctorReport>('/api/doctor', { signal }),
  settingsDefaults: (signal?: AbortSignal) => request<PipelineSettings>('/api/settings/defaults', { signal }),
  settingsPresets: (signal?: AbortSignal) => request<QualityPreset[]>('/api/settings/presets', { signal }),
  stages: (signal?: AbortSignal) => request<StageInfo[]>('/api/stages', { signal }),

  // Projects
  listProjects: (signal?: AbortSignal) => request<Project[]>('/api/projects', { signal }),
  createProject: (body: ProjectCreate) => request<Project>('/api/projects', { method: 'POST', body }),
  getProject: (id: string, signal?: AbortSignal) => request<Project>(`/api/projects/${enc(id)}`, { signal }),
  updateProject: (id: string, body: ProjectUpdate) =>
    request<Project>(`/api/projects/${enc(id)}`, { method: 'PATCH', body }),
  deleteProject: (id: string) => request<null>(`/api/projects/${enc(id)}`, { method: 'DELETE' }),
  setSource: (id: string, body: SetSourceRequest) =>
    request<Project>(`/api/projects/${enc(id)}/source`, { method: 'POST', body }),
  uploadSource: (id: string, file: File, onProgress?: (loaded: number, total: number) => void): UploadHandle<Project> =>
    upload<Project>(`/api/projects/${enc(id)}/upload`, file, onProgress),
  runProject: (id: string, body: RunRequest = {}) =>
    request<Job>(`/api/projects/${enc(id)}/run`, { method: 'POST', body }),
  projectJobs: (id: string, signal?: AbortSignal) => request<Job[]>(`/api/projects/${enc(id)}/jobs`, { signal }),
  artifacts: (id: string, signal?: AbortSignal) =>
    request<Artifact[]>(`/api/projects/${enc(id)}/artifacts`, { signal }),
  artifactUrl: (id: string, name: string, inline = false) =>
    apiUrl(`/api/projects/${enc(id)}/artifacts/${name.split('/').map(enc).join('/')}`, inline ? { inline: 1 } : undefined),
  keyframes: (id: string, signal?: AbortSignal) => request<KeyframeList>(`/api/projects/${enc(id)}/keyframes`, { signal }),
  keyframeUrl: (id: string, index: number) => apiUrl(`/api/projects/${enc(id)}/keyframes/${index}.jpg`),
  views: (id: string, offset = 0, limit = 200, signal?: AbortSignal) =>
    request<ViewList>(`/api/projects/${enc(id)}/views`, { query: { offset, limit }, signal }),
  viewUrl: (id: string, name: string) =>
    apiUrl(`/api/projects/${enc(id)}/views/${name.split('/').map(enc).join('/')}`),
  tagSummary: (id: string, signal?: AbortSignal) => request<TagSummary>(`/api/projects/${enc(id)}/tags`, { signal }),
  tagObservations: (id: string, tagId?: number, signal?: AbortSignal) =>
    request<TagObservation[]>(`/api/projects/${enc(id)}/tags/observations`, { query: { tag_id: tagId }, signal }),
  report: (id: string, partial = false, signal?: AbortSignal) =>
    request<ProjectReport>(`/api/projects/${enc(id)}/report`, { query: partial ? { partial: 1 } : undefined, signal }),
  cameras: (id: string, signal?: AbortSignal) => request<CamerasResponse>(`/api/projects/${enc(id)}/cameras`, { signal }),

  // Jobs
  listJobs: (signal?: AbortSignal) => request<Job[]>('/api/jobs', { signal }),
  getJob: (id: string, signal?: AbortSignal) => request<Job>(`/api/jobs/${enc(id)}`, { signal }),
  cancelJob: (id: string) => request<Job>(`/api/jobs/${enc(id)}/cancel`, { method: 'POST' }),
  jobLog: (id: string, tail = 500, signal?: AbortSignal) =>
    requestText(`/api/jobs/${enc(id)}/log`, { query: { tail }, signal }),
  jobLogUrl: (id: string, tail = 5000) => apiUrl(`/api/jobs/${enc(id)}/log`, { tail }),

  // AprilTags
  tagFamilies: (signal?: AbortSignal) => request<TagFamilyInfo[]>('/api/tags/families', { signal }),
  tagPngUrl: (family: string, id: number, px = 600) => apiUrl(`/api/tags/${enc(family)}/${id}.png`, { px }),
  tagSvgUrl: (family: string, id: number, sizeMm: number) =>
    apiUrl(`/api/tags/${enc(family)}/${id}.svg`, { size_mm: sizeMm }),
  tagSheet: (body: TagSheetRequest, signal?: AbortSignal) =>
    requestBlob('/api/tags/sheet', { method: 'POST', body, signal }),
  tagSheetLayout: (body: TagSheetRequest, signal?: AbortSignal) =>
    request<TagSheetLayout>('/api/tags/sheet/layout', { method: 'POST', body, signal }),
  tagPlan: (body: TagPlanRequest, signal?: AbortSignal) =>
    request<TagPlan>('/api/tags/plan', { method: 'POST', body, signal }),

  // Demo
  syntheticDemo: (body: SyntheticDemoRequest = {}) =>
    request<Project>('/api/demo/synthetic', { method: 'POST', body }),
};

export type Api = typeof api;

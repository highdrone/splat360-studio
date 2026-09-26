/**
 * TypeScript mirrors of every model in engine/splat360/models.py.
 * Field names are snake_case exactly as the API serialises them.
 * Datetimes are ISO-8601 strings on the wire.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------
export type StageName =
  | 'probe'
  | 'extract'
  | 'reproject'
  | 'tags'
  | 'sfm'
  | 'align'
  | 'train'
  | 'export';

export const STAGE_ORDER: StageName[] = [
  'probe',
  'extract',
  'reproject',
  'tags',
  'sfm',
  'align',
  'train',
  'export',
];

export const STAGE_LABELS: Record<StageName, string> = {
  probe: 'Validate footage',
  extract: 'Select keyframes',
  reproject: 'Build pinhole views',
  tags: 'Detect AprilTags',
  sfm: 'Camera tracking (SfM)',
  align: 'Scale & level scene',
  train: 'Train Gaussian splat',
  export: 'Export & report',
};

export type StageStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped' | 'cancelled';

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export type ProjectStatus = 'draft' | 'ready' | 'running' | 'failed' | 'cancelled' | 'complete';

// ---------------------------------------------------------------------------
// Pipeline settings
// ---------------------------------------------------------------------------
export type ImageFormat = 'jpg' | 'png';

export interface KeyframeSettings {
  target_count: number; // 20..1200
  start_s: number | null;
  end_s: number | null;
  blur_reject_fraction: number; // 0..0.9
  image_format: ImageFormat;
  jpeg_quality: number; // 70..100
}

export interface NadirMaskSettings {
  enabled: boolean;
  radius_deg: number; // 5..60
}

export type ViewLayout = 'cube6' | 'ring8';

export interface ViewSettings {
  layout: ViewLayout;
  fov_deg: number; // 80..120
  size_px: number; // 512..3072
  nadir_mask: NadirMaskSettings;
}

export type TagPlacement = 'floor' | 'wall' | 'mixed';

export interface TagSettings {
  enabled: boolean;
  family: string;
  size_mm: number; // >10..2000
  placement: TagPlacement;
  min_decision_margin: number; // >=0
  ids: number[] | null;
}

export type SfmEngine = 'colmap' | 'glomap';

export interface SfmSettings {
  engine: SfmEngine;
  use_rig: boolean;
  window: number; // 1..30
  loop_stride: number; // 0..100
  max_features: number; // 1024..32768
  guided_matching: boolean;
  min_registered_fraction: number; // 0..1
  threads: number; // -1 = all cores
  use_gpu: boolean;
}

export type TrainBackend = 'auto' | 'brush' | 'opensplat' | 'mock';

export interface TrainSettings {
  backend: TrainBackend;
  iterations: number; // 500..200000
  max_resolution: number; // 256..4096
  sh_degree: number; // 0..4
  max_splats: number; // 10000..20000000
  checkpoint_every: number; // >=0
  extra_args: string[];
}

export type ExportFormat = 'ply' | 'splat';

export interface ExportSettings {
  formats: ExportFormat[];
  keep_intermediates: boolean;
}

export interface PipelineSettings {
  keyframes: KeyframeSettings;
  views: ViewSettings;
  tags: TagSettings;
  sfm: SfmSettings;
  train: TrainSettings;
  export: ExportSettings;
}

export type PresetId = 'fast' | 'balanced' | 'quality';

export interface QualityPreset {
  id: PresetId;
  label: string;
  description: string;
  settings: PipelineSettings;
}

// ---------------------------------------------------------------------------
// Source video
// ---------------------------------------------------------------------------
export type ProbeIssueLevel = 'error' | 'warning' | 'info';

export interface ProbeIssue {
  level: ProbeIssueLevel;
  code: string;
  message: string;
  hint: string | null;
}

export type Projection = 'equirectangular' | 'dual_fisheye' | 'unknown';

export interface ProbeInfo {
  path: string;
  filename: string;
  size_bytes: number;
  container: string | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  duration_s: number | null;
  frame_count: number | null;
  bit_rate: number | null;
  pix_fmt: string | null;
  is_equirectangular: boolean;
  projection: Projection;
  is_insta360_raw: boolean;
  camera_make: string | null;
  camera_model: string | null;
  issues: ProbeIssue[];
}

// ---------------------------------------------------------------------------
// Jobs and stages
// ---------------------------------------------------------------------------
export interface StageState {
  name: StageName;
  label: string;
  status: StageStatus;
  progress: number; // 0..1
  message: string;
  started_at: string | null;
  finished_at: string | null;
  eta_s: number | null;
  metrics: Record<string, unknown>;
  error: string | null;
}

export interface Job {
  id: string;
  project_id: string;
  status: JobStatus;
  from_stage: StageName;
  stages: StageState[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  current_stage: StageName | null;
}

export type JobEventType = 'job' | 'stage' | 'log' | 'snapshot';

export interface JobEvent {
  type: JobEventType;
  job_id: string;
  ts: string;
  job?: Job | null; // type == "job" | "snapshot"
  stage?: StageState | null; // type == "stage"
  line?: string | null; // type == "log"
}

// ---------------------------------------------------------------------------
// Artifacts and reports
// ---------------------------------------------------------------------------
export type ArtifactKind =
  | 'ply'
  | 'splat'
  | 'report'
  | 'image'
  | 'json'
  | 'pdf'
  | 'video'
  | 'log'
  | 'other';

export interface Artifact {
  name: string;
  kind: ArtifactKind;
  path: string;
  size_bytes: number;
  url: string;
  stage: StageName | null;
  created_at: string | null;
}

export interface TagObservation {
  tag_id: number;
  view: string;
  frame_index: number;
  face: string;
  corners: number[][]; // 4 x [x, y]
  center: number[];
  decision_margin: number;
  hamming: number;
}

export interface TagSummary {
  family: string;
  size_mm: number;
  total_observations: number;
  unique_tags: number;
  per_tag_counts: Record<string, number>; // dict[int, int] -> JSON object keys are strings
  views_with_tags: number;
  views_total: number;
  coverage_fraction: number;
  weak_tags: number[];
}

export type AlignmentMethod = 'tags' | 'camera_up' | 'none';

export interface AlignmentReport {
  method: AlignmentMethod;
  scale_factor: number | null;
  scale_residual_pct: number | null;
  tags_used: number;
  tag_edge_rmse_mm: number | null;
  ground_plane_from_tags: boolean;
  transform: number[][] | null; // 4x4 row-major
  notes: string[];
}

export interface SfmReport {
  engine: string;
  colmap_version: string | null;
  images_total: number;
  images_registered: number;
  registered_fraction: number;
  frames_total: number;
  frames_registered: number;
  points3d: number;
  mean_reprojection_error_px: number | null;
  mean_track_length: number | null;
  rig_constrained: boolean;
  models_found: number;
  warnings: string[];
}

export interface TrainReport {
  backend: string;
  iterations: number;
  duration_s: number;
  final_splats: number | null;
  psnr: number | null;
  ssim: number | null;
  ply_path: string | null;
  notes: string[];
}

export interface ProjectReport {
  project_id: string;
  generated_at: string;
  source: ProbeInfo | null;
  settings: PipelineSettings;
  keyframes: Record<string, unknown>;
  views: Record<string, unknown>;
  tags: TagSummary | null;
  sfm: SfmReport | null;
  alignment: AlignmentReport | null;
  train: TrainReport | null;
  artifacts: Artifact[];
  quality_score: number | null; // 0..100
  quality_notes: string[];
  timings_s: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  status: ProjectStatus;
  workdir: string;
  source: ProbeInfo | null;
  settings: PipelineSettings;
  current_job_id: string | null;
  last_job_id: string | null;
  stages: StageState[];
  artifacts: Artifact[];
  notes: string;
  thumbnail_url: string | null;
}

export interface ProjectCreate {
  name: string;
  settings?: PipelineSettings | null;
  preset?: PresetId | null;
}

export interface ProjectUpdate {
  name?: string | null;
  settings?: PipelineSettings | null;
  notes?: string | null;
}

export interface SetSourceRequest {
  path: string;
}

export interface RunRequest {
  from_stage?: StageName | null;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Doctor / environment
// ---------------------------------------------------------------------------
export interface ToolStatus {
  name: string;
  found: boolean;
  path: string | null;
  version: string | null;
  required: boolean;
  role: string;
  install_hint: string;
  notes: string[];
}

export interface PlatformInfo {
  os: string;
  os_version: string;
  arch: string;
  cpu_count: number;
  ram_gb: number;
  disk_free_gb: number;
  gpu: string | null;
  python: string;
  apple_silicon: boolean;
}

export interface DoctorReport {
  ready: boolean;
  can_reconstruct: boolean;
  can_train: boolean;
  tools: ToolStatus[];
  platform: PlatformInfo;
  trainer: string | null;
  data_dir: string;
  engine_version: string;
  messages: string[];
}

// ---------------------------------------------------------------------------
// Tag printing
// ---------------------------------------------------------------------------
export interface TagFamilyInfo {
  name: string;
  ncodes: number;
  nbits: number;
  hamming: number;
  width_at_border: number;
  total_width: number;
  recommended: boolean;
  description: string;
}

export type PageSize = 'letter' | 'a4' | 'tabloid' | 'a3' | 'a2' | 'a1' | 'a0';
export type Orientation = 'portrait' | 'landscape';

export interface TagSheetRequest {
  family: string;
  ids?: number[] | null;
  first_id: number; // >=0
  count: number; // 1..200
  tag_size_mm: number; // >10..2000
  page: PageSize;
  orientation: Orientation;
  margin_mm: number; // 0..50
  label: boolean;
  include_guide: boolean;
  include_scale_check: boolean;
  project_name?: string | null;
}

export type SceneKind = 'room' | 'multi_room' | 'outdoor' | 'object';

export interface TagPlanRequest {
  area_m2: number; // >1..5000
  scene: SceneKind;
  walk_length_m: number; // >1..1000
  ceiling_height_m: number; // >1..30
  printer_max_mm: number; // >50..2000
}

export interface TagPlan {
  recommended_count: number;
  recommended_size_mm: number;
  family: string;
  page: string;
  spacing_m: number;
  max_view_distance_m: number;
  placement_tips: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Misc API payloads
// ---------------------------------------------------------------------------
export interface Health {
  ok: boolean;
  version: string;
  data_dir: string;
  pid: number;
}

export interface SyntheticDemoRequest {
  name?: string;
  frames?: number; // 20..600
  width?: number; // 512..7680
  fps?: number;
  seed?: number;
}

// ---------------------------------------------------------------------------
// Route-specific payloads described in docs/API.md (not Pydantic models)
// ---------------------------------------------------------------------------
export interface StageInfo {
  name: StageName;
  label: string;
}

export interface KeyframeItem {
  index: number;
  time_s: number;
  sharpness: number;
  url: string;
}

export interface KeyframeList {
  count: number;
  items: KeyframeItem[];
}

export interface ViewItem {
  name: string;
  frame_index: number;
  face: string;
  url: string;
}

export interface ViewList {
  count: number;
  faces: string[];
  items: ViewItem[];
}

export interface CameraFrame {
  index: number;
  position: [number, number, number];
  quaternion: [number, number, number, number]; // [w, x, y, z]
}

export interface CamerasResponse {
  frames: CameraFrame[];
  points_sample: number[][]; // [[x, y, z, r, g, b], ...]
}

export const isJobActive = (job: Pick<Job, 'status'> | null | undefined): boolean =>
  !!job && (job.status === 'queued' || job.status === 'running');

export const probeHasErrors = (probe: ProbeInfo | null | undefined): boolean =>
  !!probe && probe.issues.some((i) => i.level === 'error');

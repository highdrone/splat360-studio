"""Shared data models for the Splat360 engine.

These models are the contract between the engine (FastAPI), the web UI and
the desktop shell. Field names are stable; add fields rather than renaming.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------
# Enumerations
# --------------------------------------------------------------------------
class StageName(str, Enum):
    probe = "probe"          # validate the input video
    extract = "extract"      # pick sharp keyframes from the 360 video
    reproject = "reproject"  # equirect -> pinhole views (cube/ring)
    tags = "tags"            # AprilTag detection on the pinhole views
    sfm = "sfm"              # COLMAP structure-from-motion with rig constraints
    align = "align"          # metric scale + gravity alignment from tags
    train = "train"          # Gaussian splat training (Brush / OpenSplat)
    export = "export"        # PLY / .splat / report


STAGE_ORDER: list[StageName] = [
    StageName.probe,
    StageName.extract,
    StageName.reproject,
    StageName.tags,
    StageName.sfm,
    StageName.align,
    StageName.train,
    StageName.export,
]

STAGE_LABELS: dict[StageName, str] = {
    StageName.probe: "Validate footage",
    StageName.extract: "Select keyframes",
    StageName.reproject: "Build pinhole views",
    StageName.tags: "Detect AprilTags",
    StageName.sfm: "Camera tracking (SfM)",
    StageName.align: "Scale & level scene",
    StageName.train: "Train Gaussian splat",
    StageName.export: "Export & report",
}


class StageStatus(str, Enum):
    pending = "pending"
    running = "running"
    complete = "complete"
    failed = "failed"
    skipped = "skipped"
    cancelled = "cancelled"


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    complete = "complete"
    failed = "failed"
    cancelled = "cancelled"


class ProjectStatus(str, Enum):
    draft = "draft"          # no source yet, or source not validated
    ready = "ready"          # source validated, never run
    running = "running"
    failed = "failed"
    cancelled = "cancelled"
    complete = "complete"


# --------------------------------------------------------------------------
# Pipeline settings
# --------------------------------------------------------------------------
class KeyframeSettings(BaseModel):
    target_count: int = Field(200, ge=20, le=1200, description="Keyframes to keep from the clip.")
    start_s: Optional[float] = Field(None, ge=0, description="Trim start (seconds).")
    end_s: Optional[float] = Field(None, ge=0, description="Trim end (seconds).")
    blur_reject_fraction: float = Field(
        0.25, ge=0, le=0.9,
        description="Fraction of candidate frames in each window to reject as blurry before picking.",
    )
    image_format: Literal["jpg", "png"] = "jpg"
    jpeg_quality: int = Field(95, ge=70, le=100)


class NadirMaskSettings(BaseModel):
    enabled: bool = Field(True, description="Mask the tripod / operator at the bottom of the sphere.")
    radius_deg: float = Field(
        30.0, ge=5, le=60,
        description="Angular radius from straight-down that is masked out.",
    )


class ViewSettings(BaseModel):
    layout: Literal["cube6", "ring8"] = Field(
        "cube6",
        description="cube6: 6 faces (fov ~100). ring8: 8 horizontal views + up/down (more overlap, more images).",
    )
    fov_deg: float = Field(100.0, ge=80, le=120, description="Horizontal field of view of each pinhole view.")
    size_px: int = Field(1600, ge=512, le=3072, description="Width/height of each square pinhole view.")
    nadir_mask: NadirMaskSettings = NadirMaskSettings()


class TagSettings(BaseModel):
    enabled: bool = True
    family: str = Field("tag36h11", description="AprilTag family used when printing.")
    size_mm: float = Field(
        200.0, gt=10, le=2000,
        description="Printed size of the black square edge in millimetres (as labelled on the sheet).",
    )
    placement: Literal["floor", "wall", "mixed"] = Field(
        "floor",
        description="Where tags were placed. Floor tags let us level the scene from the tag plane.",
    )
    min_decision_margin: float = Field(30.0, ge=0, description="Reject weak detections below this margin.")
    ids: Optional[list[int]] = Field(None, description="Restrict detection to these ids (from the printed sheet).")


class SfmSettings(BaseModel):
    engine: Literal["colmap", "glomap"] = "colmap"
    use_rig: bool = Field(True, description="Constrain views of one frame as a rigid rig (recommended).")
    window: int = Field(6, ge=1, le=30, description="Match each keyframe with +/- this many neighbours.")
    loop_stride: int = Field(
        10, ge=0, le=100,
        description="Also match every Nth keyframe against every other Nth keyframe for loop closure. 0 disables.",
    )
    max_features: int = Field(8192, ge=1024, le=32768)
    guided_matching: bool = True
    min_registered_fraction: float = Field(
        0.6, ge=0, le=1,
        description="Fail the job if fewer than this fraction of views register.",
    )
    threads: int = Field(-1, description="-1 = all cores.")
    use_gpu: bool = Field(False, description="Only honoured when COLMAP was built with CUDA.")


class TrainSettings(BaseModel):
    backend: Literal["auto", "brush", "opensplat", "mock"] = "auto"
    iterations: int = Field(30000, ge=500, le=200000)
    max_resolution: int = Field(1600, ge=256, le=4096, description="Longest image side used for training.")
    sh_degree: int = Field(3, ge=0, le=4)
    max_splats: int = Field(3_000_000, ge=10_000, le=20_000_000)
    checkpoint_every: int = Field(5000, ge=0, description="Export an intermediate PLY every N iterations (0 = off).")
    extra_args: list[str] = Field(default_factory=list, description="Passed verbatim to the trainer.")


class ExportSettings(BaseModel):
    formats: list[Literal["ply", "splat"]] = Field(default_factory=lambda: ["ply", "splat"])
    keep_intermediates: bool = Field(
        True, description="Keep keyframes and pinhole views after a successful run (needed to re-run stages)."
    )


class PipelineSettings(BaseModel):
    keyframes: KeyframeSettings = KeyframeSettings()
    views: ViewSettings = ViewSettings()
    tags: TagSettings = TagSettings()
    sfm: SfmSettings = SfmSettings()
    train: TrainSettings = TrainSettings()
    export: ExportSettings = ExportSettings()


class QualityPreset(BaseModel):
    id: Literal["fast", "balanced", "quality"]
    label: str
    description: str
    settings: PipelineSettings


# --------------------------------------------------------------------------
# Source video
# --------------------------------------------------------------------------
class ProbeIssue(BaseModel):
    level: Literal["error", "warning", "info"]
    code: str
    message: str
    hint: Optional[str] = None


class ProbeInfo(BaseModel):
    path: str
    filename: str
    size_bytes: int
    container: Optional[str] = None
    codec: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    duration_s: Optional[float] = None
    frame_count: Optional[int] = None
    bit_rate: Optional[int] = None
    pix_fmt: Optional[str] = None
    is_equirectangular: bool = False
    projection: Literal["equirectangular", "dual_fisheye", "unknown"] = "unknown"
    is_insta360_raw: bool = False
    camera_make: Optional[str] = None
    camera_model: Optional[str] = None
    issues: list[ProbeIssue] = Field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(i.level == "error" for i in self.issues)


# --------------------------------------------------------------------------
# Jobs and stages
# --------------------------------------------------------------------------
class StageState(BaseModel):
    name: StageName
    label: str
    status: StageStatus = StageStatus.pending
    progress: float = Field(0.0, ge=0, le=1)
    message: str = ""
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    eta_s: Optional[float] = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None


class Job(BaseModel):
    id: str
    project_id: str
    status: JobStatus = JobStatus.queued
    from_stage: StageName = StageName.probe
    stages: list[StageState]
    created_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None
    current_stage: Optional[StageName] = None

    @property
    def is_active(self) -> bool:
        return self.status in (JobStatus.queued, JobStatus.running)


class JobEvent(BaseModel):
    """Message sent over the job websocket."""
    type: Literal["job", "stage", "log", "snapshot"]
    job_id: str
    ts: datetime
    job: Optional[Job] = None            # type == "job" | "snapshot"
    stage: Optional[StageState] = None  # type == "stage"
    line: Optional[str] = None          # type == "log"


# --------------------------------------------------------------------------
# Artifacts and reports
# --------------------------------------------------------------------------
class Artifact(BaseModel):
    name: str            # stable identifier, e.g. "splat.ply"
    kind: Literal["ply", "splat", "report", "image", "json", "pdf", "video", "log", "other"]
    path: str            # absolute path on disk
    size_bytes: int
    url: str             # download URL relative to API root
    stage: Optional[StageName] = None
    created_at: Optional[datetime] = None


class TagObservation(BaseModel):
    tag_id: int
    view: str                      # image name relative to the views folder
    frame_index: int
    face: str
    corners: list[list[float]]     # 4 x [x, y] pixel coords, detector order
    center: list[float]
    decision_margin: float
    hamming: int


class TagSummary(BaseModel):
    family: str
    size_mm: float
    total_observations: int
    unique_tags: int
    per_tag_counts: dict[int, int]
    views_with_tags: int
    views_total: int
    coverage_fraction: float
    weak_tags: list[int] = Field(default_factory=list, description="Tags seen in fewer than 3 views.")


class AlignmentReport(BaseModel):
    method: Literal["tags", "camera_up", "none"]
    scale_factor: Optional[float] = None
    scale_residual_pct: Optional[float] = None
    tags_used: int = 0
    tag_edge_rmse_mm: Optional[float] = None
    ground_plane_from_tags: bool = False
    transform: Optional[list[list[float]]] = None   # 4x4 row-major similarity applied to the model
    notes: list[str] = Field(default_factory=list)


class SfmReport(BaseModel):
    engine: str
    colmap_version: Optional[str] = None
    images_total: int
    images_registered: int
    registered_fraction: float
    frames_total: int
    frames_registered: int
    points3d: int
    mean_reprojection_error_px: Optional[float] = None
    mean_track_length: Optional[float] = None
    rig_constrained: bool = False
    models_found: int = 1
    warnings: list[str] = Field(default_factory=list)


class TrainReport(BaseModel):
    backend: str
    iterations: int
    duration_s: float
    final_splats: Optional[int] = None
    psnr: Optional[float] = None
    ssim: Optional[float] = None
    ply_path: Optional[str] = None
    notes: list[str] = Field(default_factory=list)


class ProjectReport(BaseModel):
    project_id: str
    generated_at: datetime
    source: Optional[ProbeInfo] = None
    settings: PipelineSettings
    keyframes: dict[str, Any] = Field(default_factory=dict)
    views: dict[str, Any] = Field(default_factory=dict)
    tags: Optional[TagSummary] = None
    sfm: Optional[SfmReport] = None
    alignment: Optional[AlignmentReport] = None
    train: Optional[TrainReport] = None
    artifacts: list[Artifact] = Field(default_factory=list)
    quality_score: Optional[float] = Field(None, ge=0, le=100)
    quality_notes: list[str] = Field(default_factory=list)
    timings_s: dict[str, float] = Field(default_factory=dict)


# --------------------------------------------------------------------------
# Projects
# --------------------------------------------------------------------------
class Project(BaseModel):
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    status: ProjectStatus = ProjectStatus.draft
    workdir: str
    source: Optional[ProbeInfo] = None
    settings: PipelineSettings = PipelineSettings()
    current_job_id: Optional[str] = None
    last_job_id: Optional[str] = None
    stages: list[StageState] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    notes: str = ""
    thumbnail_url: Optional[str] = None


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    settings: Optional[PipelineSettings] = None
    preset: Optional[Literal["fast", "balanced", "quality"]] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    settings: Optional[PipelineSettings] = None
    notes: Optional[str] = None


class SetSourceRequest(BaseModel):
    path: str = Field(..., description="Absolute path to the equirectangular video on this machine.")


class RunRequest(BaseModel):
    from_stage: Optional[StageName] = Field(
        None, description="Restart from this stage, reusing earlier outputs. Default: first incomplete stage."
    )
    force: bool = Field(False, description="Ignore cached stage outputs and run everything from from_stage.")


# --------------------------------------------------------------------------
# Doctor / environment
# --------------------------------------------------------------------------
class ToolStatus(BaseModel):
    name: str
    found: bool
    path: Optional[str] = None
    version: Optional[str] = None
    required: bool
    role: str
    install_hint: str
    notes: list[str] = Field(default_factory=list)


class PlatformInfo(BaseModel):
    os: str
    os_version: str
    arch: str
    cpu_count: int
    ram_gb: float
    disk_free_gb: float
    gpu: Optional[str] = None
    python: str
    apple_silicon: bool = False


class DoctorReport(BaseModel):
    ready: bool
    can_reconstruct: bool
    can_train: bool
    tools: list[ToolStatus]
    platform: PlatformInfo
    trainer: Optional[str] = None
    data_dir: str
    engine_version: str
    messages: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Tag printing
# --------------------------------------------------------------------------
class TagFamilyInfo(BaseModel):
    name: str
    ncodes: int
    nbits: int
    hamming: int
    width_at_border: int
    total_width: int
    recommended: bool
    description: str


class TagSheetRequest(BaseModel):
    family: str = "tag36h11"
    ids: Optional[list[int]] = Field(None, description="Explicit ids. If omitted, uses first_id..first_id+count-1.")
    first_id: int = Field(0, ge=0)
    count: int = Field(12, ge=1, le=200)
    tag_size_mm: float = Field(200.0, gt=10, le=2000, description="Black square edge length as printed.")
    page: Literal["letter", "a4", "tabloid", "a3", "a2", "a1", "a0"] = "letter"
    orientation: Literal["portrait", "landscape"] = "portrait"
    margin_mm: float = Field(10.0, ge=0, le=50)
    label: bool = True
    include_guide: bool = Field(True, description="Prepend a placement guide page.")
    include_scale_check: bool = Field(True, description="Print a 100 mm ruler to verify the printer did not scale.")
    project_name: Optional[str] = None


class TagPlanRequest(BaseModel):
    area_m2: float = Field(50.0, gt=1, le=5000)
    scene: Literal["room", "multi_room", "outdoor", "object"] = "room"
    walk_length_m: float = Field(20.0, gt=1, le=1000)
    ceiling_height_m: float = Field(2.7, gt=1, le=30)
    printer_max_mm: float = Field(279.0, gt=50, le=2000, description="Largest printable edge on your printer.")


class TagPlan(BaseModel):
    recommended_count: int
    recommended_size_mm: float
    family: str
    page: str
    spacing_m: float
    max_view_distance_m: float
    placement_tips: list[str]
    warnings: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Misc API payloads
# --------------------------------------------------------------------------
class Health(BaseModel):
    ok: bool
    version: str
    data_dir: str
    pid: int


class SyntheticDemoRequest(BaseModel):
    name: str = "Synthetic demo room"
    frames: int = Field(90, ge=20, le=600)
    width: int = Field(2048, ge=512, le=7680)
    fps: float = 30.0
    seed: int = 0

"""Project persistence: one directory per project under ``<data-dir>/projects``."""
from __future__ import annotations

import json
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings as cfg
from .models import Job, PipelineSettings, Project, ProjectStatus, StageState, STAGE_LABELS, STAGE_ORDER


def now() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class ProjectPaths:
    """Well-known locations inside a project directory."""

    def __init__(self, root: Path):
        self.root = root

    @property
    def project_json(self) -> Path: return self.root / "project.json"
    @property
    def source_dir(self) -> Path: return self.root / "source"
    @property
    def keyframes(self) -> Path: return self.root / "keyframes"
    @property
    def views(self) -> Path: return self.root / "views"
    @property
    def tags_dir(self) -> Path: return self.root / "tags"
    @property
    def sfm(self) -> Path: return self.root / "sfm"
    @property
    def align(self) -> Path: return self.root / "align"
    @property
    def train(self) -> Path: return self.root / "train"
    @property
    def export(self) -> Path: return self.root / "export"
    @property
    def logs(self) -> Path: return self.root / "logs"
    @property
    def jobs(self) -> Path: return self.root / "jobs"
    @property
    def stages(self) -> Path: return self.root / "stages"

    def stage_marker(self, stage: str) -> Path:
        return self.stages / f"{stage}.json"


def fresh_stages() -> list[StageState]:
    return [StageState(name=s, label=STAGE_LABELS[s]) for s in STAGE_ORDER]


class ProjectStore:
    def __init__(self, data_dir: Optional[Path] = None):
        self.data_dir = Path(data_dir) if data_dir else cfg.data_dir
        self.projects_dir = self.data_dir / "projects"
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    # -- helpers ---------------------------------------------------------
    def paths(self, project_id: str) -> ProjectPaths:
        return ProjectPaths(self.projects_dir / project_id)

    def _write_json(self, path: Path, data: str) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(data)
        tmp.replace(path)

    # -- projects --------------------------------------------------------
    def list_projects(self) -> list[Project]:
        out = []
        for d in self.projects_dir.iterdir():
            if (d / "project.json").exists():
                try:
                    out.append(Project.model_validate_json((d / "project.json").read_text()))
                except Exception:
                    continue
        out.sort(key=lambda p: p.updated_at, reverse=True)
        return out

    def get(self, project_id: str) -> Optional[Project]:
        p = self.paths(project_id).project_json
        if not p.exists():
            return None
        return Project.model_validate_json(p.read_text())

    def create(self, name: str, settings: Optional[PipelineSettings] = None) -> Project:
        with self._lock:
            pid = new_id("prj")
            paths = self.paths(pid)
            for d in (paths.root, paths.source_dir, paths.logs, paths.jobs, paths.stages):
                d.mkdir(parents=True, exist_ok=True)
            t = now()
            project = Project(id=pid, name=name, created_at=t, updated_at=t, workdir=str(paths.root),
                              settings=settings or PipelineSettings(), stages=fresh_stages())
            self.save(project)
            return project

    def save(self, project: Project) -> Project:
        with self._lock:
            project.updated_at = now()
            self._write_json(self.paths(project.id).project_json, project.model_dump_json(indent=1))
        return project

    def delete(self, project_id: str) -> bool:
        with self._lock:
            root = self.paths(project_id).root
            if not root.exists():
                return False
            shutil.rmtree(root)
            return True

    # -- jobs ------------------------------------------------------------
    def save_job(self, job: Job) -> None:
        d = self.paths(job.project_id).jobs
        d.mkdir(parents=True, exist_ok=True)
        self._write_json(d / f"{job.id}.json", job.model_dump_json(indent=1))

    def get_job(self, job_id: str) -> Optional[Job]:
        for d in self.projects_dir.iterdir():
            f = d / "jobs" / f"{job_id}.json"
            if f.exists():
                return Job.model_validate_json(f.read_text())
        return None

    def jobs_for_project(self, project_id: str) -> list[Job]:
        d = self.paths(project_id).jobs
        if not d.exists():
            return []
        jobs = [Job.model_validate_json(f.read_text()) for f in d.glob("*.json")]
        jobs.sort(key=lambda j: j.created_at, reverse=True)
        return jobs

    def all_jobs(self) -> list[Job]:
        out = []
        for p in self.list_projects():
            out.extend(self.jobs_for_project(p.id))
        out.sort(key=lambda j: (j.status.value not in ("queued", "running"), -j.created_at.timestamp()))
        return out

    def job_log_path(self, job: Job) -> Path:
        return self.paths(job.project_id).logs / f"{job.id}.log"

    # -- stage markers -----------------------------------------------------
    def stage_marker(self, project_id: str, stage: str) -> Optional[dict]:
        f = self.paths(project_id).stage_marker(stage)
        if not f.exists():
            return None
        try:
            return json.loads(f.read_text())
        except Exception:
            return None

    def write_stage_marker(self, project_id: str, stage: str, data: dict) -> None:
        f = self.paths(project_id).stage_marker(stage)
        f.parent.mkdir(parents=True, exist_ok=True)
        self._write_json(f, json.dumps(data, indent=1, default=str))

    def clear_stage_markers(self, project_id: str, from_stage: str) -> None:
        order = [s.value for s in STAGE_ORDER]
        for s in order[order.index(from_stage):]:
            f = self.paths(project_id).stage_marker(s)
            if f.exists():
                f.unlink()

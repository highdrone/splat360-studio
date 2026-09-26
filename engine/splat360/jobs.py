"""Job manager: runs pipeline jobs on a worker thread and publishes progress events."""
from __future__ import annotations

import queue
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from .models import (Job, JobEvent, JobStatus, Project, ProjectStatus, StageName, StageState, StageStatus,
                     STAGE_LABELS, STAGE_ORDER)
from .store import ProjectStore, new_id, now
from .util.proc import CancelToken, Cancelled, ToolError


class EventBus:
    """Thread-safe fan-out of JobEvents to subscribers (websockets)."""

    def __init__(self) -> None:
        self._subs: dict[int, tuple[Optional[str], queue.Queue]] = {}
        self._lock = threading.Lock()
        self._next = 0

    def subscribe(self, job_id: Optional[str] = None) -> tuple[int, queue.Queue]:
        q: queue.Queue = queue.Queue(maxsize=10000)
        with self._lock:
            sid = self._next
            self._next += 1
            self._subs[sid] = (job_id, q)
        return sid, q

    def unsubscribe(self, sid: int) -> None:
        with self._lock:
            self._subs.pop(sid, None)

    def publish(self, ev: JobEvent) -> None:
        with self._lock:
            subs = list(self._subs.values())
        for jid, q in subs:
            if jid is None and ev.type == "log":
                continue  # global stream carries state only
            if jid is not None and jid != ev.job_id:
                continue
            try:
                q.put_nowait(ev)
            except queue.Full:
                pass


class StageContext:
    """What a stage function receives."""

    def __init__(self, job: Job, project: Project, store: ProjectStore, manager: "JobManager",
                 cancel: CancelToken, stage: StageState):
        self.job = job
        self.project = project
        self.store = store
        self.manager = manager
        self.cancel = cancel
        self.stage = stage
        self.paths = store.paths(project.id)
        self._last_progress_persist = 0.0

    def log(self, line: str) -> None:
        self.manager._log(self.job, f"[{self.stage.name.value}] {line}")

    def progress(self, fraction: float, message: str = "") -> None:
        self.stage.progress = max(0.0, min(1.0, float(fraction)))
        if message:
            self.stage.message = message
        if self.stage.started_at and 0 < self.stage.progress < 1:
            elapsed = (now() - self.stage.started_at).total_seconds()
            self.stage.eta_s = elapsed * (1 - self.stage.progress) / self.stage.progress if self.stage.progress > 0.02 else None
        self.manager._emit_stage(self.job, self.stage)
        self.cancel.check()

    def metrics(self, **kv) -> None:
        self.stage.metrics.update({k: v for k, v in kv.items() if v is not None})
        self.manager._emit_stage(self.job, self.stage)

    def save_project(self) -> None:
        self.store.save(self.project)


StageFn = Callable[[StageContext], Optional[dict]]


class JobManager:
    def __init__(self, store: ProjectStore, stage_fns: dict[StageName, StageFn], bus: Optional[EventBus] = None):
        self.store = store
        self.bus = bus or EventBus()
        self.stage_fns = stage_fns
        self._jobs: dict[str, Job] = {}
        self._cancels: dict[str, CancelToken] = {}
        self._log_files: dict[str, object] = {}
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.RLock()
        self._worker = threading.Thread(target=self._loop, name="splat360-jobs", daemon=True)
        self._worker.start()
        self._recover()

    # -- lifecycle ------------------------------------------------------
    def _recover(self) -> None:
        """Mark jobs that were running when the engine died as failed."""
        for job in self.store.all_jobs():
            if job.status in (JobStatus.queued, JobStatus.running):
                job.status = JobStatus.failed
                job.error = "Engine restarted while the job was running"
                job.finished_at = now()
                for st in job.stages:
                    if st.status == StageStatus.running:
                        st.status = StageStatus.failed
                        st.error = job.error
                self.store.save_job(job)
                p = self.store.get(job.project_id)
                if p and p.current_job_id == job.id:
                    p.current_job_id = None
                    p.status = ProjectStatus.failed
                    p.stages = job.stages
                    self.store.save(p)

    def submit(self, project: Project, from_stage: Optional[StageName], force: bool) -> Job:
        with self._lock:
            active = self.active_for_project(project.id)
            if active:
                raise RuntimeError(f"Project already has an active job ({active.id})")
            start = from_stage or self._first_incomplete(project)
            job = Job(id=new_id("job"), project_id=project.id, from_stage=start, stages=[], created_at=now())
            order = [s for s in STAGE_ORDER]
            start_idx = order.index(start)
            for i, s in enumerate(order):
                st = StageState(name=s, label=STAGE_LABELS[s])
                if i < start_idx:
                    prev = next((x for x in project.stages if x.name == s), None)
                    if prev and prev.status == StageStatus.complete:
                        st = prev.model_copy()
                    else:
                        st.status = StageStatus.skipped
                        st.message = "Reused earlier output"
                job.stages.append(st)
            if force:
                self.store.clear_stage_markers(project.id, start.value)
            self._jobs[job.id] = job
            self._cancels[job.id] = CancelToken()
            self.store.save_job(job)
            project.current_job_id = job.id
            project.last_job_id = job.id
            project.status = ProjectStatus.running
            project.stages = job.stages
            self.store.save(project)
            self._queue.put(job.id)
            self._emit_job(job)
            return job

    def _first_incomplete(self, project: Project) -> StageName:
        for s in STAGE_ORDER:
            marker = self.store.stage_marker(project.id, s.value)
            if not marker:
                return s
        return StageName.export

    def cancel(self, job_id: str) -> Optional[Job]:
        with self._lock:
            job = self._jobs.get(job_id) or self.store.get_job(job_id)
            if not job:
                return None
            if job.status not in (JobStatus.queued, JobStatus.running):
                return job
            tok = self._cancels.get(job_id)
            if tok:
                tok.cancel()
            if job.status == JobStatus.queued:
                self._finish(job, JobStatus.cancelled, "Cancelled before start")
            return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            j = self._jobs.get(job_id)
        return j or self.store.get_job(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            live = dict(self._jobs)
        jobs = {j.id: j for j in self.store.all_jobs()}
        jobs.update(live)
        return sorted(jobs.values(), key=lambda j: (not j.is_active, -j.created_at.timestamp()))

    def active_for_project(self, project_id: str) -> Optional[Job]:
        with self._lock:
            for j in self._jobs.values():
                if j.project_id == project_id and j.is_active:
                    return j
        return None

    # -- events ---------------------------------------------------------
    def _emit_job(self, job: Job) -> None:
        self.bus.publish(JobEvent(type="job", job_id=job.id, ts=now(), job=job))

    def _emit_stage(self, job: Job, stage: StageState) -> None:
        self.bus.publish(JobEvent(type="stage", job_id=job.id, ts=now(), stage=stage))

    def _log(self, job: Job, line: str) -> None:
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        text = f"{ts} {line}"
        fh = self._log_files.get(job.id)
        if fh:
            try:
                fh.write(text + "\n")  # type: ignore[attr-defined]
                fh.flush()             # type: ignore[attr-defined]
            except Exception:
                pass
        self.bus.publish(JobEvent(type="log", job_id=job.id, ts=now(), line=text))

    # -- execution -------------------------------------------------------
    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            job = self._jobs.get(job_id)
            if not job or job.status != JobStatus.queued:
                continue
            try:
                self._run(job)
            except Exception as e:  # noqa: BLE001
                self._finish(job, JobStatus.failed, f"Internal error: {e}")

    def _run(self, job: Job) -> None:
        project = self.store.get(job.project_id)
        if not project:
            self._finish(job, JobStatus.failed, "Project vanished")
            return
        cancel = self._cancels[job.id]
        log_path = self.store.job_log_path(job)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_files[job.id] = open(log_path, "a", encoding="utf-8")
        job.status = JobStatus.running
        job.started_at = now()
        self.store.save_job(job)
        self._emit_job(job)
        self._log(job, f"job {job.id} started for project '{project.name}' from stage {job.from_stage.value}")
        order = [s for s in STAGE_ORDER]
        start_idx = order.index(job.from_stage)
        status = JobStatus.complete
        error: Optional[str] = None
        for st in job.stages[start_idx:]:
            job.current_stage = st.name
            st.status = StageStatus.running
            st.started_at = now()
            st.progress = 0.0
            st.error = None
            st.message = "Starting"
            self._emit_stage(job, st)
            self.store.save_job(job)
            ctx = StageContext(job, project, self.store, self, cancel, st)
            fn = self.stage_fns[st.name]
            try:
                cancel.check()
                result = fn(ctx) or {}
                if result.get("skipped"):
                    st.status = StageStatus.skipped
                    st.message = result.get("message", "Skipped")
                else:
                    st.status = StageStatus.complete
                    st.progress = 1.0
                    st.message = result.get("message", "Done")
                st.metrics.update(result.get("metrics", {}))
                st.finished_at = now()
                st.eta_s = None
                self.store.write_stage_marker(project.id, st.name.value, {
                    "finished_at": st.finished_at, "metrics": st.metrics, "job_id": job.id,
                    "settings": ctx.project.settings.model_dump()})
                self._log(job, f"stage {st.name.value} {st.status.value} in "
                               f"{(st.finished_at - st.started_at).total_seconds():.1f}s")
            except Cancelled:
                st.status = StageStatus.cancelled
                st.message = "Cancelled"
                st.finished_at = now()
                status = JobStatus.cancelled
                error = "Cancelled by user"
                self._log(job, f"stage {st.name.value} cancelled")
            except ToolError as e:
                st.status = StageStatus.failed
                st.error = str(e)
                st.message = "Failed"
                st.finished_at = now()
                status = JobStatus.failed
                error = f"{st.label}: {e}"
                self._log(job, f"stage {st.name.value} failed: {e}")
            except Exception as e:  # noqa: BLE001
                st.status = StageStatus.failed
                st.error = f"{type(e).__name__}: {e}"
                st.message = "Failed"
                st.finished_at = now()
                status = JobStatus.failed
                error = f"{st.label}: {type(e).__name__}: {e}"
                self._log(job, f"stage {st.name.value} crashed: {e}\n{traceback.format_exc()}")
            self._emit_stage(job, st)
            project.stages = job.stages
            self.store.save(project)
            self.store.save_job(job)
            if st.status in (StageStatus.failed, StageStatus.cancelled):
                for later in job.stages[job.stages.index(st) + 1:]:
                    later.status = StageStatus.pending
                break
        self._finish(job, status, error)

    def _finish(self, job: Job, status: JobStatus, error: Optional[str]) -> None:
        job.status = status
        job.error = error
        job.finished_at = now()
        job.current_stage = None
        self.store.save_job(job)
        project = self.store.get(job.project_id)
        if project:
            project.current_job_id = None
            project.stages = job.stages
            project.status = {JobStatus.complete: ProjectStatus.complete, JobStatus.failed: ProjectStatus.failed,
                              JobStatus.cancelled: ProjectStatus.cancelled}.get(status, ProjectStatus.ready)
            try:
                from .pipeline.stages import collect_artifacts, thumbnail_url
                project.artifacts = collect_artifacts(self.store.paths(project.id), project.id)
                project.thumbnail_url = thumbnail_url(self.store.paths(project.id), project.id)
            except Exception:
                pass
            self.store.save(project)
        self._log(job, f"job {job.id} {status.value}" + (f": {error}" if error else ""))
        fh = self._log_files.pop(job.id, None)
        if fh:
            try:
                fh.close()  # type: ignore[attr-defined]
            except Exception:
                pass
        self._emit_job(job)
        with self._lock:
            self._cancels.pop(job.id, None)
            # keep finished jobs in memory briefly for fast lookups; the store has them too
            self._jobs.pop(job.id, None) if len(self._jobs) > 50 else None

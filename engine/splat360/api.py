"""FastAPI application implementing docs/API.md."""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import queue
import shutil
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import ENGINE_VERSION, settings as cfg
from .doctor import run_doctor
from .jobs import JobManager
from .models import (Health, JobEvent, PipelineSettings, ProjectCreate, ProjectUpdate, QualityPreset, RunRequest,
                     SetSourceRequest, StageName, STAGE_LABELS, STAGE_ORDER, SyntheticDemoRequest, TagFamilyInfo,
                     TagPlanRequest, TagSheetRequest, TrainSettings, KeyframeSettings, SfmSettings, ViewSettings,
                     ProjectStatus)
from .pipeline.probe import probe_video
from .pipeline.stages import STAGE_FUNCTIONS, build_report, collect_artifacts, resolve_artifact, thumbnail_url
from .store import ProjectStore
from .tags.families import get_family, list_families


def presets() -> list[QualityPreset]:
    fast = PipelineSettings(
        keyframes=KeyframeSettings(target_count=120), views=ViewSettings(size_px=1200),
        sfm=SfmSettings(window=4, loop_stride=12, max_features=6144),
        train=TrainSettings(iterations=15000, max_resolution=1200, max_splats=1_500_000))
    balanced = PipelineSettings()
    quality = PipelineSettings(
        keyframes=KeyframeSettings(target_count=320), views=ViewSettings(layout="ring8", fov_deg=95, size_px=2000),
        sfm=SfmSettings(window=8, loop_stride=8, max_features=12288),
        train=TrainSettings(iterations=45000, max_resolution=2000, max_splats=6_000_000))
    return [
        QualityPreset(id="fast", label="Fast preview", description="≈120 keyframes, 1200 px views, 15k iterations. "
                      "Good for checking coverage.", settings=fast),
        QualityPreset(id="balanced", label="Balanced", description="200 keyframes, 1600 px cube views, 30k iterations. "
                      "Recommended default.", settings=balanced),
        QualityPreset(id="quality", label="Maximum quality", description="320 keyframes, 2000 px ring views, 45k "
                      "iterations. Several times slower.", settings=quality),
    ]


def create_app(store: Optional[ProjectStore] = None, manager: Optional[JobManager] = None,
               frontend_dir: Optional[Path] = None) -> FastAPI:
    cfg.ensure_dirs()
    store = store or ProjectStore(cfg.data_dir)
    manager = manager or JobManager(store, STAGE_FUNCTIONS)
    app = FastAPI(title="Splat360 Engine", version=ENGINE_VERSION, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.store = store
    app.state.manager = manager

    def get_project(pid: str):
        p = store.get(pid)
        if not p:
            raise HTTPException(404, "Project not found")
        return p

    def refresh(p):
        paths = store.paths(p.id)
        p.artifacts = collect_artifacts(paths, p.id)
        p.thumbnail_url = thumbnail_url(paths, p.id)
        return p

    # -- health / environment -------------------------------------------
    @app.get("/api/health", response_model=Health)
    def health():
        return Health(ok=True, version=ENGINE_VERSION, data_dir=str(cfg.data_dir), pid=os.getpid())

    @app.get("/api/doctor")
    def doctor():
        return run_doctor()

    @app.get("/api/settings/defaults", response_model=PipelineSettings)
    def defaults():
        return PipelineSettings()

    @app.get("/api/settings/presets", response_model=list[QualityPreset])
    def get_presets():
        return presets()

    @app.get("/api/stages")
    def stages():
        return [{"name": s.value, "label": STAGE_LABELS[s]} for s in STAGE_ORDER]

    # -- projects ----------------------------------------------------------
    @app.get("/api/projects")
    def list_projects():
        return [refresh(p) for p in store.list_projects()]

    @app.post("/api/projects", status_code=201)
    def create_project(body: ProjectCreate):
        s = body.settings
        if s is None and body.preset:
            s = next((p.settings for p in presets() if p.id == body.preset), None)
        return store.create(body.name, s)

    @app.get("/api/projects/{pid}")
    def get_one(pid: str):
        return refresh(get_project(pid))

    @app.patch("/api/projects/{pid}")
    def update(pid: str, body: ProjectUpdate):
        p = get_project(pid)
        if manager.active_for_project(pid):
            raise HTTPException(409, "A job is running; wait for it to finish or cancel it first")
        if body.name is not None:
            p.name = body.name
        if body.settings is not None:
            p.settings = body.settings
        if body.notes is not None:
            p.notes = body.notes
        return refresh(store.save(p))

    @app.delete("/api/projects/{pid}", status_code=204)
    def delete(pid: str):
        get_project(pid)
        j = manager.active_for_project(pid)
        if j:
            manager.cancel(j.id)
        store.delete(pid)
        return Response(status_code=204)

    def _set_source(p, path: Path):
        info = probe_video(path)
        p.source = info
        p.status = ProjectStatus.ready if info.ok else ProjectStatus.draft
        p.stages = [st.model_copy(update={"status": "pending", "progress": 0.0, "message": ""}) for st in p.stages]
        store.clear_stage_markers(p.id, StageName.probe.value)
        return refresh(store.save(p))

    @app.post("/api/projects/{pid}/source")
    def set_source(pid: str, body: SetSourceRequest):
        p = get_project(pid)
        path = Path(body.path).expanduser()
        if not path.exists():
            raise HTTPException(422, f"File not found: {path}")
        if manager.active_for_project(pid):
            raise HTTPException(409, "A job is running")
        return _set_source(p, path)

    @app.post("/api/projects/{pid}/upload")
    async def upload(pid: str, file: UploadFile):
        p = get_project(pid)
        if manager.active_for_project(pid):
            raise HTTPException(409, "A job is running")
        dst_dir = store.paths(pid).source_dir
        dst_dir.mkdir(parents=True, exist_ok=True)
        name = Path(file.filename or "upload.mp4").name
        dst = dst_dir / name
        with open(dst, "wb") as fh:
            while True:
                chunk = await file.read(8 * 1024 * 1024)
                if not chunk:
                    break
                fh.write(chunk)
        return _set_source(p, dst)

    @app.post("/api/projects/{pid}/run", status_code=202)
    def run(pid: str, body: RunRequest):
        p = get_project(pid)
        if manager.active_for_project(pid):
            raise HTTPException(409, "A job is already running for this project")
        if not p.source:
            raise HTTPException(422, "Set a source video first")
        if not p.source.ok:
            raise HTTPException(422, "The source video has errors: " + "; ".join(
                i.message for i in p.source.issues if i.level == "error"))
        doc = run_doctor()
        if not doc.can_reconstruct:
            raise HTTPException(422, "Missing required tools: " + "; ".join(doc.messages))
        try:
            return manager.submit(p, body.from_stage, body.force)
        except RuntimeError as e:
            raise HTTPException(409, str(e))

    @app.get("/api/projects/{pid}/jobs")
    def project_jobs(pid: str):
        get_project(pid)
        return store.jobs_for_project(pid)

    @app.get("/api/projects/{pid}/artifacts")
    def artifacts(pid: str):
        get_project(pid)
        return collect_artifacts(store.paths(pid), pid)

    @app.get("/api/projects/{pid}/artifacts/{name}")
    def artifact(pid: str, name: str, inline: int = 0):
        get_project(pid)
        f = resolve_artifact(store.paths(pid), name)
        if not f:
            raise HTTPException(404, "Artifact not found")
        media = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if f.suffix in (".ply", ".splat"):
            media = "application/octet-stream"
        headers = {} if inline else {"Content-Disposition": f'attachment; filename="{f.name}"'}
        return FileResponse(str(f), media_type=media, headers=headers)

    @app.get("/api/projects/{pid}/keyframes")
    def keyframes(pid: str):
        get_project(pid)
        idx = store.paths(pid).keyframes / "index.json"
        if not idx.exists():
            return {"count": 0, "items": []}
        d = json.loads(idx.read_text())
        return {"count": d["count"], "items": [
            {"index": k["index"], "time_s": k["time_s"], "sharpness": k["sharpness"],
             "url": f"/api/projects/{pid}/keyframes/{k['index']}.jpg"} for k in d["items"]]}

    @app.get("/api/projects/{pid}/keyframes/{index}.jpg")
    def keyframe_thumb(pid: str, index: int):
        get_project(pid)
        f = store.paths(pid).keyframes / "thumbs" / f"{index:05d}.jpg"
        if not f.exists():
            raise HTTPException(404, "No thumbnail")
        return FileResponse(str(f), media_type="image/jpeg")

    @app.get("/api/projects/{pid}/views")
    def views(pid: str, offset: int = 0, limit: int = 200):
        get_project(pid)
        idx = store.paths(pid).views / "index.json"
        if not idx.exists():
            return {"count": 0, "faces": [], "items": []}
        d = json.loads(idx.read_text())
        items = d["items"][offset: offset + limit]
        return {"count": len(d["items"]), "faces": d["faces"], "items": [
            {"name": it["name"], "frame_index": it["frame_index"], "face": it["face"],
             "url": f"/api/projects/{pid}/views/{it['name']}"} for it in items]}

    @app.get("/api/projects/{pid}/views/{face}/{fname}")
    def view_image(pid: str, face: str, fname: str):
        get_project(pid)
        if ".." in face or ".." in fname or "/" in face:
            raise HTTPException(400, "bad name")
        f = store.paths(pid).views / face / fname
        if not f.is_file():
            raise HTTPException(404, "No such view")
        return FileResponse(str(f))

    @app.get("/api/projects/{pid}/tags")
    def tags_summary(pid: str):
        get_project(pid)
        f = store.paths(pid).tags_dir / "summary.json"
        if not f.exists():
            raise HTTPException(404, "Tags stage has not run")
        return json.loads(f.read_text())

    @app.get("/api/projects/{pid}/tags/observations")
    def tag_observations(pid: str, tag_id: Optional[int] = None):
        get_project(pid)
        f = store.paths(pid).tags_dir / "observations.json"
        if not f.exists():
            raise HTTPException(404, "Tags stage has not run")
        obs = json.loads(f.read_text())
        if tag_id is not None:
            obs = [o for o in obs if o["tag_id"] == tag_id]
        return obs

    @app.get("/api/projects/{pid}/report")
    def report(pid: str, partial: int = 0):
        p = get_project(pid)
        f = store.paths(pid).export / "report.json"
        if f.exists() and not partial:
            return json.loads(f.read_text())
        if not partial:
            raise HTTPException(404, "Report not generated yet (run the export stage)")
        return build_report(store.paths(pid), p)

    @app.get("/api/projects/{pid}/cameras")
    def cameras(pid: str):
        get_project(pid)
        f = store.paths(pid).align / "cameras.json"
        if not f.exists():
            raise HTTPException(404, "Alignment has not run")
        return FileResponse(str(f), media_type="application/json")

    # -- jobs -------------------------------------------------------------
    @app.get("/api/jobs")
    def jobs():
        return manager.list()

    @app.get("/api/jobs/{jid}")
    def job(jid: str):
        j = manager.get(jid)
        if not j:
            raise HTTPException(404, "Job not found")
        return j

    @app.post("/api/jobs/{jid}/cancel")
    def cancel(jid: str):
        j = manager.cancel(jid)
        if not j:
            raise HTTPException(404, "Job not found")
        return j

    @app.get("/api/jobs/{jid}/log", response_class=PlainTextResponse)
    def job_log(jid: str, tail: int = 500):
        j = manager.get(jid)
        if not j:
            raise HTTPException(404, "Job not found")
        f = store.job_log_path(j)
        if not f.exists():
            return ""
        lines = f.read_text(errors="replace").splitlines()
        return "\n".join(lines[-tail:]) if tail > 0 else "\n".join(lines)

    async def _stream(ws: WebSocket, job_id: Optional[str]):
        await ws.accept()
        sid, q = manager.bus.subscribe(job_id)
        try:
            if job_id:
                j = manager.get(job_id)
                if not j:
                    await ws.send_text(json.dumps({"detail": "Job not found"}))
                    await ws.close(code=4004)
                    return
                await ws.send_text(JobEvent(type="snapshot", job_id=job_id, ts=j.created_at, job=j).model_dump_json())
                if not j.is_active:
                    await ws.send_text(JobEvent(type="job", job_id=job_id, ts=j.created_at, job=j).model_dump_json())
                    await ws.close()
                    return
            loop = asyncio.get_running_loop()
            while True:
                try:
                    ev: JobEvent = await loop.run_in_executor(None, q.get, True, 15)
                except queue.Empty:
                    try:
                        await ws.send_text(json.dumps({"type": "ping"}))
                    except Exception:
                        break
                    continue
                await ws.send_text(ev.model_dump_json())
                if job_id and ev.type == "job" and ev.job and not ev.job.is_active:
                    await ws.close()
                    break
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            manager.bus.unsubscribe(sid)

    @app.websocket("/api/ws/jobs/{jid}")
    async def ws_job(ws: WebSocket, jid: str):
        await _stream(ws, jid)

    @app.websocket("/api/ws/events")
    async def ws_events(ws: WebSocket):
        await _stream(ws, None)

    # -- tags -------------------------------------------------------------
    @app.get("/api/tags/families", response_model=list[TagFamilyInfo])
    def families():
        return [TagFamilyInfo(name=f.name, ncodes=f.ncodes, nbits=f.nbits, hamming=f.hamming,
                              width_at_border=f.width_at_border, total_width=f.total_width,
                              recommended=f.recommended, description=f.description) for f in list_families()]

    @app.get("/api/tags/{family}/{tag_id}.png")
    def tag_png(family: str, tag_id: int, px: int = Query(600, ge=64, le=4096)):
        from .tags.svg import render_tag_png
        try:
            return Response(render_tag_png(family, tag_id, px=px), media_type="image/png")
        except (KeyError, ValueError) as e:
            raise HTTPException(404, str(e))

    @app.get("/api/tags/{family}/{tag_id}.svg")
    def tag_svg(family: str, tag_id: int, size_mm: float = Query(200.0, gt=10, le=2000)):
        from .tags.svg import render_tag_svg
        try:
            return Response(render_tag_svg(family, tag_id, size_mm), media_type="image/svg+xml")
        except (KeyError, ValueError) as e:
            raise HTTPException(404, str(e))

    @app.post("/api/tags/sheet")
    def tag_sheet(body: TagSheetRequest):
        from .tags.sheet import render_tag_sheet
        try:
            get_family(body.family)
            pdf = render_tag_sheet(body)
        except KeyError as e:
            raise HTTPException(422, str(e))
        except ValueError as e:
            raise HTTPException(422, str(e))
        fname = f"splat360-{body.family}-{int(body.tag_size_mm)}mm.pdf"
        return Response(pdf, media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{fname}"'})

    @app.post("/api/tags/sheet/layout")
    def tag_sheet_layout(body: TagSheetRequest):
        from .tags.sheet import sheet_layout
        try:
            return sheet_layout(body)
        except (KeyError, ValueError) as e:
            raise HTTPException(422, str(e))

    @app.post("/api/tags/plan")
    def tag_plan(body: TagPlanRequest):
        from .tags.plan import plan_tags
        return plan_tags(body)

    # -- demo -------------------------------------------------------------
    @app.post("/api/demo/synthetic", status_code=201)
    async def demo(body: SyntheticDemoRequest):
        from .synth import render_synthetic_clip
        p = store.create(body.name, PipelineSettings(
            keyframes=KeyframeSettings(target_count=min(60, max(20, body.frames // 2))),
            views=ViewSettings(size_px=1024),
            tags=__import__("splat360.models", fromlist=["TagSettings"]).TagSettings(size_mm=300.0, placement="mixed"),
            sfm=SfmSettings(window=4, loop_stride=8, max_features=4096),
            train=TrainSettings(iterations=7000, max_resolution=1024, max_splats=800_000, checkpoint_every=0)))
        src = store.paths(p.id).source_dir / "synthetic.mp4"
        await asyncio.get_running_loop().run_in_executor(
            None, lambda: render_synthetic_clip(src, frames=body.frames, width=body.width, fps=body.fps))
        p.notes = "Synthetic room rendered by Splat360 (tag36h11 tags, 300 mm). Use it to verify your installation."
        return _set_source(p, src)

    # -- frontend --------------------------------------------------------
    fe = frontend_dir or _default_frontend_dir()
    if fe and (fe / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=str(fe / "assets")), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = fe / path
            if path and f.is_file():
                return FileResponse(str(f))
            return HTMLResponse((fe / "index.html").read_text())

    return app


def _default_frontend_dir() -> Optional[Path]:
    env = os.environ.get("SPLAT360_FRONTEND_DIR")
    cands = [Path(env)] if env else []
    here = Path(__file__).resolve()
    cands += [here.parents[2] / "frontend" / "dist", here.parent / "frontend_dist"]
    for c in cands:
        if (c / "index.html").exists():
            return c
    return None

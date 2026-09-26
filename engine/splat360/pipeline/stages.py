"""Stage implementations wired into the job manager."""
from __future__ import annotations

import json
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..jobs import StageContext
from ..models import (AlignmentReport, Artifact, ProjectReport, SfmReport, StageName, TagObservation, TagSummary,
                      TrainReport)
from ..store import ProjectPaths
from ..train.dataset import prepare_dataset
from ..train.ply import ply_to_splat, splat_count
from ..train.registry import resolve_trainer
from ..util.proc import ToolError
from . import report as report_mod
from .align import align_model
from .extract import extract_keyframes, load_keyframe_index
from .probe import probe_video
from .reproject import load_view_index, reproject_keyframes
from .sfm import run_sfm


# --------------------------------------------------------------------------
def stage_probe(ctx: StageContext) -> dict:
    src = ctx.project.source
    if not src:
        raise ToolError("No source video set for this project")
    ctx.progress(0.1, "Probing video")
    info = probe_video(src.path)
    ctx.project.source = info
    ctx.save_project()
    errors = [i for i in info.issues if i.level == "error"]
    if errors:
        raise ToolError("; ".join(f"{e.message} {e.hint or ''}".strip() for e in errors))
    for i in info.issues:
        ctx.log(f"{i.level}: {i.message}")
    ctx.log(f"{info.width}x{info.height} @ {info.fps} fps, {info.duration_s:.1f}s, {info.codec}")
    return {"metrics": {"width": info.width, "height": info.height, "fps": info.fps,
                        "duration_s": round(info.duration_s or 0, 2), "codec": info.codec},
            "message": f"{info.width}x{info.height} {info.codec} {info.duration_s:.1f}s"}


def stage_extract(ctx: StageContext) -> dict:
    src = ctx.project.source
    assert src
    idx = extract_keyframes(Path(src.path), src, ctx.project.settings.keyframes, ctx.paths.keyframes,
                            cancel=ctx.cancel, on_progress=ctx.progress, log=ctx.log)
    return {"metrics": {"keyframes": idx.count, "frames_scored": idx.stats["frames_scored"],
                        "sharpness_median": round(idx.stats["sharpness_median_chosen"], 1)},
            "message": f"{idx.count} keyframes"}


def stage_reproject(ctx: StageContext) -> dict:
    kf = load_keyframe_index(ctx.paths.keyframes)
    if not kf:
        raise ToolError("Keyframes missing; re-run from 'extract'")
    vi = reproject_keyframes(ctx.paths.keyframes, kf, ctx.project.settings.views, ctx.paths.views,
                             cancel=ctx.cancel, on_progress=ctx.progress, log=ctx.log)
    return {"metrics": {"views": len(vi.items), "faces": len(vi.faces), "size_px": vi.size,
                        "focal_px": round(vi.focal_px, 1)},
            "message": f"{len(vi.items)} views ({vi.layout}, {vi.size}px)"}


def stage_tags(ctx: StageContext) -> dict:
    ts = ctx.project.settings.tags
    vi = load_view_index(ctx.paths.views)
    if not vi:
        raise ToolError("Views missing; re-run from 'reproject'")
    ctx.paths.tags_dir.mkdir(parents=True, exist_ok=True)
    if not ts.enabled:
        (ctx.paths.tags_dir / "observations.json").write_text("[]")
        return {"skipped": True, "message": "Tag detection disabled"}
    from ..tags.detect import detect_in_directory, save_observations, summarize
    from ..util.proc import cpu_count

    def prog(done: int, total: int) -> None:
        ctx.progress(0.95 * done / max(1, total), f"Scanned {done}/{total} views for AprilTags")

    obs = detect_in_directory(ctx.paths.views, ts.family, ts.min_decision_margin,
                              set(ts.ids) if ts.ids else None, prog, cpu_count())
    save_observations(ctx.paths.tags_dir / "observations.json", obs)
    summary = summarize(obs, ts.family, ts.size_mm, len(vi.items))
    (ctx.paths.tags_dir / "summary.json").write_text(summary.model_dump_json(indent=1))
    ctx.log(f"{summary.total_observations} observations of {summary.unique_tags} tags in "
            f"{summary.views_with_tags}/{summary.views_total} views")
    if summary.unique_tags == 0:
        ctx.log("warning: no tags detected; the scene will not have metric scale")
    return {"metrics": {"observations": summary.total_observations, "unique_tags": summary.unique_tags,
                        "coverage_pct": round(summary.coverage_fraction * 100, 1)},
            "message": f"{summary.unique_tags} tags, {summary.total_observations} observations"}


def stage_sfm(ctx: StageContext) -> dict:
    vi = load_view_index(ctx.paths.views)
    if not vi:
        raise ToolError("Views missing; re-run from 'reproject'")
    rep, _ = run_sfm(ctx.paths.views, vi, ctx.project.settings.sfm, ctx.paths.sfm,
                     cancel=ctx.cancel, on_progress=ctx.progress, log=ctx.log)
    for w in rep.warnings:
        ctx.log(f"warning: {w}")
    return {"metrics": {"registered": f"{rep.images_registered}/{rep.images_total}",
                        "registered_pct": round(rep.registered_fraction * 100, 1),
                        "keyframes_registered": f"{rep.frames_registered}/{rep.frames_total}",
                        "points3d": rep.points3d,
                        "reproj_px": round(rep.mean_reprojection_error_px or 0, 3),
                        "rig": rep.rig_constrained},
            "message": f"{rep.images_registered}/{rep.images_total} views registered"}


def stage_align(ctx: StageContext) -> dict:
    vi = load_view_index(ctx.paths.views)
    model_dir = ctx.paths.sfm / "sparse_final" / "0"
    if not vi or not model_dir.exists():
        raise ToolError("SfM output missing; re-run from 'sfm'")
    obs: list[TagObservation] = []
    f = ctx.paths.tags_dir / "observations.json"
    if f.exists():
        from ..tags.detect import load_observations
        obs = load_observations(f)
    ctx.progress(0.2, "Triangulating tags")
    rep, _ = align_model(model_dir, vi, obs, ctx.project.settings.tags, ctx.paths.align, log=ctx.log)
    for n in rep.notes:
        ctx.log(n)
    return {"metrics": {"method": rep.method, "scale": round(rep.scale_factor, 5) if rep.scale_factor else None,
                        "scale_spread_pct": round(rep.scale_residual_pct, 2) if rep.scale_residual_pct is not None else None,
                        "tags_used": rep.tags_used, "floor_from_tags": rep.ground_plane_from_tags},
            "message": (f"metric scale from {rep.tags_used} tags" if rep.method == "tags"
                        else "levelled from camera poses (no metric scale)")}


def stage_train(ctx: StageContext) -> dict:
    tsettings = ctx.project.settings.train
    model_dir = ctx.paths.align / "sparse" / "0"
    if not model_dir.exists():
        raise ToolError("Aligned model missing; re-run from 'align'")
    trainer = resolve_trainer(tsettings.backend)
    if not trainer.available():
        raise ToolError(f"Trainer '{tsettings.backend}' is not installed. See the Environment page.")
    ctx.log(f"trainer: {trainer.name} ({trainer.executable()})")
    if trainer.name == "mock" and tsettings.backend == "auto":
        ctx.log("warning: no GPU trainer installed (Brush/OpenSplat); producing a point-cloud preview instead")
    ds = ctx.paths.train / "dataset"
    ctx.progress(0.02, "Preparing training dataset")
    info = prepare_dataset(model_dir, ctx.paths.views, ds)
    ctx.log(f"dataset: {info}")
    out = ctx.paths.train / "output"
    if out.exists():
        shutil.rmtree(out)
    rep = trainer.train(ds, out, tsettings, cancel=ctx.cancel, on_progress=ctx.progress, log=ctx.log,
                        metrics=lambda m: ctx.metrics(**m))
    (ctx.paths.train / "report.json").write_text(rep.model_dump_json(indent=1))
    return {"metrics": {"backend": rep.backend, "iterations": rep.iterations, "minutes": round(rep.duration_s / 60, 1),
                        "splats": rep.final_splats, "psnr": rep.psnr},
            "message": f"{rep.backend}: {rep.iterations} iterations"
                       + (f", {rep.final_splats:,} splats" if rep.final_splats else "")}


def stage_export(ctx: StageContext) -> dict:
    ex = ctx.paths.export
    ex.mkdir(parents=True, exist_ok=True)
    trep_f = ctx.paths.train / "report.json"
    if not trep_f.exists():
        raise ToolError("Training output missing; re-run from 'train'")
    trep = TrainReport.model_validate_json(trep_f.read_text())
    if not trep.ply_path or not Path(trep.ply_path).exists():
        raise ToolError("Trained PLY not found")
    fmts = ctx.project.settings.export.formats
    ctx.progress(0.1, "Copying PLY")
    shutil.copyfile(trep.ply_path, ex / "splat.ply")
    n = splat_count(ex / "splat.ply")
    if "splat" in fmts:
        ctx.progress(0.4, "Converting to .splat")
        ply_to_splat(ex / "splat.ply", ex / "splat.splat")
    # keep checkpoints
    for ck in sorted(Path(trep.ply_path).parent.glob("checkpoint_*.ply")):
        if ck.resolve() != Path(trep.ply_path).resolve():
            shutil.copyfile(ck, ex / ck.name)
    for name, src in (("sparse_points.ply", ctx.paths.align / "sparse_points.ply"),
                      ("tags.json", ctx.paths.tags_dir / "observations.json")):
        if src.exists():
            shutil.copyfile(src, ex / name)
    ctx.progress(0.7, "Writing report")
    report = build_report(ctx.paths, ctx.project, trep)
    (ex / "report.json").write_text(report.model_dump_json(indent=1))
    (ex / "report.html").write_text(report_mod.render_html(report))
    log_src = ctx.store.job_log_path(ctx.job)
    if log_src.exists():
        shutil.copyfile(log_src, ex / "job.log")
    if not ctx.project.settings.export.keep_intermediates:
        for d in (ctx.paths.keyframes, ctx.paths.train / "dataset"):
            shutil.rmtree(d, ignore_errors=True)
        ctx.log("removed keyframes and training dataset (keep_intermediates=false)")
    return {"metrics": {"splats": n, "quality_score": report.quality_score, "formats": ",".join(fmts)},
            "message": f"{n:,} splats exported"}


STAGE_FUNCTIONS = {
    StageName.probe: stage_probe,
    StageName.extract: stage_extract,
    StageName.reproject: stage_reproject,
    StageName.tags: stage_tags,
    StageName.sfm: stage_sfm,
    StageName.align: stage_align,
    StageName.train: stage_train,
    StageName.export: stage_export,
}


# --------------------------------------------------------------------------
def _read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text()) if path.exists() else None
    except Exception:
        return None


def build_report(paths: ProjectPaths, project, trep: Optional[TrainReport] = None) -> ProjectReport:
    kf = _read_json(paths.keyframes / "index.json") or {}
    vi = _read_json(paths.views / "index.json") or {}
    tags = _read_json(paths.tags_dir / "summary.json")
    sfm = _read_json(paths.sfm / "report.json")
    al = _read_json(paths.align / "report.json")
    tr = trep.model_dump() if trep else _read_json(paths.train / "report.json")
    timings = {}
    for st in project.stages:
        if st.started_at and st.finished_at:
            timings[st.name.value] = round((st.finished_at - st.started_at).total_seconds(), 1)
    report = ProjectReport(
        project_id=project.id, generated_at=datetime.now(timezone.utc), source=project.source,
        settings=project.settings,
        keyframes={"count": kf.get("count"), **{k: v for k, v in (kf.get("stats") or {}).items()
                                                  if k in ("frames_scored", "sharpness_median_chosen", "start_s", "end_s")}},
        views={k: vi.get(k) for k in ("layout", "fov_deg", "size", "focal_px", "keyframes") if k in vi}
        | ({"count": len(vi.get("items", []))} if vi else {}),
        tags=TagSummary(**tags) if tags else None,
        sfm=SfmReport(**sfm) if sfm else None,
        alignment=AlignmentReport(**al) if al else None,
        train=TrainReport(**tr) if tr else None,
        artifacts=collect_artifacts(paths, project.id),
        timings_s=timings,
    )
    report.quality_score, report.quality_notes = quality_score(report)
    return report


def quality_score(r: ProjectReport) -> tuple[Optional[float], list[str]]:
    notes: list[str] = []
    score = 100.0
    if r.sfm:
        if r.sfm.registered_fraction < 0.95:
            pen = (0.95 - r.sfm.registered_fraction) * 120
            score -= pen
            notes.append(f"{r.sfm.registered_fraction * 100:.0f}% of views registered; unregistered areas will be blurry.")
        if r.sfm.mean_reprojection_error_px and r.sfm.mean_reprojection_error_px > 1.0:
            score -= min(20, (r.sfm.mean_reprojection_error_px - 1.0) * 15)
            notes.append(f"Mean reprojection error {r.sfm.mean_reprojection_error_px:.2f} px (aim for < 1 px).")
        if r.sfm.models_found > 1:
            score -= 15
            notes.append("The scene split into several models; shoot with more overlap and loops.")
        if not r.sfm.rig_constrained:
            notes.append("Rig constraints were not applied (older COLMAP); results may drift slightly.")
    else:
        return None, ["No SfM result yet."]
    if r.alignment:
        if r.alignment.method != "tags":
            score -= 15
            notes.append("No metric scale: no AprilTags were triangulated. Print and place tags for true-to-size output.")
        elif r.alignment.scale_residual_pct and r.alignment.scale_residual_pct > 2:
            score -= min(15, r.alignment.scale_residual_pct * 3)
            notes.append(f"Tag scale estimates disagree by {r.alignment.scale_residual_pct:.1f}%.")
    if r.tags and r.tags.unique_tags and r.tags.unique_tags < 6:
        notes.append(f"Only {r.tags.unique_tags} distinct tags seen; 8-16 spread around the scene is recommended.")
    if r.train:
        if r.train.backend == "mock":
            score -= 40
            notes.append("Point-cloud preview only: install Brush to train a real Gaussian splat.")
        if r.train.psnr is not None:
            if r.train.psnr < 24:
                score -= 10
                notes.append(f"Training PSNR {r.train.psnr:.1f} dB is low; more keyframes or a slower walk would help.")
    if r.keyframes.get("count") and r.keyframes["count"] < 100:
        notes.append("Fewer than 100 keyframes; consider a longer clip or a higher keyframe target.")
    return round(max(0.0, min(100.0, score)), 1), notes


ARTIFACT_KINDS = {
    "splat.ply": ("ply", StageName.export), "splat.splat": ("splat", StageName.export),
    "report.json": ("json", StageName.export), "report.html": ("report", StageName.export),
    "sparse_points.ply": ("ply", StageName.align), "tags.json": ("json", StageName.tags),
    "job.log": ("log", StageName.export),
}


def collect_artifacts(paths: ProjectPaths, project_id: str) -> list[Artifact]:
    out: list[Artifact] = []
    ex = paths.export
    if not ex.exists():
        # partial artifacts before export
        if (paths.align / "sparse_points.ply").exists():
            f = paths.align / "sparse_points.ply"
            out.append(Artifact(name="sparse_points.ply", kind="ply", path=str(f), size_bytes=f.stat().st_size,
                                url=f"/api/projects/{project_id}/artifacts/sparse_points.ply", stage=StageName.align,
                                created_at=datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)))
        return out
    for f in sorted(ex.iterdir()):
        if not f.is_file():
            continue
        kind, stage = ARTIFACT_KINDS.get(f.name, ("ply" if f.suffix == ".ply" else "other", StageName.export))
        out.append(Artifact(name=f.name, kind=kind, path=str(f), size_bytes=f.stat().st_size,
                            url=f"/api/projects/{project_id}/artifacts/{f.name}", stage=stage,
                            created_at=datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)))
    return out


def resolve_artifact(paths: ProjectPaths, name: str) -> Optional[Path]:
    if "/" in name or name.startswith("."):
        return None
    for base in (paths.export, paths.align):
        f = base / name
        if f.is_file():
            return f
    return None


def thumbnail_url(paths: ProjectPaths, project_id: str) -> Optional[str]:
    thumbs = paths.keyframes / "thumbs"
    if thumbs.exists():
        files = sorted(thumbs.glob("*.jpg"))
        if files:
            mid = files[len(files) // 2]
            return f"/api/projects/{project_id}/keyframes/{int(mid.stem)}.jpg"
    return None

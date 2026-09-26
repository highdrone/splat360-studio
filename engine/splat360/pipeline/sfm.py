"""Structure-from-motion over the pinhole views with COLMAP (or GLOMAP).

Steps
-----
1. ``feature_extractor`` with fixed, known PINHOLE intrinsics (one camera
   per face folder) and nadir masks.
2. Rig configuration (COLMAP >= 3.11: ``rig_configurator`` before matching).
3. ``matches_importer`` over an explicit pair list (temporal window,
   neighbouring faces, loop-closure anchors).
4. ``mapper`` (or ``glomap mapper``) with intrinsics locked.
5. COLMAP 3.9/3.10: ``rig_bundle_adjuster`` with the known face rotations.
6. Pick the largest model, write ``sparse/0`` in binary + text, report.
"""
from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path
from typing import Callable, Optional

from ..colmap import database as cdb
from ..colmap.model import Model, read_model, write_model_bin, write_model_txt, write_points_ply
from ..colmap.pairs import build_pairs
from ..colmap.runner import Colmap, Glomap
from ..models import SfmReport, SfmSettings
from ..util.proc import CancelToken, ToolError, cpu_count
from .reproject import ViewIndex

ProgressCb = Callable[[float, str], None]
_BRACKET = re.compile(r"\[(\d+)/(\d+)\]")
_REGISTER = re.compile(r"Registering image #(\d+) \((\d+)\)")


def _rig_config(view_index: ViewIndex, camera_ids: Optional[dict[str, int]], native: bool) -> list[dict]:
    faces = view_index.faces
    ref = "front" if "front" in faces else faces[0]
    cams = []
    for face in faces:
        entry: dict = {"image_prefix": f"{face}/"}
        if camera_ids is not None:
            entry["camera_id"] = camera_ids[f"{face}/"]
        if face == ref:
            if native:
                entry["ref_sensor"] = True
            else:
                entry["cam_from_rig_rotation"] = [1.0, 0.0, 0.0, 0.0]
                entry["cam_from_rig_translation"] = [0.0, 0.0, 0.0]
        else:
            entry["cam_from_rig_rotation"] = view_index.cam_from_rig_qvec[face]
            entry["cam_from_rig_translation"] = [0.0, 0.0, 0.0]
        cams.append(entry)
    rig: dict = {"cameras": cams}
    if camera_ids is not None:
        rig["ref_camera_id"] = camera_ids[f"{ref}/"]
    return [rig]


def _largest_model(sparse_dir: Path) -> Optional[Path]:
    best, best_n = None, -1
    for d in sorted(sparse_dir.iterdir()) if sparse_dir.exists() else []:
        if not d.is_dir():
            continue
        try:
            m = read_model(d, with_points=False)
        except Exception:
            continue
        if len(m.images) > best_n:
            best, best_n = d, len(m.images)
    return best


def run_sfm(
    views_dir: Path,
    view_index: ViewIndex,
    settings: SfmSettings,
    out_dir: Path,
    *,
    cancel: Optional[CancelToken] = None,
    on_progress: Optional[ProgressCb] = None,
    log: Optional[Callable[[str], None]] = None,
) -> tuple[SfmReport, Path]:
    """Run SfM. Returns the report and the path of the final ``sparse/0`` model directory."""
    log = log or (lambda s: None)
    t0 = time.time()
    colmap = Colmap()
    threads = settings.threads if settings.threads > 0 else cpu_count()
    use_gpu = bool(settings.use_gpu and colmap.has_cuda())
    log(f"COLMAP {colmap.version_str} at {colmap.exe}; native rigs={colmap.has_native_rigs}; "
        f"rig_bundle_adjuster={colmap.has_rig_bundle_adjuster}; gpu={use_gpu}; threads={threads}")

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    db = out_dir / "database.db"
    sparse = out_dir / "sparse"
    sparse.mkdir()
    warnings: list[str] = []

    names = [it["name"] for it in view_index.items]
    frames = sorted({it["frame_index"] for it in view_index.items})
    (out_dir / "image_list.txt").write_text("\n".join(names) + "\n")
    total = len(names)
    f, cx, cy = view_index.focal_px, view_index.cx, view_index.cy

    # 1. Features ---------------------------------------------------------
    def feat_line(line: str) -> None:
        m = _BRACKET.search(line)
        if m and on_progress:
            k, n = int(m.group(1)), int(m.group(2))
            on_progress(0.0 + 0.25 * k / max(1, n), f"Extracting features {k}/{n}")
        elif "Feature extraction" in line or "Processed" not in line:
            log(line)

    mask_path = views_dir / "masks" if view_index.masked_faces else None
    colmap.run(
        "feature_extractor",
        {
            "database_path": db,
            "image_path": views_dir,
            "image_list_path": out_dir / "image_list.txt",
            "ImageReader.camera_model": "PINHOLE",
            "ImageReader.camera_params": f"{f:.6f},{f:.6f},{cx:.3f},{cy:.3f}",
            "ImageReader.single_camera_per_folder": 1,
            "ImageReader.mask_path": mask_path,
            "SiftExtraction.max_num_features": settings.max_features,
            "SiftExtraction.use_gpu": use_gpu,
            "SiftExtraction.num_threads": threads,
            "SiftExtraction.estimate_affine_shape": 0,
            "SiftExtraction.domain_size_pooling": 0,
        },
        cancel=cancel, on_line=feat_line,
    )
    if cancel:
        cancel.check()
    camera_ids = cdb.folder_camera_ids(db)
    log(f"cameras per face: {camera_ids}")

    # 2. Rig config (native, before matching) --------------------------------
    rig_native = settings.use_rig and colmap.has_native_rigs
    rig_legacy = settings.use_rig and not rig_native and colmap.has_rig_bundle_adjuster
    if settings.use_rig and not (rig_native or rig_legacy):
        warnings.append("This COLMAP build has no rig support; views were reconstructed independently.")
    rig_cfg = out_dir / "rig_config.json"
    if rig_native:
        rig_cfg.write_text(json.dumps(_rig_config(view_index, None, native=True), indent=1))
        colmap.run("rig_configurator", {"database_path": db, "rig_config_path": rig_cfg},
                   cancel=cancel, on_line=log)
    elif rig_legacy:
        rig_cfg.write_text(json.dumps(_rig_config(view_index, camera_ids, native=False), indent=1))

    # 3. Matching -----------------------------------------------------------
    pairs = build_pairs(frames, view_index.faces, view_index.layout, settings.window, settings.loop_stride,
                        view_index.image_format)
    pairs_file = out_dir / "pairs.txt"
    pairs_file.write_text("\n".join(f"{a} {b}" for a, b in pairs) + "\n")
    log(f"matching {len(pairs)} image pairs (window={settings.window}, loop_stride={settings.loop_stride})")

    gpu_opt = colmap.pick("matches_importer", ["SiftMatching.use_gpu", "FeatureMatching.use_gpu"])
    thr_opt = colmap.pick("matches_importer", ["SiftMatching.num_threads", "FeatureMatching.num_threads"])
    guided_opt = colmap.pick("matches_importer", ["SiftMatching.guided_matching", "TwoViewGeometry.guided_matching",
                                                  "FeatureMatching.guided_matching"])
    match_args: dict[str, object] = {"database_path": db, "match_list_path": pairs_file, "match_type": "pairs"}
    if gpu_opt:
        match_args[gpu_opt] = use_gpu
    if thr_opt:
        match_args[thr_opt] = threads
    if guided_opt:
        match_args[guided_opt] = settings.guided_matching

    def match_line(line: str) -> None:
        m = _BRACKET.search(line)
        if m and on_progress:
            k, n = int(m.group(1)), int(m.group(2))
            on_progress(0.25 + 0.30 * k / max(1, n), f"Matching pairs {k}/{n}")
        elif "in " in line and "s" in line[-3:]:
            pass
        else:
            log(line)

    colmap.run("matches_importer", match_args, cancel=cancel, on_line=match_line)
    if cancel:
        cancel.check()
    dbc = cdb.counts(db)
    log(f"database: {dbc}")
    if dbc["verified_pairs"] < max(10, len(pairs) // 20):
        warnings.append(f"Only {dbc['verified_pairs']} of {len(pairs)} pairs verified; footage may lack texture or overlap.")

    # 4. Mapping ------------------------------------------------------------
    registered_seen = {"n": 0}

    def map_line(line: str) -> None:
        m = _REGISTER.search(line)
        if m:
            registered_seen["n"] = int(m.group(2))
            if on_progress:
                on_progress(0.55 + 0.35 * min(1.0, registered_seen["n"] / max(1, total)),
                            f"Registering images {registered_seen['n']}/{total}")
        elif line.startswith("$") or "Elapsed" in line or "Retriangulation" in line or "Bundle adjustment" in line \
                or "model" in line.lower() or "error" in line.lower():
            log(line)

    if settings.engine == "glomap":
        Glomap().mapper(db, views_dir, sparse, threads=threads, cancel=cancel, on_line=map_line)
    else:
        mapper_args: dict[str, object] = {
            "database_path": db, "image_path": views_dir, "output_path": sparse,
            "Mapper.ba_refine_focal_length": 0,
            "Mapper.ba_refine_principal_point": 0,
            "Mapper.ba_refine_extra_params": 0,
            "Mapper.num_threads": threads,
            "Mapper.ba_global_function_tolerance": 1e-6,
            "Mapper.min_num_matches": 15,
            "Mapper.multiple_models": 1,
            "Mapper.extract_colors": 1,
        }
        if rig_native:
            mapper_args["Mapper.ba_refine_sensor_from_rig"] = 0
        colmap.run("mapper", mapper_args, cancel=cancel, on_line=map_line)
    if cancel:
        cancel.check()

    best = _largest_model(sparse)
    if best is None:
        raise ToolError("COLMAP produced no reconstruction. The footage may be too blurry, too dark or lack "
                        "texture; try more keyframes, a wider match window, or add more AprilTags.")
    n_models = sum(1 for d in sparse.iterdir() if d.is_dir())
    if n_models > 1:
        warnings.append(f"COLMAP split the scene into {n_models} models; the largest was kept. "
                        f"Shoot with more overlap or loops to connect the scene.")

    # 5. Legacy rig BA ------------------------------------------------------
    final_dir = best
    if rig_legacy:
        rig_out = out_dir / "sparse_rig" / "0"
        rig_out.mkdir(parents=True)
        ba_args: dict[str, object] = {
            "input_path": best, "output_path": rig_out, "rig_config_path": rig_cfg,
            "estimate_rig_relative_poses": 0,
            "RigBundleAdjustment.refine_relative_poses": 0,
            "BundleAdjustment.refine_focal_length": 0,
            "BundleAdjustment.refine_principal_point": 0,
            "BundleAdjustment.refine_extra_params": 0,
        }
        try:
            colmap.run("rig_bundle_adjuster", ba_args, cancel=cancel, on_line=log)
            final_dir = rig_out
        except ToolError as e:
            warnings.append(f"Rig bundle adjustment failed; using the unconstrained model. ({str(e).splitlines()[0]})")
            log(str(e))
    if on_progress:
        on_progress(0.92, "Analysing reconstruction")

    # 6. Finalise -----------------------------------------------------------
    model = read_model(final_dir)
    out_model = out_dir / "sparse_final" / "0"
    write_model_bin(model, out_model)
    write_model_txt(model, out_dir / "sparse_final" / "txt")
    write_points_ply(model.points.values(), out_dir / "sparse_points.ply")

    reg_names = {im.name for im in model.images.values()}
    reg_frames = {it["frame_index"] for it in view_index.items if it["name"] in reg_names}
    st = model.stats()
    report = SfmReport(
        engine=settings.engine,
        colmap_version=colmap.version_str,
        images_total=total,
        images_registered=len(reg_names),
        registered_fraction=len(reg_names) / max(1, total),
        frames_total=len(frames),
        frames_registered=len(reg_frames),
        points3d=len(model.points),
        mean_reprojection_error_px=st["mean_reprojection_error_px"],
        mean_track_length=st["mean_track_length"],
        rig_constrained=bool(rig_native or (rig_legacy and final_dir != best)),
        models_found=n_models,
        warnings=warnings,
    )
    (out_dir / "report.json").write_text(report.model_dump_json(indent=1))
    log(f"SfM done in {time.time() - t0:.0f}s: {report.images_registered}/{total} views, "
        f"{report.frames_registered}/{len(frames)} keyframes, {report.points3d} points, "
        f"reproj {report.mean_reprojection_error_px}")
    if report.registered_fraction < settings.min_registered_fraction:
        raise ToolError(
            f"Only {report.images_registered}/{total} views ({report.registered_fraction * 100:.0f}%) registered, "
            f"below the {settings.min_registered_fraction * 100:.0f}% threshold. Check the footage for motion blur, "
            f"low light or featureless walls, and add more AprilTags. Lower 'min_registered_fraction' to proceed anyway."
        )
    return report, out_model

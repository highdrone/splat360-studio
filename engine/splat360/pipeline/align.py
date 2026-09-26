"""Metric scale and gravity alignment of the sparse model.

AprilTag corners are triangulated from the registered views (linear DLT
over all observations, then a reprojection-error based outlier pass). The
distance between adjacent corners must equal the printed tag size, which
gives the metric scale; floor tags additionally give the ground plane.

Output convention (matches COLMAP / OpenCV): +Y is down (gravity), the
floor is at y = 0 when floor tags were found (otherwise the camera-height
prior is unknown and the mean camera position is at y = 0), the trajectory
centroid is at x = z = 0 and the first camera looks roughly along +Z.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from ..colmap.model import Model, apply_similarity, read_model, write_model_bin, write_model_txt, write_points_ply
from ..models import AlignmentReport, TagObservation, TagSettings
from . import geometry as G
from .reproject import ViewIndex

MIN_VIEWS_PER_CORNER = 3
MAX_REPROJ_PX = 4.0


def _projection_matrices(model: Model) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """image name -> (P 3x4, K, cam_from_world 4x4)."""
    out = {}
    for im in model.images.values():
        K = model.cameras[im.camera_id].K
        T = im.cam_from_world()
        out[im.name] = (K @ T[:3, :], K, T)
    return out


def _triangulate(Ps: list[np.ndarray], xs: list[np.ndarray]) -> np.ndarray:
    A = []
    for P, x in zip(Ps, xs):
        A.append(x[0] * P[2] - P[0])
        A.append(x[1] * P[2] - P[1])
    A = np.array(A)
    _, _, vt = np.linalg.svd(A)
    X = vt[-1]
    return X[:3] / X[3]


def _reproj_err(P: np.ndarray, X: np.ndarray, x: np.ndarray) -> float:
    p = P @ np.append(X, 1.0)
    if abs(p[2]) < 1e-12 or p[2] < 0:
        return float("inf")
    return float(np.linalg.norm(p[:2] / p[2] - x))


def triangulate_tags(
    model: Model, observations: list[TagObservation], log: Callable[[str], None]
) -> dict[int, dict]:
    """Return {tag_id: {"corners": 4x3, "views": n, "rms_px": float}} for well-observed tags."""
    Pm = _projection_matrices(model)
    by_tag: dict[int, list[TagObservation]] = defaultdict(list)
    for o in observations:
        if o.view in Pm:
            by_tag[o.tag_id].append(o)
    result: dict[int, dict] = {}
    for tid, obs in sorted(by_tag.items()):
        if len(obs) < MIN_VIEWS_PER_CORNER:
            continue
        corners = []
        errs = []
        ok = True
        for c in range(4):
            Ps = [Pm[o.view][0] for o in obs]
            # COLMAP uses pixel-centre-at-(i+0.5); detector reports centre-at-i.
            xs = [np.array(o.corners[c]) + 0.5 for o in obs]
            X = _triangulate(Ps, xs)
            e = np.array([_reproj_err(P, X, x) for P, x in zip(Ps, xs)])
            keep = e < MAX_REPROJ_PX
            if keep.sum() >= MIN_VIEWS_PER_CORNER and keep.sum() < len(obs):
                X = _triangulate([P for P, k in zip(Ps, keep) if k], [x for x, k in zip(xs, keep) if k])
                e = np.array([_reproj_err(P, X, x) for P, x in zip(Ps, xs)])
                keep = e < MAX_REPROJ_PX
            if keep.sum() < MIN_VIEWS_PER_CORNER:
                ok = False
                break
            corners.append(X)
            errs.append(float(np.sqrt(np.mean(e[keep] ** 2))))
        if not ok:
            log(f"tag {tid}: dropped (inconsistent observations over {len(obs)} views)")
            continue
        result[tid] = {"corners": np.array(corners), "views": len(obs), "rms_px": float(np.mean(errs))}
    return result


def _rotation_from_to(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        if c > 0:
            return np.eye(3)
        # 180 degrees: rotate about any axis orthogonal to a
        axis = np.cross(a, [1, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def align_model(
    model_dir: Path,
    view_index: ViewIndex,
    observations: list[TagObservation],
    tag_settings: TagSettings,
    out_dir: Path,
    *,
    log: Optional[Callable[[str], None]] = None,
) -> tuple[AlignmentReport, Path]:
    """Scale, level and centre the model. Writes ``out_dir/sparse/0`` (bin), ``txt`` and a PLY."""
    log = log or (lambda s: None)
    model = read_model(model_dir)
    notes: list[str] = []
    report = AlignmentReport(method="none")

    # --- camera-derived up vector (the 360 camera is held roughly level) ------
    front = "front" if "front" in view_index.faces else view_index.faces[0]
    ups, centers, forwards = [], [], []
    for im in model.images.values():
        face = im.name.split("/")[0]
        # rig_from_world = rig_from_cam @ cam_from_world
        spec = next(s for s in G.LAYOUTS[view_index.layout] if s.name == face)
        R_rw = G.rig_from_cam(spec) @ im.R
        ups.append(R_rw.T @ np.array([0, -1.0, 0]))       # rig "up" in world
        if face == front:
            forwards.append(R_rw.T @ np.array([0, 0, 1.0]))
            centers.append(im.center)
    if not centers:
        centers = [im.center for im in model.images.values()]
    cam_up = np.mean(ups, axis=0)
    cam_up /= np.linalg.norm(cam_up)
    centers = np.array(centers)

    # --- tags: scale and floor plane -----------------------------------------
    scale = None
    tag_up = None
    floor_y = None
    tri = triangulate_tags(model, observations, log) if tag_settings.enabled and observations else {}
    if tri:
        size_m = tag_settings.size_mm / 1000.0
        per_tag_scale = {}
        normals = {}
        for tid, d in tri.items():
            C = d["corners"]
            edges = [np.linalg.norm(C[(i + 1) % 4] - C[i]) for i in range(4)]
            diag_ratio = np.linalg.norm(C[2] - C[0]) / max(1e-9, np.linalg.norm(C[3] - C[1]))
            if max(edges) / max(1e-9, min(edges)) > 1.15 or not 0.85 < diag_ratio < 1.15:
                log(f"tag {tid}: skewed triangulation, skipped (edges {np.round(edges, 4).tolist()})")
                continue
            per_tag_scale[tid] = size_m / float(np.mean(edges))
            n = np.cross(C[1] - C[0], C[3] - C[0])
            n /= np.linalg.norm(n)
            # orient the normal towards the cameras
            if np.dot(n, centers.mean(axis=0) - C.mean(axis=0)) < 0:
                n = -n
            normals[tid] = (n, C.mean(axis=0))
        if per_tag_scale:
            vals = np.array(list(per_tag_scale.values()))
            scale = float(np.median(vals))
            resid = float(np.median(np.abs(vals - scale)) / scale * 100)
            report = AlignmentReport(
                method="tags", scale_factor=scale, scale_residual_pct=resid, tags_used=len(per_tag_scale),
                tag_edge_rmse_mm=float(np.sqrt(np.mean(((vals / scale - 1) * tag_settings.size_mm) ** 2))),
            )
            log(f"metric scale from {len(per_tag_scale)} tags: x{scale:.5f} (spread {resid:.2f}%)")
            if resid > 3:
                notes.append(f"Tag scale estimates disagree by {resid:.1f}%; check that all tags were printed at "
                             f"{tag_settings.size_mm:.0f} mm and mounted flat.")
            # floor tags: normal parallel to camera up
            if tag_settings.placement in ("floor", "mixed"):
                floor = [(n, c) for n, c in normals.values() if np.dot(n, cam_up) > math.cos(math.radians(25))]
                if floor:
                    tag_up = np.mean([n for n, _ in floor], axis=0)
                    tag_up /= np.linalg.norm(tag_up)
                    report.ground_plane_from_tags = True
                    floor_pts = np.array([c for _, c in floor])
                    floor_y = floor_pts  # resolved after rotation
                    log(f"ground plane from {len(floor)} floor tags; angle to camera-up "
                        f"{math.degrees(math.acos(min(1, float(np.dot(tag_up, cam_up))))):.1f} deg")
                elif tag_settings.placement == "floor":
                    notes.append("No floor tags matched the expected orientation; scene levelled from camera poses.")
        else:
            notes.append("Tags were detected but none triangulated cleanly; scale is unknown (1 unit = 1 SfM unit).")
    elif tag_settings.enabled:
        notes.append("No usable tag observations in registered views; scale is unknown and the scene was levelled "
                     "from camera poses only.")
    if report.method == "none":
        report.method = "camera_up"

    up = tag_up if tag_up is not None else cam_up
    s = scale if scale is not None else 1.0

    # Rotation: world up -> (0,-1,0); then yaw so that the first camera's forward faces +Z.
    R1 = _rotation_from_to(up, np.array([0, -1.0, 0]))
    fwd = R1 @ (np.mean(forwards, axis=0) if forwards else np.array([0, 0, 1.0]))
    fwd[1] = 0
    if np.linalg.norm(fwd) > 1e-6:
        fwd /= np.linalg.norm(fwd)
        yaw = math.atan2(fwd[0], fwd[2])
        R2 = G.rot_y(-math.degrees(yaw))
    else:
        R2 = np.eye(3)
    R = R2 @ R1
    # Translation: centre trajectory at x=z=0; floor (or camera mean) at y=0.
    c_rot = (s * (R @ centers.T)).T
    t = -c_rot.mean(axis=0)
    if floor_y is not None:
        fy = (s * (R @ np.asarray(floor_y).T)).T[:, 1]
        t[1] = -float(np.median(fy))
        cam_height = float(np.mean(c_rot[:, 1] + t[1]))
        log(f"camera height above floor: {-cam_height:.2f} m")
        report.notes.append(f"Estimated camera height above floor tags: {-cam_height:.2f} m")

    aligned = apply_similarity(model, s, R, t)
    T = np.eye(4)
    T[:3, :3] = s * R
    T[:3, 3] = t
    report.transform = T.tolist()
    report.notes.extend(notes)

    out_model = out_dir / "sparse" / "0"
    if out_dir.exists():
        import shutil
        shutil.rmtree(out_dir)
    write_model_bin(aligned, out_model)
    write_model_txt(aligned, out_dir / "sparse" / "txt")
    write_points_ply(aligned.points.values(), out_dir / "sparse_points.ply")
    # Camera trajectory for the viewer.
    frames = []
    for im in sorted(aligned.images.values(), key=lambda i: i.name):
        face = im.name.split("/")[0]
        if face != front:
            continue
        spec = next(sp for sp in G.LAYOUTS[view_index.layout] if sp.name == face)
        R_rw = G.rig_from_cam(spec) @ im.R
        frames.append({"index": int(Path(im.name).stem), "position": im.center.tolist(),
                       "quaternion": G.quat_wxyz_from_matrix(R_rw.T).tolist()})
    pts = list(aligned.points.values())
    step = max(1, len(pts) // 20000)
    sample = [[*map(float, p.xyz), *map(int, p.rgb)] for p in pts[::step]]
    (out_dir / "cameras.json").write_text(json.dumps({"frames": frames, "points_sample": sample}))
    (out_dir / "report.json").write_text(report.model_dump_json(indent=1))
    if tri:
        (out_dir / "tags3d.json").write_text(json.dumps(
            {str(k): {"corners": (s * (R @ v["corners"].T)).T.__add__(t).tolist(), "views": v["views"],
                      "rms_px": v["rms_px"]} for k, v in tri.items()}, indent=1))
    return report, out_model

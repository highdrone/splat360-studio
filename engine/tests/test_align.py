"""Alignment recovers metric scale, floor plane and levelling from synthetic tag observations."""
import json
import math

import numpy as np

from splat360.colmap.model import Camera, Image, Model, Point3D, read_model, write_model_bin
from splat360.models import TagObservation, TagSettings
from splat360.pipeline import geometry as G
from splat360.pipeline.align import align_model
from splat360.pipeline.reproject import ViewIndex


def _build(tmp_path, scale=0.37, tilt_deg=8.0):
    """A rig loop in a 'model' frame that is a scaled + tilted version of the metric world."""
    size, fov = 800, 100.0
    f = G.focal_px(size, fov)
    faces = [s.name for s in G.CUBE6]
    # metric world: floor at y=+1.6, camera loop radius 1.5 m at y=0
    tag_size = 0.3
    tags_world = {}
    rng = np.random.default_rng(0)
    for tid in range(6):  # wall tags at z=+2.5 plane and x=+3 plane
        if tid < 3:
            c = np.array([-1.5 + 1.5 * tid, 0.2, 2.5])
            u, v = np.array([1, 0, 0.0]), np.array([0, 1, 0.0])
        else:
            c = np.array([3.0, 0.0, -1.5 + 1.5 * (tid - 3)])
            u, v = np.array([0, 0, -1.0]), np.array([0, 1, 0.0])
        h = tag_size / 2
        tags_world[tid] = np.array([c - u * h + v * h, c + u * h + v * h, c + u * h - v * h, c - u * h - v * h])
    for tid in range(6, 9):  # floor tags
        c = np.array([-1.0 + tid - 6, 1.6, 0.3 * (tid - 7)])
        u, v = np.array([1, 0, 0.0]), np.array([0, 0, 1.0])
        h = tag_size / 2
        tags_world[tid] = np.array([c - u * h + v * h, c + u * h + v * h, c + u * h - v * h, c - u * h - v * h])
    # model frame = s * R_tilt * world + t
    R_tilt = G.rot_x(tilt_deg) @ G.rot_y(40)
    t_off = np.array([2.0, -1.0, 0.5])

    def to_model(X):
        X = np.asarray(X)
        return scale * (X @ R_tilt.T) + t_off

    cams = {i + 1: Camera(i + 1, "PINHOLE", size, size, [f, f, size / 2, size / 2]) for i in range(6)}
    images, obs, items = {}, [], []
    iid = 1
    for k in range(24):
        a = 2 * math.pi * k / 24
        pos_w = np.array([1.5 * math.cos(a), 0.0, 1.5 * math.sin(a)])
        rig_from_world_w = G.rot_y(math.degrees(a) + 90).T   # yaw only, level camera
        for ci, spec in enumerate(G.CUBE6):
            cam_from_rig = G.cam_from_rig(spec)
            # cam_from_model: x_c = cam_from_rig @ rig_from_world_w @ (X_w - pos_w) ; X_w = R_tilt^T (X_m - t)/s
            R_rigid = cam_from_rig @ rig_from_world_w @ R_tilt.T
            t_rigid = -R_rigid @ to_model(pos_w)
            name = f"{spec.name}/{k:05d}.jpg"
            images[iid] = Image(iid, G.quat_wxyz_from_matrix(R_rigid), t_rigid, ci + 1, name)
            items.append({"name": name, "face": spec.name, "frame_index": k})
            # observations
            for tid, C in tags_world.items():
                pc = (R_rigid @ to_model(C).T).T + t_rigid
                if (pc[:, 2] <= 0.05).any():
                    continue
                px = np.stack([f * pc[:, 0] / pc[:, 2] + size / 2 - 0.5, f * pc[:, 1] / pc[:, 2] + size / 2 - 0.5], 1)
                if (px < 0).any() or (px >= size).any():
                    continue
                px = px + rng.normal(0, 0.3, px.shape)
                obs.append(TagObservation(tag_id=tid, view=name, frame_index=k, face=spec.name,
                                          corners=px.tolist(), center=px.mean(0).tolist(), decision_margin=80, hamming=0))
            iid += 1
    pts = {1: Point3D(1, to_model(np.array([0.0, 1.6, 0.0])), np.array([1, 2, 3], dtype=np.uint8), 0.1, [])}
    model = Model(cams, images, pts)
    write_model_bin(model, tmp_path / "model")
    vi = ViewIndex(layout="cube6", fov_deg=fov, size=size, focal_px=f, cx=size / 2, cy=size / 2, faces=faces,
                   cam_from_rig_qvec={s.name: G.quat_wxyz_from_matrix(G.cam_from_rig(s)).tolist() for s in G.CUBE6},
                   masked_faces=[], keyframes=24, image_format="jpg", equirect_width=2048, equirect_height=1024,
                   items=items, stats={})
    return vi, obs, scale


def test_align_recovers_scale_floor_and_level(tmp_path):
    vi, obs, scale = _build(tmp_path)
    assert len(obs) > 100
    rep, out = align_model(tmp_path / "model", vi, obs, TagSettings(size_mm=300, placement="mixed"), tmp_path / "out",
                           log=print)
    assert rep.method == "tags"
    assert rep.tags_used >= 6
    assert abs(rep.scale_factor * scale - 1.0) < 0.01, rep.scale_factor
    assert rep.ground_plane_from_tags
    aligned = read_model(out)
    centres = np.array([im.center for im in aligned.images.values() if im.name.startswith("front/")])
    # cameras 1.6 m above floor (y=0, +Y down), loop radius 1.5 m, centred
    assert abs(centres[:, 1].mean() + 1.6) < 0.02
    assert abs(np.linalg.norm(centres[:, [0, 2]], axis=1).mean() - 1.5) < 0.02
    assert np.abs(centres[:, [0, 2]].mean(axis=0)).max() < 0.02
    cams = json.loads((tmp_path / "out" / "cameras.json").read_text())
    assert len(cams["frames"]) == 24


def test_align_without_tags_levels_from_cameras(tmp_path):
    vi, obs, scale = _build(tmp_path, tilt_deg=6)
    rep, out = align_model(tmp_path / "model", vi, [], TagSettings(size_mm=300), tmp_path / "out")
    assert rep.method == "camera_up"
    aligned = read_model(out)
    ups = []
    for im in aligned.images.values():
        spec = next(s for s in G.CUBE6 if s.name == im.name.split("/")[0])
        R_rw = G.rig_from_cam(spec) @ im.R
        ups.append(R_rw.T @ np.array([0, -1.0, 0]))
    mean_up = np.mean(ups, axis=0)
    assert np.allclose(mean_up / np.linalg.norm(mean_up), [0, -1, 0], atol=1e-3)

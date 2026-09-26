"""Coordinate conventions shared by reprojection, SfM rig setup and alignment.

Rig frame
    Right-handed, COLMAP camera style: +X right, +Y down, +Z forward, where
    "forward" is the centre column of the equirectangular image. It is the
    frame of the 360° camera at the moment a keyframe was captured.

Equirectangular image
    Column ``u`` maps to longitude ``lon = (u / W - 0.5) * 2π`` (positive to
    the right of forward) and row ``v`` maps to latitude
    ``lat = (0.5 - v / H) * π`` (positive up). Pixel centres are at integer
    coordinates for OpenCV ``remap`` and at ``i + 0.5`` for COLMAP.

Pinhole view
    A square image of ``size`` px with focal ``f = (size / 2) / tan(fov / 2)``
    and principal point ``(size / 2, size / 2)`` in COLMAP's continuous pixel
    convention. Each view has a rotation ``cam_from_rig`` and zero
    translation (all views share the camera centre).

Yaw and pitch
    ``rig_from_cam = R_y(yaw) @ R_x(pitch)``. Yaw is positive turning right,
    pitch positive looking up. Front is yaw 0 / pitch 0.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ViewSpec:
    name: str
    yaw_deg: float
    pitch_deg: float


CUBE6: tuple[ViewSpec, ...] = (
    ViewSpec("front", 0, 0),
    ViewSpec("right", 90, 0),
    ViewSpec("back", 180, 0),
    ViewSpec("left", 270, 0),
    ViewSpec("up", 0, 90),
    ViewSpec("down", 0, -90),
)

RING8: tuple[ViewSpec, ...] = tuple(
    [ViewSpec(f"yaw{int(a):03d}", a, 0) for a in range(0, 360, 45)]
    + [ViewSpec("up", 0, 90), ViewSpec("down", 0, -90)]
)

LAYOUTS: dict[str, tuple[ViewSpec, ...]] = {"cube6": CUBE6, "ring8": RING8}

# Neighbouring faces that share field of view (used to build match pairs).
_CUBE_NEIGHBOURS = {
    "front": ["right", "left", "up", "down"],
    "right": ["front", "back", "up", "down"],
    "back": ["right", "left", "up", "down"],
    "left": ["front", "back", "up", "down"],
    "up": ["front", "right", "back", "left"],
    "down": ["front", "right", "back", "left"],
}


def neighbours(layout: str) -> dict[str, list[str]]:
    if layout == "cube6":
        return {k: list(v) for k, v in _CUBE_NEIGHBOURS.items()}
    names = [v.name for v in RING8 if v.name not in ("up", "down")]
    out: dict[str, list[str]] = {}
    n = len(names)
    for i, nm in enumerate(names):
        out[nm] = [names[(i - 1) % n], names[(i + 1) % n], "up", "down"]
    out["up"] = list(names)
    out["down"] = list(names)
    return out


def rot_x(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def rot_y(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def rig_from_cam(view: ViewSpec) -> np.ndarray:
    return rot_y(view.yaw_deg) @ rot_x(view.pitch_deg)


def cam_from_rig(view: ViewSpec) -> np.ndarray:
    return rig_from_cam(view).T


def focal_px(size: int, fov_deg: float) -> float:
    return (size / 2.0) / math.tan(math.radians(fov_deg) / 2.0)


def dirs_to_equirect(d: np.ndarray, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Rig-frame unit directions (..., 3) -> equirect pixel coords (OpenCV centre convention)."""
    lon = np.arctan2(d[..., 0], d[..., 2])
    lat = np.arcsin(np.clip(-d[..., 1], -1.0, 1.0))
    u = (lon / (2 * math.pi) + 0.5) * width - 0.5
    v = (0.5 - lat / math.pi) * height - 0.5
    return u, v


def equirect_to_dirs(u: np.ndarray, v: np.ndarray, width: int, height: int) -> np.ndarray:
    lon = ((u + 0.5) / width - 0.5) * 2 * math.pi
    lat = (0.5 - (v + 0.5) / height) * math.pi
    cl = np.cos(lat)
    return np.stack([cl * np.sin(lon), -np.sin(lat), cl * np.cos(lon)], axis=-1)


def view_rays(size: int, fov_deg: float) -> np.ndarray:
    """Unit rays in the view camera frame for every pixel centre, shape (size, size, 3)."""
    f = focal_px(size, fov_deg)
    xs = (np.arange(size, dtype=np.float64) + 0.5 - size / 2.0) / f
    X, Y = np.meshgrid(xs, xs)
    rays = np.stack([X, Y, np.ones_like(X)], axis=-1)
    return rays / np.linalg.norm(rays, axis=-1, keepdims=True)


def view_remap(view: ViewSpec, size: int, fov_deg: float, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """OpenCV remap tables (map_x, map_y as float32) from a pinhole view into the equirect image."""
    rays = view_rays(size, fov_deg)
    d = rays @ rig_from_cam(view).T  # (rig_from_cam @ ray) for every pixel
    u, v = dirs_to_equirect(d, width, height)
    return u.astype(np.float32), v.astype(np.float32)


def nadir_mask(view: ViewSpec, size: int, fov_deg: float, radius_deg: float) -> np.ndarray | None:
    """uint8 mask (255 keep, 0 ignore) for pixels within ``radius_deg`` of straight down; None if empty."""
    rays = view_rays(size, fov_deg)
    d = rays @ rig_from_cam(view).T
    down = d[..., 1]  # +Y is down; cos(angle from nadir)
    masked = down > math.cos(math.radians(radius_deg))
    if not masked.any():
        return None
    m = np.full((size, size), 255, dtype=np.uint8)
    m[masked] = 0
    return m


def quat_wxyz_from_matrix(R: np.ndarray) -> np.ndarray:
    """Rotation matrix -> unit quaternion (w, x, y, z), COLMAP order."""
    m = np.asarray(R, dtype=np.float64)
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([w, x, y, z])
    q /= np.linalg.norm(q)
    if q[0] < 0:
        q = -q
    return q


def matrix_from_quat_wxyz(q: np.ndarray) -> np.ndarray:
    w, x, y, z = np.asarray(q, dtype=np.float64) / np.linalg.norm(q)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )

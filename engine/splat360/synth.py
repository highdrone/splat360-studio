"""Synthetic equirectangular footage of a tagged room.

Used by the "Try a synthetic demo" button and by the end-to-end tests. A
textured box room with AprilTags on the walls and floor is rendered from a
360° camera moving along a loop, and encoded with ffmpeg. Ground-truth
camera poses and tag poses are written next to the video so the pipeline
output can be checked against them (metric scale, levelling, trajectory).

Conventions follow ``pipeline.geometry``: world +X right, +Y down, +Z
forward; the floor is at ``y = +camera_height``.
"""
from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np

from .pipeline import geometry as G
from .tags.families import get_family
from .util.proc import ToolError, find_tool


@dataclass
class TagPlacement:
    tag_id: int
    face: str
    center_world: list[float]
    size_m: float
    normal: list[float]
    corners_world: list[list[float]] = field(default_factory=list)


@dataclass
class RoomSpec:
    width_m: float = 6.0     # x extent
    depth_m: float = 5.0     # z extent
    height_m: float = 2.8    # y extent
    camera_height_m: float = 1.6
    tag_size_m: float = 0.30
    family: str = "tag36h11"
    n_wall_tags: int = 10
    n_floor_tags: int = 3
    texture_px_per_m: int = 300
    seed: int = 0


def _procedural_texture(rng: np.random.Generator, w: int, h: int, base_hue: float) -> np.ndarray:
    """Richly textured wall: coloured noise, blobs and rectangles (good for SIFT)."""
    img = np.zeros((h, w, 3), dtype=np.float32)
    # Multi-octave noise
    for octave, amp in ((8, 0.35), (32, 0.25), (128, 0.2), (512, 0.2)):
        small = rng.random((max(2, h // octave), max(2, w // octave), 3)).astype(np.float32)
        img += amp * cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    img = np.clip(img, 0, 1)
    # Tint
    hsv = np.zeros_like(img)
    hsv[..., 0] = (base_hue + 20 * (img[..., 0] - 0.5)) % 180
    hsv[..., 1] = 0.25 + 0.5 * img[..., 1]
    hsv[..., 2] = 0.35 + 0.6 * img[..., 2]
    bgr = cv2.cvtColor((hsv * np.array([1, 255, 255], dtype=np.float32)).astype(np.uint8), cv2.COLOR_HSV2BGR)
    # Posters / rectangles with strong edges
    for _ in range(int(w * h / 60000)):
        x0, y0 = rng.integers(0, w - 40), rng.integers(0, h - 40)
        x1, y1 = x0 + rng.integers(30, min(400, w - x0)), y0 + rng.integers(30, min(400, h - y0))
        colour = tuple(int(c) for c in rng.integers(0, 255, 3))
        cv2.rectangle(bgr, (int(x0), int(y0)), (int(x1), int(y1)), colour, thickness=-1)
        cv2.rectangle(bgr, (int(x0), int(y0)), (int(x1), int(y1)), (255, 255, 255), thickness=3)
    # Speckle for fine detail
    speck = rng.random((h, w)) < 0.01
    bgr[speck] = rng.integers(0, 255, (int(speck.sum()), 3))
    return bgr


class Room:
    """Box room renderer. Faces are addressed by name: floor, ceiling, wall_front (z+), wall_back (z-),
    wall_right (x+), wall_left (x-)."""

    def __init__(self, spec: RoomSpec):
        self.spec = spec
        rng = np.random.default_rng(spec.seed)
        self.rng = rng
        hw, hd = spec.width_m / 2, spec.depth_m / 2
        y_floor = spec.camera_height_m
        y_ceil = spec.camera_height_m - spec.height_m
        ppm = spec.texture_px_per_m
        # Each face: plane point p0, normal n (pointing into the room), axes (u, v) with extents, texture.
        # Texture coordinate = ((x - p0)·u / len_u, (x - p0)·v / len_v).
        self.faces: dict[str, dict] = {
            # Texture axes are chosen so that u x v points away from the viewer (into the surface);
            # otherwise tags would appear mirrored and could not be decoded.
            "floor": dict(p0=np.array([-hw, y_floor, hd]), n=np.array([0, -1.0, 0]),
                          u=np.array([1.0, 0, 0]), v=np.array([0, 0, -1.0]), lu=spec.width_m, lv=spec.depth_m, hue=20),
            "ceiling": dict(p0=np.array([-hw, y_ceil, -hd]), n=np.array([0, 1.0, 0]),
                            u=np.array([1.0, 0, 0]), v=np.array([0, 0, 1.0]), lu=spec.width_m, lv=spec.depth_m, hue=100),
            "wall_front": dict(p0=np.array([-hw, y_ceil, hd]), n=np.array([0, 0, -1.0]),
                               u=np.array([1.0, 0, 0]), v=np.array([0, 1.0, 0]), lu=spec.width_m, lv=spec.height_m, hue=60),
            "wall_back": dict(p0=np.array([hw, y_ceil, -hd]), n=np.array([0, 0, 1.0]),
                              u=np.array([-1.0, 0, 0]), v=np.array([0, 1.0, 0]), lu=spec.width_m, lv=spec.height_m, hue=140),
            "wall_right": dict(p0=np.array([hw, y_ceil, hd]), n=np.array([-1.0, 0, 0]),
                               u=np.array([0, 0, -1.0]), v=np.array([0, 1.0, 0]), lu=spec.depth_m, lv=spec.height_m, hue=0),
            "wall_left": dict(p0=np.array([-hw, y_ceil, -hd]), n=np.array([1.0, 0, 0]),
                              u=np.array([0, 0, 1.0]), v=np.array([0, 1.0, 0]), lu=spec.depth_m, lv=spec.height_m, hue=110),
        }
        for name, f in self.faces.items():
            w, h = int(f["lu"] * ppm), int(f["lv"] * ppm)
            f["tex"] = _procedural_texture(rng, w, h, f["hue"])
            f["tw"], f["th"] = w, h
        self.tags: list[TagPlacement] = []
        self._place_tags()

    # ------------------------------------------------------------------
    def _paste_tag(self, face: str, tag_id: int, cu: float, cv_: float) -> TagPlacement:
        """Paste a tag centred at texture coords (cu, cv_) in metres along the face axes."""
        spec = self.spec
        fam = get_family(spec.family)
        f = self.faces[face]
        ppm = spec.texture_px_per_m
        cell_m = spec.tag_size_m / fam.width_at_border
        outer_cells = fam.total_width + 2  # one extra white quiet cell
        outer_px = int(round(outer_cells * cell_m * ppm))
        img = fam.image(tag_id, px_per_cell=max(1, outer_px // outer_cells), quiet_cells=1)
        img = cv2.resize(img, (outer_px, outer_px), interpolation=cv2.INTER_NEAREST)
        x0 = int(round(cu * ppm - outer_px / 2))
        y0 = int(round(cv_ * ppm - outer_px / 2))
        tex = f["tex"]
        tex[y0:y0 + outer_px, x0:x0 + outer_px] = img[..., None]
        centre = f["p0"] + f["u"] * cu + f["v"] * cv_
        half = spec.tag_size_m / 2
        # Corners in texture (u,v) order: (-,+) (+,+) (+,-) (-,-) relative — detector order is
        # documented by tags.detect; here we store the 4 corners going around the square.
        corners = [
            centre + f["u"] * (-half) + f["v"] * (+half),
            centre + f["u"] * (+half) + f["v"] * (+half),
            centre + f["u"] * (+half) + f["v"] * (-half),
            centre + f["u"] * (-half) + f["v"] * (-half),
        ]
        return TagPlacement(tag_id=tag_id, face=face, center_world=centre.tolist(), size_m=spec.tag_size_m,
                            normal=f["n"].tolist(), corners_world=[c.tolist() for c in corners])

    def _place_tags(self) -> None:
        spec = self.spec
        rng = self.rng
        walls = ["wall_front", "wall_right", "wall_back", "wall_left"]
        tid = 0
        margin = spec.tag_size_m * 1.2
        for i in range(spec.n_wall_tags):
            face = walls[i % 4]
            f = self.faces[face]
            cu = float(rng.uniform(margin, f["lu"] - margin))
            # heights 0.4..1.9 m above floor -> v measured from ceiling
            h_above_floor = float(rng.uniform(0.4, min(1.9, spec.height_m - 0.4)))
            cv_ = spec.height_m - h_above_floor
            self.tags.append(self._paste_tag(face, tid, cu, cv_))
            tid += 1
        f = self.faces["floor"]
        for i in range(spec.n_floor_tags):
            cu = float(rng.uniform(margin, f["lu"] - margin))
            cv_ = float(rng.uniform(margin, f["lv"] - margin))
            self.tags.append(self._paste_tag("floor", tid, cu, cv_))
            tid += 1

    # ------------------------------------------------------------------
    def render(self, cam_pos: np.ndarray, rig_from_world: np.ndarray, width: int, height: int) -> np.ndarray:
        """Render an equirect frame (BGR uint8) from ``cam_pos`` with rotation ``rig_from_world``."""
        u = np.arange(width, dtype=np.float64)
        v = np.arange(height, dtype=np.float64)
        U, V = np.meshgrid(u, v)
        d_rig = G.equirect_to_dirs(U, V, width, height)          # (H,W,3)
        d = d_rig @ rig_from_world                               # world dirs = R^T d
        out = np.zeros((height, width, 3), dtype=np.uint8)
        best_t = np.full((height, width), np.inf)
        for name, f in self.faces.items():
            n = f["n"]
            denom = d @ n
            # ray hits the plane from inside when moving against the inward normal
            with np.errstate(divide="ignore", invalid="ignore"):
                t = ((f["p0"] - cam_pos) @ n) / denom
            valid = (denom < -1e-9) & (t > 0)
            hit = cam_pos + d * t[..., None]
            rel = hit - f["p0"]
            tu = rel @ f["u"]
            tv = rel @ f["v"]
            inside = valid & (tu >= 0) & (tu <= f["lu"]) & (tv >= 0) & (tv <= f["lv"]) & (t < best_t)
            if not inside.any():
                continue
            mx = (tu / f["lu"] * f["tw"] - 0.5).astype(np.float32)
            my = (tv / f["lv"] * f["th"] - 0.5).astype(np.float32)
            sampled = cv2.remap(f["tex"], mx, my, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
            out[inside] = sampled[inside]
            best_t = np.where(inside, t, best_t)
        return out


def loop_trajectory(spec: RoomSpec, n_frames: int) -> list[tuple[np.ndarray, np.ndarray]]:
    """Camera positions and rig_from_world rotations along a loop with gentle wobble."""
    poses = []
    rx = spec.width_m * 0.28
    rz = spec.depth_m * 0.28
    for i in range(n_frames):
        a = 2 * math.pi * i / n_frames
        pos = np.array([rx * math.cos(a), 0.05 * math.sin(3 * a), rz * math.sin(a)])
        heading_deg = math.degrees(math.atan2(-rx * math.sin(a), rz * math.cos(a)))  # tangent direction
        yaw = heading_deg + 25 * math.sin(2 * a)
        pitch = 4 * math.sin(5 * a)
        roll = 2 * math.sin(7 * a)
        rig_from_world = (G.rot_y(yaw) @ G.rot_x(pitch) @ _rot_z(roll)).T
        poses.append((pos, rig_from_world))
    return poses


def _rot_z(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def render_synthetic_clip(
    out_video: Path,
    *,
    frames: int = 150,
    width: int = 2048,
    fps: float = 30.0,
    spec: Optional[RoomSpec] = None,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> dict:
    """Render the clip and write ``<out_video>`` (H.264) plus ``<out_video>.ground_truth.json``."""
    spec = spec or RoomSpec()
    height = width // 2
    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        raise ToolError("ffmpeg not found")
    room = Room(spec)
    poses = loop_trajectory(spec, frames)
    out_video.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", f"{fps}", "-i", "-",
        "-c:v", "libx264", "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(out_video),
    ]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    gt_frames = []
    try:
        for i, (pos, R) in enumerate(poses):
            frame = room.render(pos, R, width, height)
            assert p.stdin is not None
            p.stdin.write(frame.tobytes())
            gt_frames.append({"frame": i, "time_s": i / fps, "position": pos.tolist(),
                              "rig_from_world_qvec": G.quat_wxyz_from_matrix(R).tolist()})
            if on_progress:
                on_progress((i + 1) / frames, f"Rendered {i + 1}/{frames} synthetic frames")
        p.stdin.close()
        rc = p.wait()
        if rc != 0:
            raise ToolError(f"ffmpeg encode failed with code {rc}")
    finally:
        if p.poll() is None:
            p.kill()
    gt = {
        "room": spec.__dict__,
        "width": width, "height": height, "fps": fps, "frames": frames,
        "tags": [t.__dict__ for t in room.tags],
        "cameras": gt_frames,
        "conventions": "world +X right, +Y down, +Z forward; floor at y=+camera_height_m; units metres",
    }
    Path(str(out_video) + ".ground_truth.json").write_text(json.dumps(gt, indent=1))
    return gt

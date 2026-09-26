"""Reproject equirectangular keyframes into a rigid set of pinhole views.

Structure-from-motion and Gaussian-splat trainers want pinhole images, so
every keyframe is resampled into ``cube6`` (6 faces) or ``ring8``
(8 horizontal + up/down) views that share a camera centre and have known,
fixed relative rotations. That set is treated as a multi-camera rig.

Output layout (relative to the project ``views`` dir)::

    <face>/<keyframe:05d>.jpg      pinhole views
    masks/<face>/<keyframe:05d>.jpg.png   COLMAP masks (only for faces that need one)
    index.json                     intrinsics, faces, rotations, file list
"""
from __future__ import annotations

import json
import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np

from ..models import ViewSettings
from ..util.proc import CancelToken, Cancelled, ToolError, cpu_count
from . import geometry as G
from .extract import KeyframeIndex

ProgressCb = Callable[[float, str], None]


@dataclass
class ViewIndex:
    layout: str
    fov_deg: float
    size: int
    focal_px: float
    cx: float
    cy: float
    faces: list[str]
    # cam_from_rig quaternion (w,x,y,z) per face
    cam_from_rig_qvec: dict[str, list[float]]
    masked_faces: list[str]
    keyframes: int
    image_format: str
    equirect_width: int
    equirect_height: int
    items: list[dict]   # {name, face, frame_index}
    stats: dict


# OpenCV releases the GIL in imread/remap/imwrite, so a thread pool scales well
# and avoids the pitfalls of forking/spawning worker processes.
def _build_maps(specs, size: int, fov: float, W: int, H: int) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    maps = {}
    for s in specs:
        mx, my = G.view_remap(s, size, fov, W, H)
        # Fixed-point maps are faster for remap.
        maps[s.name] = cv2.convertMaps(mx, my, cv2.CV_16SC2)
    return maps


def _process_keyframe(src: str, frame_index: int, out_dir: str, ext: str, quality: int,
                      maps: dict, W: int, H: int, blur_sigma: float) -> tuple[int, list[str]]:
    img = cv2.imread(src, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"cannot read {src}")
    if img.shape[1] != W or img.shape[0] != H:
        img = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
    if blur_sigma > 0:
        img = cv2.GaussianBlur(img, (0, 0), blur_sigma)
    written = []
    for face, (m1, m2) in maps.items():
        view = cv2.remap(img, m1, m2, interpolation=cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)
        out = Path(out_dir) / face / f"{frame_index:05d}.{ext}"
        if ext == "jpg":
            ok = cv2.imwrite(str(out), view, [cv2.IMWRITE_JPEG_QUALITY, quality])
        else:
            ok = cv2.imwrite(str(out), view, [cv2.IMWRITE_PNG_COMPRESSION, 2])
        if not ok:
            raise RuntimeError(f"cannot write {out}")
        written.append(f"{face}/{out.name}")
    return frame_index, written


def _pad_equirect_for_wrap(width: int) -> int:
    return width


def reproject_keyframes(
    keyframes_dir: Path,
    kf_index: KeyframeIndex,
    settings: ViewSettings,
    out_dir: Path,
    *,
    workers: int | None = None,
    cancel: Optional[CancelToken] = None,
    on_progress: Optional[ProgressCb] = None,
    log: Optional[Callable[[str], None]] = None,
) -> ViewIndex:
    specs = G.LAYOUTS[settings.layout]
    size = int(settings.size_px)
    fov = float(settings.fov_deg)
    W, H = kf_index.width, kf_index.height
    ext = kf_index.image_format
    quality = 95

    t0 = time.time()
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    for s in specs:
        (out_dir / s.name).mkdir()

    # Downsampling ratio equirect px/deg vs view px/deg; pre-blur if we shrink a lot.
    src_px_per_deg = W / 360.0
    dst_px_per_deg = size / fov
    ratio = src_px_per_deg / dst_px_per_deg
    blur_sigma = 0.5 * (ratio - 1.0) if ratio > 1.3 else 0.0
    if log:
        log(f"reproject: layout={settings.layout} fov={fov} size={size} equirect={W}x{H} "
            f"ratio={ratio:.2f} blur_sigma={blur_sigma:.2f}")

    # Masks: identical for every keyframe of a face.
    masked_faces: list[str] = []
    mask_root = out_dir / "masks"
    if settings.nadir_mask.enabled:
        for s in specs:
            m = G.nadir_mask(s, size, fov, settings.nadir_mask.radius_deg)
            if m is not None:
                masked_faces.append(s.name)
                (mask_root / s.name).mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(mask_root / f"{s.name}.png"), m)
                frac = float((m == 0).mean())
                if log:
                    log(f"nadir mask: face {s.name} masks {frac * 100:.1f}% of pixels")

    n_workers = workers or max(1, min(cpu_count(), 6))
    maps = _build_maps(specs, size, fov, W, H)
    items: list[dict] = []
    done = 0
    total = kf_index.count
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futs = {
            pool.submit(_process_keyframe, str(keyframes_dir / kf.file), kf.index, str(out_dir), ext, quality,
                        maps, W, H, blur_sigma): kf
            for kf in kf_index.items
        }
        try:
            for fut in as_completed(futs):
                if cancel and cancel.cancelled:
                    for f in futs:
                        f.cancel()
                    raise Cancelled()
                frame_index, written = fut.result()
                for name in written:
                    face = name.split("/")[0]
                    items.append({"name": name, "face": face, "frame_index": frame_index})
                done += 1
                if on_progress and (done % 2 == 0 or done == total):
                    on_progress(0.98 * done / total, f"Reprojected {done}/{total} keyframes into {len(specs)} views")
        except Cancelled:
            pool.shutdown(cancel_futures=True)
            raise
        except Exception as e:  # noqa: BLE001
            pool.shutdown(cancel_futures=True)
            raise ToolError(f"reprojection failed: {e}") from e

    # Per-image masks for COLMAP (mask_path/<face>/<frame>.<ext>.png).
    for face in masked_faces:
        m_src = mask_root / f"{face}.png"
        for kf in kf_index.items:
            dst = mask_root / face / f"{kf.index:05d}.{ext}.png"
            try:
                os.link(m_src, dst)
            except OSError:
                shutil.copyfile(m_src, dst)

    items.sort(key=lambda d: (d["frame_index"], d["face"]))
    f = G.focal_px(size, fov)
    idx = ViewIndex(
        layout=settings.layout, fov_deg=fov, size=size, focal_px=f, cx=size / 2.0, cy=size / 2.0,
        faces=[s.name for s in specs],
        cam_from_rig_qvec={s.name: G.quat_wxyz_from_matrix(G.cam_from_rig(s)).tolist() for s in specs},
        masked_faces=masked_faces, keyframes=total, image_format=ext,
        equirect_width=W, equirect_height=H, items=items,
        stats={"seconds": time.time() - t0, "workers": n_workers, "blur_sigma": blur_sigma, "views": len(items)},
    )
    (out_dir / "index.json").write_text(json.dumps(asdict(idx), indent=1))
    if log:
        log(f"reprojected {total} keyframes -> {len(items)} views in {time.time() - t0:.1f}s")
    return idx


def load_view_index(out_dir: Path) -> Optional[ViewIndex]:
    f = out_dir / "index.json"
    if not f.exists():
        return None
    return ViewIndex(**json.loads(f.read_text()))

"""Keyframe selection from a 360° video.

Strategy
--------
Decoding 8K HEVC is the expensive part, so we decode the clip once at
reduced resolution to score every frame for sharpness (variance of the
Laplacian on a 960 px wide grayscale proxy), then pick keyframes:

1. The clip (optionally trimmed) is split into ``target_count`` equal
   windows of consecutive frames.
2. Inside each window the blurriest ``blur_reject_fraction`` of frames are
   discarded and the sharpest remaining frame closest to the window centre
   is chosen, so keyframes stay evenly spaced in time but avoid motion blur.
3. The chosen frames are extracted at full resolution in a second ffmpeg
   pass using a ``select`` filter with the exact frame indices, written as
   JPEG (q ~ 95) or PNG.

Outputs ``keyframes/<index:05d>.<ext>``, ``keyframes/index.json`` with
timing and sharpness metadata, and ``keyframes/thumbs/<index:05d>.jpg``.
"""
from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np

from ..models import KeyframeSettings, ProbeInfo
from ..util.proc import CancelToken, ToolError, find_tool, run_streaming

PROXY_WIDTH = 960
THUMB_WIDTH = 1024

ProgressCb = Callable[[float, str], None]


@dataclass
class Keyframe:
    index: int          # keyframe number 0..N-1 (used in filenames)
    source_frame: int   # frame index in the source video
    time_s: float
    sharpness: float
    file: str           # relative to the keyframes dir


@dataclass
class KeyframeIndex:
    count: int
    source: str
    fps: float
    width: int
    height: int
    image_format: str
    items: list[Keyframe]
    stats: dict


def _laplacian_var(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def score_frames(
    video: Path,
    *,
    fps: float,
    start_s: float,
    end_s: float,
    width: int,
    height: int,
    cancel: CancelToken | None = None,
    on_progress: ProgressCb | None = None,
    log: Callable[[str], None] | None = None,
) -> list[tuple[int, float, float]]:
    """Decode the clip at proxy resolution and return (frame_index, time_s, sharpness)."""
    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        raise ToolError("ffmpeg not found")
    pw = PROXY_WIDTH
    ph = int(round(height * pw / width)) // 2 * 2
    import subprocess

    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-ss", f"{start_s:.3f}", "-to", f"{end_s:.3f}", "-i", str(video),
        "-vf", f"scale={pw}:{ph}:flags=area,format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ]
    if log:
        log("scoring frames: " + " ".join(cmd))
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    if cancel:
        cancel._register(p)
    frame_bytes = pw * ph
    results: list[tuple[int, float, float]] = []
    expected = max(1, int((end_s - start_s) * fps))
    first_frame = int(round(start_s * fps))
    try:
        i = 0
        assert p.stdout is not None
        while True:
            buf = p.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            gray = np.frombuffer(buf, dtype=np.uint8).reshape(ph, pw)
            # Ignore the nadir/zenith bands where equirect stretching inflates blur.
            band = gray[int(ph * 0.15): int(ph * 0.85)]
            results.append((first_frame + i, start_s + i / fps, _laplacian_var(band)))
            i += 1
            if on_progress and i % 15 == 0:
                on_progress(min(0.95, i / expected), f"Scored {i}/{expected} frames for sharpness")
            if cancel and cancel.cancelled:
                break
        rc = p.wait()
        if cancel and cancel.cancelled:
            from ..util.proc import Cancelled
            raise Cancelled()
        if rc != 0 and not results:
            err = p.stderr.read().decode("utf-8", "replace") if p.stderr else ""
            raise ToolError(f"ffmpeg decode failed: {err[-500:]}", rc)
    finally:
        if cancel:
            cancel._unregister(p)
        if p.poll() is None:
            p.kill()
    return results


def select_keyframes(
    scores: list[tuple[int, float, float]],
    target_count: int,
    blur_reject_fraction: float,
) -> list[tuple[int, float, float]]:
    """Pick evenly spread, sharp frames. Returns a subset of ``scores``."""
    n = len(scores)
    if n == 0:
        return []
    target_count = max(1, min(target_count, n))
    chosen: list[tuple[int, float, float]] = []
    edges = np.linspace(0, n, target_count + 1)
    for k in range(target_count):
        lo, hi = int(edges[k]), int(edges[k + 1])
        if hi <= lo:
            hi = min(n, lo + 1)
        window = scores[lo:hi]
        sharp = np.array([s[2] for s in window])
        keep_n = max(1, int(math.ceil(len(window) * (1 - blur_reject_fraction))))
        order = np.argsort(-sharp)  # sharpest first
        candidates = set(order[:keep_n].tolist())
        centre = (len(window) - 1) / 2
        # Prefer the frame closest to the window centre among the sharp ones,
        # breaking ties towards sharper frames.
        best = min(candidates, key=lambda j: (abs(j - centre), -sharp[j]))
        chosen.append(window[best])
    return chosen


def _select_expr(frame_indices: list[int]) -> str:
    # ffmpeg select filter: eq(n,a)+eq(n,b)+...
    return "+".join(f"eq(n\\,{i})" for i in frame_indices)


def extract_keyframes(
    video: Path,
    probe: ProbeInfo,
    settings: KeyframeSettings,
    out_dir: Path,
    *,
    cancel: CancelToken | None = None,
    on_progress: ProgressCb | None = None,
    log: Callable[[str], None] | None = None,
) -> KeyframeIndex:
    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        raise ToolError("ffmpeg not found. Install with: brew install ffmpeg")
    if not (probe.fps and probe.width and probe.height and probe.duration_s):
        raise ToolError("Source video has not been probed successfully")
    fps = probe.fps
    start_s = max(0.0, settings.start_s or 0.0)
    end_s = min(probe.duration_s, settings.end_s or probe.duration_s)
    if end_s - start_s < 1.0:
        raise ToolError(f"Trim range {start_s:.1f}-{end_s:.1f}s is too short")

    out_dir.mkdir(parents=True, exist_ok=True)
    thumbs = out_dir / "thumbs"
    thumbs.mkdir(exist_ok=True)
    for old in list(out_dir.glob("*.jpg")) + list(out_dir.glob("*.png")) + list(thumbs.glob("*.jpg")):
        old.unlink()

    t0 = time.time()
    scores = score_frames(
        video, fps=fps, start_s=start_s, end_s=end_s, width=probe.width, height=probe.height,
        cancel=cancel,
        on_progress=lambda f, m: on_progress(f * 0.35, m) if on_progress else None,
        log=log,
    )
    if not scores:
        raise ToolError("No frames could be decoded from the video")
    chosen = select_keyframes(scores, settings.target_count, settings.blur_reject_fraction)
    if log:
        allv = np.array([s[2] for s in scores])
        chv = np.array([s[2] for s in chosen])
        log(f"scored {len(scores)} frames in {time.time() - t0:.1f}s; "
            f"sharpness median all={np.median(allv):.1f} chosen={np.median(chv):.1f}; "
            f"selected {len(chosen)} keyframes")

    # Second pass: extract full-res frames. Frame indices are relative to the
    # trimmed stream (same -ss/-to as the scoring pass) so `n` matches.
    ext = settings.image_format
    rel_indices = [s[0] - int(round(start_s * fps)) for s in chosen]
    select = _select_expr(rel_indices)
    pattern = out_dir / f"%05d.{ext}"
    vf = f"select='{select}',setpts=N/FRAME_RATE/TB"
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "info", "-nostdin", "-y",
        "-ss", f"{start_s:.3f}", "-to", f"{end_s:.3f}", "-i", str(video),
        "-vf", vf, "-vsync", "vfr", "-start_number", "0",
    ]
    if ext == "jpg":
        q = int(round(2 + (100 - settings.jpeg_quality) * 0.2))  # 95 -> 3, 100 -> 2
        cmd += ["-q:v", str(max(1, q)), "-pix_fmt", "yuvj420p"]
    else:
        cmd += ["-compression_level", "3", "-pix_fmt", "rgb24"]
    cmd.append(str(pattern))
    if log:
        log("extracting keyframes: " + " ".join(cmd))
    total = len(chosen)
    frame_re = re.compile(r"frame=\s*(\d+)")

    def on_line(line: str) -> None:
        m = frame_re.search(line)
        if m and on_progress:
            k = int(m.group(1))
            on_progress(0.35 + 0.55 * min(1.0, k / max(1, total)), f"Extracted {min(k, total)}/{total} keyframes")

    run_streaming(cmd, on_line=on_line, cancel=cancel)

    items: list[Keyframe] = []
    for i, (src, t, sharp) in enumerate(chosen):
        f = out_dir / f"{i:05d}.{ext}"
        if not f.exists():
            raise ToolError(f"ffmpeg did not produce keyframe {f.name}")
        items.append(Keyframe(index=i, source_frame=src, time_s=t, sharpness=sharp, file=f.name))
        if cancel:
            cancel.check()
    # Thumbnails (also used as project thumbnails).
    for i, kf in enumerate(items):
        img = cv2.imread(str(out_dir / kf.file), cv2.IMREAD_REDUCED_COLOR_4)
        if img is None:
            continue
        h = int(round(img.shape[0] * THUMB_WIDTH / img.shape[1]))
        cv2.imwrite(str(thumbs / f"{kf.index:05d}.jpg"), cv2.resize(img, (THUMB_WIDTH, h), interpolation=cv2.INTER_AREA),
                    [cv2.IMWRITE_JPEG_QUALITY, 82])
        if on_progress and i % 10 == 0:
            on_progress(0.9 + 0.1 * i / max(1, len(items)), "Writing thumbnails")

    idx = KeyframeIndex(
        count=len(items), source=str(video), fps=fps, width=probe.width, height=probe.height,
        image_format=ext, items=items,
        stats={
            "frames_scored": len(scores),
            "start_s": start_s, "end_s": end_s,
            "sharpness_median_all": float(np.median([s[2] for s in scores])),
            "sharpness_median_chosen": float(np.median([s[2] for s in chosen])),
            "seconds": time.time() - t0,
        },
    )
    (out_dir / "index.json").write_text(json.dumps(asdict(idx), indent=1))
    return idx


def load_keyframe_index(out_dir: Path) -> KeyframeIndex | None:
    f = out_dir / "index.json"
    if not f.exists():
        return None
    d = json.loads(f.read_text())
    d["items"] = [Keyframe(**k) for k in d["items"]]
    return KeyframeIndex(**d)

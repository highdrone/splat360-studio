"""Validate an input video with ffprobe and classify its projection."""
from __future__ import annotations

import json
import os
from fractions import Fraction
from pathlib import Path

from ..models import ProbeInfo, ProbeIssue
from ..util.proc import find_tool, run_capture

INSTA360_RAW_EXTS = {".insv", ".insp"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mxf"} | INSTA360_RAW_EXTS

# Insta360 X6 shoots 8K30 (7680x3840). Keep some slack for other cameras.
MIN_WIDTH = 3840
IDEAL_WIDTH = 7680
MIN_DURATION_S = 5.0
MAX_DURATION_S = 300.0


def _parse_fps(s: str | None) -> float | None:
    if not s:
        return None
    try:
        f = Fraction(s)
        return float(f) if f.denominator else None
    except (ValueError, ZeroDivisionError):
        return None


def probe_video(path: str | Path) -> ProbeInfo:
    p = Path(path).expanduser()
    info = ProbeInfo(path=str(p), filename=p.name, size_bytes=p.stat().st_size if p.exists() else 0)
    issues = info.issues

    if not p.exists():
        issues.append(ProbeIssue(level="error", code="missing", message=f"File not found: {p}"))
        return info
    if not p.is_file():
        issues.append(ProbeIssue(level="error", code="not_file", message=f"Not a file: {p}"))
        return info
    if not os.access(p, os.R_OK):
        issues.append(ProbeIssue(level="error", code="unreadable", message=f"No read permission: {p}"))
        return info

    ext = p.suffix.lower()
    info.container = ext.lstrip(".")
    if ext in INSTA360_RAW_EXTS:
        info.is_insta360_raw = True
        info.projection = "dual_fisheye"
        issues.append(
            ProbeIssue(
                level="error",
                code="insta360_raw",
                message="This is a raw Insta360 file (unstitched dual fisheye).",
                hint=(
                    "Open it in Insta360 Studio and export as an equirectangular MP4 "
                    "(8K, H.265 or H.264, FlowState stabilization on, Direction Lock off), "
                    "then import the exported file."
                ),
            )
        )
        return info
    if ext not in VIDEO_EXTS:
        issues.append(
            ProbeIssue(level="error", code="bad_extension", message=f"Unsupported file type '{ext}'.",
                       hint="Import an MP4 or MOV exported from Insta360 Studio.")
        )
        return info

    ffprobe = find_tool("ffprobe")
    if not ffprobe:
        issues.append(
            ProbeIssue(level="error", code="no_ffprobe", message="ffprobe not found.",
                       hint="Install ffmpeg: brew install ffmpeg")
        )
        return info

    try:
        out = run_capture(
            [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(p)],
            timeout=60,
        )
        data = json.loads(out)
    except Exception as e:
        issues.append(ProbeIssue(level="error", code="probe_failed", message=f"ffprobe failed: {e}"))
        return info

    fmt = data.get("format", {})
    streams = data.get("streams", [])
    vstreams = [s for s in streams if s.get("codec_type") == "video"]
    if not vstreams:
        issues.append(ProbeIssue(level="error", code="no_video", message="No video stream found."))
        return info
    # Pick the largest video stream (Insta360 exports may include a thumbnail stream).
    v = max(vstreams, key=lambda s: (s.get("width") or 0) * (s.get("height") or 0))
    info.codec = v.get("codec_name")
    info.width = v.get("width")
    info.height = v.get("height")
    info.pix_fmt = v.get("pix_fmt")
    info.fps = _parse_fps(v.get("avg_frame_rate")) or _parse_fps(v.get("r_frame_rate"))
    dur = v.get("duration") or fmt.get("duration")
    info.duration_s = float(dur) if dur else None
    nb = v.get("nb_frames")
    if nb and str(nb).isdigit():
        info.frame_count = int(nb)
    elif info.duration_s and info.fps:
        info.frame_count = int(round(info.duration_s * info.fps))
    br = v.get("bit_rate") or fmt.get("bit_rate")
    info.bit_rate = int(br) if br and str(br).isdigit() else None

    tags = {**{k.lower(): v for k, v in (fmt.get("tags") or {}).items()},
            **{k.lower(): v for k, v in (v.get("tags") or {}).items()}}
    info.camera_make = tags.get("make") or tags.get("com.apple.quicktime.make")
    info.camera_model = tags.get("model") or tags.get("com.apple.quicktime.model")
    # Spherical video metadata (Google spherical v1/v2) if present.
    spherical = any("spherical" in k or "projection" in k for k in tags)
    side_data = v.get("side_data_list") or []
    sd_equirect = any(
        (sd.get("side_data_type") == "Spherical Mapping" and str(sd.get("projection", "")).lower().startswith("equi"))
        for sd in side_data
    )

    w, h = info.width or 0, info.height or 0
    aspect_ok = w > 0 and h > 0 and abs(w / h - 2.0) < 0.02
    if aspect_ok:
        info.is_equirectangular = True
        info.projection = "equirectangular"
    elif w > 0 and h > 0 and abs(w / h - 1.0) < 0.05 and w >= 2000:
        info.projection = "dual_fisheye"
        issues.append(
            ProbeIssue(level="error", code="dual_fisheye",
                       message=f"{w}x{h} looks like an unstitched dual-fisheye export.",
                       hint="Export from Insta360 Studio as equirectangular (2:1) instead.")
        )
    else:
        issues.append(
            ProbeIssue(level="error", code="not_equirect",
                       message=f"{w}x{h} is not a 2:1 equirectangular frame.",
                       hint="Export a 360° equirectangular video (for example 7680x3840).")
        )
    if sd_equirect or (spherical and aspect_ok):
        info.is_equirectangular = True

    if aspect_ok and w < MIN_WIDTH:
        issues.append(
            ProbeIssue(level="warning", code="low_res",
                       message=f"{w}x{h} is below 4K; reconstruction detail will suffer.",
                       hint="Shoot and export at 8K (7680x3840) for best results.")
        )
    elif aspect_ok and w < IDEAL_WIDTH:
        issues.append(ProbeIssue(level="info", code="not_8k", message=f"{w}x{h}; 8K export gives more detail."))

    if info.fps and info.fps < 24:
        issues.append(ProbeIssue(level="warning", code="low_fps", message=f"{info.fps:.1f} fps is low; keep moves slow."))
    if info.duration_s is not None:
        if info.duration_s < MIN_DURATION_S:
            issues.append(ProbeIssue(level="error", code="too_short",
                                     message=f"Clip is {info.duration_s:.1f} s; need at least {MIN_DURATION_S:.0f} s."))
        elif info.duration_s > MAX_DURATION_S:
            issues.append(ProbeIssue(level="warning", code="long_clip",
                                     message=f"Clip is {info.duration_s:.0f} s; trim to the useful part in settings "
                                             f"to keep processing time reasonable."))
    if info.codec not in (None, "hevc", "h264", "prores", "av1", "vp9", "mpeg4"):
        issues.append(ProbeIssue(level="warning", code="codec", message=f"Unusual codec '{info.codec}'."))
    if info.pix_fmt and "10" in info.pix_fmt:
        issues.append(ProbeIssue(level="info", code="10bit", message="10-bit source; frames are converted to 8-bit."))
    return info

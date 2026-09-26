"""AprilTag detection on the pinhole views.

Corner order (verified in tests): pupil-apriltags returns the four corners
of a tag viewed upright as bottom-left, bottom-right, top-right, top-left
in image coordinates (counter-clockwise on screen, y down), starting at the
corner adjacent to the tag's origin. ``tag_object_points`` uses the same
order so the corners can be used directly for PnP or triangulation.
"""
from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Iterable, Optional

import cv2
import numpy as np

from ..models import TagObservation, TagSummary
from .families import get_family

_thread_local = threading.local()


def _detector(family: str, nthreads: int = 1):
    from pupil_apriltags import Detector

    key = (family, nthreads)
    cache = getattr(_thread_local, "det", {})
    if key not in cache:
        cache[key] = Detector(families=family, nthreads=nthreads, quad_decimate=1.0, quad_sigma=0.0,
                              refine_edges=1, decode_sharpening=0.25)
        _thread_local.det = cache
    return cache[key]


class TagDetector:
    def __init__(self, family: str = "tag36h11", nthreads: int = 1):
        get_family(family)  # validate
        self.family = family
        self.nthreads = nthreads

    def detect(self, image: np.ndarray, view: str = "", frame_index: int = 0, face: str = "",
               min_decision_margin: float = 30.0, allowed_ids: Optional[set[int]] = None) -> list[TagObservation]:
        gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        det = _detector(self.family, self.nthreads)
        best: dict[int, TagObservation] = {}
        for r in det.detect(gray):
            if r.hamming > 0 or r.decision_margin < min_decision_margin:
                continue
            if allowed_ids is not None and r.tag_id not in allowed_ids:
                continue
            obs = TagObservation(tag_id=int(r.tag_id), view=view, frame_index=frame_index, face=face,
                                 corners=[[float(x), float(y)] for x, y in r.corners],
                                 center=[float(r.center[0]), float(r.center[1])],
                                 decision_margin=float(r.decision_margin), hamming=int(r.hamming))
            prev = best.get(obs.tag_id)
            if prev is None or obs.decision_margin > prev.decision_margin:
                best[obs.tag_id] = obs
        return list(best.values())


_FRAME_RE = re.compile(r"^(\d+)\.(jpg|jpeg|png)$", re.I)


def list_views(views_dir: Path) -> list[tuple[str, int, str]]:
    """(relative name, frame index, face) for every view image; skips masks/ and non-numeric files."""
    out = []
    for face_dir in sorted(p for p in views_dir.iterdir() if p.is_dir() and p.name != "masks"):
        for f in sorted(face_dir.iterdir()):
            m = _FRAME_RE.match(f.name)
            if m:
                out.append((f"{face_dir.name}/{f.name}", int(m.group(1)), face_dir.name))
    return out


def detect_in_directory(views_dir: Path, family: str, min_decision_margin: float,
                        allowed_ids: Optional[set[int]] = None,
                        on_progress: Optional[Callable[[int, int], None]] = None,
                        threads: int = 4) -> list[TagObservation]:
    """Detect tags in every view. pupil-apriltags releases the GIL, so threads scale well."""
    views = list_views(Path(views_dir))
    det = TagDetector(family, nthreads=1)
    results: list[TagObservation] = []
    done = 0
    lock = threading.Lock()

    def work(item):
        name, idx, face = item
        img = cv2.imread(str(Path(views_dir) / name), cv2.IMREAD_GRAYSCALE)
        if img is None:
            return []
        return det.detect(img, name, idx, face, min_decision_margin, allowed_ids)

    with ThreadPoolExecutor(max_workers=max(1, threads)) as pool:
        futs = [pool.submit(work, v) for v in views]
        for fut in as_completed(futs):
            obs = fut.result()
            with lock:
                results.extend(obs)
                done += 1
                if on_progress and (done % 10 == 0 or done == len(views)):
                    on_progress(done, len(views))
    results.sort(key=lambda o: (o.frame_index, o.face, o.tag_id))
    return results


def summarize(observations: Iterable[TagObservation], family: str, size_mm: float, views_total: int) -> TagSummary:
    obs = list(observations)
    counts: dict[int, int] = {}
    views = set()
    for o in obs:
        counts[o.tag_id] = counts.get(o.tag_id, 0) + 1
        views.add(o.view)
    return TagSummary(family=family, size_mm=size_mm, total_observations=len(obs), unique_tags=len(counts),
                      per_tag_counts=dict(sorted(counts.items())), views_with_tags=len(views), views_total=views_total,
                      coverage_fraction=len(views) / views_total if views_total else 0.0,
                      weak_tags=sorted(t for t, c in counts.items() if c < 3))


def save_observations(path: Path, observations: Iterable[TagObservation]) -> None:
    Path(path).write_text(json.dumps([o.model_dump() for o in observations]))


def load_observations(path: Path) -> list[TagObservation]:
    return [TagObservation(**d) for d in json.loads(Path(path).read_text())]


def tag_object_points(family: str, size_mm: float) -> np.ndarray:
    """4x3 corner coordinates (metres) in the tag frame (x right, y up, z out of the tag), detector order."""
    h = size_mm / 2000.0
    return np.array([[-h, -h, 0.0], [h, -h, 0.0], [h, h, 0.0], [-h, h, 0.0]])

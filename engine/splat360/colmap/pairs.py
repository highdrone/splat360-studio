"""Build the image-pair list for feature matching.

For a rig of ``F`` faces over ``N`` keyframes we match:

* within a keyframe: every pair of neighbouring faces (they overlap when
  the FOV exceeds 90°);
* between keyframes ``i`` and ``j`` with ``|i - j| <= window``: the same
  face; and for ``|i - j| <= 2`` also neighbouring faces (the camera turns,
  so a feature seen on the front face may appear on the right face a few
  frames later). Cross-face pairs are limited because CPU SIFT matching is
  the slowest step on a Mac;
* loop closure: keyframes that are multiples of ``loop_stride`` are matched
  against each other with all face combinations except opposite faces.
"""
from __future__ import annotations

from itertools import combinations

from ..pipeline import geometry as G


def build_pairs(frames: list[int], faces: list[str], layout: str, window: int, loop_stride: int,
                ext: str) -> list[tuple[str, str]]:
    nb = G.neighbours(layout)
    face_set = set(faces)

    def name(f: int, face: str) -> str:
        return f"{face}/{f:05d}.{ext}"

    pairs: set[tuple[str, str]] = set()

    def add(a: str, b: str) -> None:
        if a == b:
            return
        pairs.add((a, b) if a < b else (b, a))

    frames = sorted(frames)
    # Within-frame neighbours
    for f in frames:
        for face in faces:
            for other in nb.get(face, []):
                if other in face_set:
                    add(name(f, face), name(f, other))
    # Temporal window
    cross_window = min(2, window)
    for idx, f in enumerate(frames):
        for j in range(idx + 1, min(len(frames), idx + window + 1)):
            g = frames[j]
            for face in faces:
                add(name(f, face), name(g, face))
                if j - idx <= cross_window:
                    for other in nb.get(face, []):
                        if other in face_set:
                            add(name(f, face), name(g, other))
    # Loop closure
    if loop_stride > 0:
        anchors = [f for f in frames if f % loop_stride == 0]
        for f, g in combinations(anchors, 2):
            if abs(f - g) <= window:
                continue
            for face in faces:
                for other in faces:
                    if _opposite(face, other, layout):
                        continue
                    add(name(f, face), name(g, other))
    return sorted(pairs)


def _opposite(a: str, b: str, layout: str) -> bool:
    opp = {"front": "back", "back": "front", "left": "right", "right": "left", "up": "down", "down": "up"}
    if layout == "cube6":
        return opp.get(a) == b
    if a in ("up", "down") or b in ("up", "down"):
        return opp.get(a) == b
    try:
        ya, yb = int(a[3:]), int(b[3:])
    except ValueError:
        return False
    return abs(((ya - yb) + 180) % 360 - 180) >= 135

"""AprilTag family definitions and bitmap rendering.

The code tables are vendored from the AprilRobotics/apriltag project
(BSD-2-Clause, Copyright (C) 2013-2016 The Regents of The University of
Michigan) and stored in ``data/apriltag_families.json``. Rendering follows
``apriltag_to_image`` from ``apriltag.c`` exactly so generated tags are
bit-for-bit identical to the reference implementation.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from importlib import resources

import numpy as np

SUPPORTED_FAMILIES = ("tag36h11", "tagStandard41h12", "tag25h9", "tag16h5")
DEFAULT_FAMILY = "tag36h11"


@dataclass(frozen=True)
class TagFamily:
    name: str
    nbits: int
    hamming: int
    ncodes: int
    width_at_border: int
    total_width: int
    reversed_border: bool
    bit_x: tuple[int, ...]
    bit_y: tuple[int, ...]
    codes: tuple[int, ...]

    @property
    def description(self) -> str:
        return {
            "tag36h11": "Recommended. 587 tags, very robust decoding, widely supported.",
            "tagStandard41h12": "2115 tags, smaller border, denser data. Needs a newer detector.",
            "tag25h9": "35 tags, legacy family.",
            "tag16h5": "30 tags, legacy family. Prone to false positives; not recommended.",
        }.get(self.name, "")

    @property
    def recommended(self) -> bool:
        return self.name == DEFAULT_FAMILY

    def bitmap(self, tag_id: int) -> np.ndarray:
        """Return the tag as a ``total_width x total_width`` uint8 array.

        Values are 0 (black) or 255 (white), including the outer quiet
        ring for non-reversed families. Mirrors ``apriltag_to_image``.
        """
        if not 0 <= tag_id < self.ncodes:
            raise ValueError(f"{self.name} has ids 0..{self.ncodes - 1}, got {tag_id}")
        code = self.codes[tag_id]
        tw = self.total_width
        im = np.zeros((tw, tw), dtype=np.uint8)
        white_border_width = self.width_at_border + (0 if self.reversed_border else 2)
        wbs = (tw - white_border_width) // 2
        for i in range(white_border_width - 1):
            im[wbs, wbs + i] = 255
            im[wbs + i, tw - 1 - wbs] = 255
            im[tw - 1 - wbs, wbs + i + 1] = 255
            im[wbs + 1 + i, wbs] = 255
        border_start = (tw - self.width_at_border) // 2
        for i in range(self.nbits):
            if code & (1 << (self.nbits - i - 1)):
                im[self.bit_y[i] + border_start, self.bit_x[i] + border_start] = 255
        return im

    def image(self, tag_id: int, px_per_cell: int = 40, quiet_cells: int = 1) -> np.ndarray:
        """Render a tag as a printable grayscale image with a white quiet zone.

        ``quiet_cells`` extra white cells are added around the tag so that
        the detector always finds a clean white margin, even for families
        whose ``total_width`` already includes one.
        """
        bm = self.bitmap(tag_id)
        if quiet_cells:
            bm = np.pad(bm, quiet_cells, constant_values=255)
        return np.kron(bm, np.ones((px_per_cell, px_per_cell), dtype=np.uint8))

    def outer_cells(self, quiet_cells: int = 1) -> int:
        """Cells across a rendered image (tag + quiet zone)."""
        return self.total_width + 2 * quiet_cells

    def detected_cells(self) -> int:
        """Cells across the black square edge that detectors report corners on.

        Detected corners lie on the outer edge of the black border for normal
        families and on the outer edge of the *white* ring for reversed
        border families. Both equal ``width_at_border``, which is the
        distance the physical *tag size* refers to.
        """
        return self.width_at_border


@cache
def _load_all() -> dict[str, TagFamily]:
    with resources.files("splat360.data").joinpath("apriltag_families.json").open("r") as f:
        raw = json.load(f)
    fams: dict[str, TagFamily] = {}
    for name, d in raw.items():
        fams[name] = TagFamily(
            name=name,
            nbits=d["nbits"],
            hamming=d["hamming"],
            ncodes=d["ncodes"],
            width_at_border=d["width_at_border"],
            total_width=d["total_width"],
            reversed_border=d["reversed_border"],
            bit_x=tuple(d["bit_x"]),
            bit_y=tuple(d["bit_y"]),
            codes=tuple(int(c) for c in d["codes"]),
        )
    return fams


def get_family(name: str = DEFAULT_FAMILY) -> TagFamily:
    fams = _load_all()
    if name not in fams:
        raise KeyError(f"Unknown tag family '{name}'. Supported: {', '.join(fams)}")
    return fams[name]


def list_families() -> list[TagFamily]:
    return [get_family(n) for n in SUPPORTED_FAMILIES]

"""Single-tag renderers: vector SVG at physical size and raster PNG.

Both renderers draw the full family bitmap (``total_width`` cells, which
already includes the family's own white ring for non-reversed families) plus
``quiet_cells`` extra white cells on every side. The black square that the
physical size refers to spans ``width_at_border`` cells, so one cell is
``size_mm / width_at_border`` millimetres.
"""
from __future__ import annotations

from xml.sax.saxutils import escape

import cv2
import numpy as np

from .families import TagFamily, get_family

LABEL_FONT = "Helvetica, Arial, sans-serif"


def _runs(row: np.ndarray) -> list[tuple[int, int]]:
    """Return ``(start, length)`` runs of black (0) cells in a bitmap row."""
    runs: list[tuple[int, int]] = []
    start = None
    for x, v in enumerate(row):
        black = v == 0
        if black and start is None:
            start = x
        elif not black and start is not None:
            runs.append((start, x - start))
            start = None
    if start is not None:
        runs.append((start, len(row) - start))
    return runs


def black_runs(fam: TagFamily, tag_id: int, quiet_cells: int) -> list[tuple[int, int, int]]:
    """Horizontal runs of black cells as ``(row, col, length)`` in the padded grid.

    Shared by the SVG and PDF renderers so that both draw exactly the same
    geometry. Coordinates are cells, origin at the top-left of the quiet zone.
    """
    bm = fam.bitmap(tag_id)
    if quiet_cells:
        bm = np.pad(bm, quiet_cells, constant_values=255)
    out: list[tuple[int, int, int]] = []
    for y in range(bm.shape[0]):
        for x0, n in _runs(bm[y]):
            out.append((y, x0, n))
    return out


def render_tag_svg(
    family: str,
    tag_id: int,
    size_mm: float,
    quiet_cells: int = 1,
    label: bool = True,
) -> str:
    """Render one tag as an SVG document sized in millimetres.

    * ``width``/``height`` attributes are in ``mm`` so that a print at 100 %
      yields a black square of exactly ``size_mm`` (``width_at_border`` cells).
    * The ``viewBox`` is in cells; one cell == ``size_mm / width_at_border`` mm.
    * Only black cells are drawn (as rects) over a white background rect, so
      the file is small and has no anti-aliasing artefacts.
    * With ``label=True`` a text line is added below the tag; the document
      grows by 2 cells to make room. No external font is required.

    The output is deterministic for the same inputs.
    """
    if size_mm <= 0:
        raise ValueError("size_mm must be positive")
    fam = get_family(family)
    quiet_cells = max(int(quiet_cells), 2 if fam.reversed_border else 1)
    cells = fam.outer_cells(quiet_cells)
    cell_mm = size_mm / fam.width_at_border
    label_cells = 2 if label else 0
    width_mm = cells * cell_mm
    height_mm = (cells + label_cells) * cell_mm

    fmt = lambda v: f"{v:.4f}".rstrip("0").rstrip(".")  # noqa: E731
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt(width_mm)}mm" '
            f'height="{fmt(height_mm)}mm" viewBox="0 0 {cells} {cells + label_cells}" '
            f'shape-rendering="crispEdges" data-family="{escape(fam.name)}" data-id="{tag_id}" '
            f'data-size-mm="{fmt(size_mm)}">'
        ),
        f"<title>{escape(fam.name)} id {tag_id} — {fmt(size_mm)} mm black square</title>",
        f'<rect x="0" y="0" width="{cells}" height="{cells + label_cells}" fill="#ffffff"/>',
        '<g fill="#000000">',
    ]
    for row, col, n in black_runs(fam, tag_id, quiet_cells):
        parts.append(f'<rect x="{col}" y="{row}" width="{n}" height="1"/>')
    parts.append("</g>")
    if label:
        text = f"{fam.name}  id {tag_id}  •  {fmt(size_mm)} mm black square  •  Splat360"
        parts.append(
            f'<text x="{cells / 2}" y="{cells + 1.25}" font-family="{LABEL_FONT}" '
            f'font-size="0.6" text-anchor="middle" fill="#000000">{escape(text)}</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def render_tag_png(family: str, tag_id: int, px: int = 600, quiet_cells: int = 1) -> bytes:
    """Render one tag (with quiet zone) as PNG bytes, ``px`` pixels on a side.

    The bitmap is scaled with nearest-neighbour interpolation so cell edges
    stay perfectly crisp. Because ``px`` is usually not a multiple of the cell
    count, individual cells may differ by one pixel in size; the image is
    intended for on-screen preview and detector round-trips, not for
    physically accurate printing (use the SVG or PDF for that).
    """
    if px < 16:
        raise ValueError("px must be at least 16")
    fam = get_family(family)
    quiet_cells = max(int(quiet_cells), 2 if fam.reversed_border else 1)
    cells = fam.outer_cells(quiet_cells)
    per_cell = max(1, px // cells)
    img = fam.image(tag_id, per_cell, quiet_cells)
    if img.shape[0] != px:
        img = cv2.resize(img, (px, px), interpolation=cv2.INTER_NEAREST)
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not ok:  # pragma: no cover - cv2 always succeeds for uint8 input
        raise RuntimeError("PNG encoding failed")
    return buf.tobytes()

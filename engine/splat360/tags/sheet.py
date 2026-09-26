"""Printable AprilTag sheets (PDF) with physically exact tag sizes.

Design goals
------------
* **Physical accuracy.** The black square edge (``width_at_border`` cells of
  the family) must measure exactly ``tag_size_mm`` on paper. Every cell is
  drawn as a vector rectangle (``tag_size_mm / width_at_border`` mm on a
  side); nothing is rasterised or resampled. All black cells of a tag are
  emitted as a single filled path so PDF rasterisers never leave hairline
  seams between adjacent cells.
* **Quiet zone.** The full family bitmap (``total_width`` cells, which for
  non-reversed families already contains the family's own white ring) is
  drawn plus at least one extra white cell around it (two for reversed-border
  families whose outermost cells carry data). The quiet zone is painted as a
  genuine white rectangle, not left to the paper.
* **Verifiable scale.** Every tag page can carry a 100 mm scale bar in the
  footer so the user can check that the print dialog did not scale the page.
* **Layout.** When several tags (each with quiet zone, label and >= 8 mm gaps)
  fit on a page they are laid out as a centred grid with crop marks; otherwise
  one tag per page, centred, with the label and scale bar in a footer band.

Coordinates in this module are millimetres measured from the *top-left* of
the page (``x`` right, ``y`` down); the ``_Canvas`` helper converts to
reportlab's bottom-left point system.
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass, field

from reportlab.lib.units import mm as MM
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as rl_canvas

from ..models import TagSheetRequest
from .families import TagFamily, get_family
from .svg import black_runs

# --------------------------------------------------------------------------
# Constants (millimetres unless noted)
# --------------------------------------------------------------------------
PAGE_SIZES_MM: dict[str, tuple[float, float]] = {
    "letter": (215.9, 279.4),
    "a4": (210.0, 297.0),
    "tabloid": (279.4, 431.8),
    "a3": (297.0, 420.0),
    "a2": (420.0, 594.0),
    "a1": (594.0, 841.0),
    "a0": (841.0, 1189.0),
}

GAP_MM = 8.0            # minimum gap between tags in a grid (crop marks live here)
MAX_GAP_MM = 24.0       # extra page space widens gaps up to this before centring
CROP_MM = 3.0           # crop mark length
CROP_OFFSET_MM = 0.8    # distance between quiet-zone corner and crop mark
SCALE_BAR_MM = 100.0
FOOTER_SCALE_MM = 14.0  # footer band height when only the scale bar is present
FOOTER_SINGLE_MM = 18.0 # footer band (single-tag page) holding scale bar + label side by side
FOOTER_TINY_MM = 4.0    # footer band for the tiny id when label=False and no scale bar
LABEL_H_MM = 18.0       # label block under a gridded tag (big id + one small line)
LABEL_PROJECT_EXTRA_MM = 3.0
LABEL_NONE_H_MM = 3.5   # tiny id under a gridded tag when label=False
BIG_ID_PT = 42.0        # Helvetica-Bold cap height 0.718 em -> 10.6 mm, readable from ~3 m
SMALL_PT = 6.0
TINY_PT = 5.0
GUIDE_ROW_MM = 6.0
GUIDE_TABLE_COL_MM = (14.0, 16.0, 52.0)   # id | placed | location
GUIDE_TABLE_GAP_MM = 6.0

FONT = "Helvetica"
FONT_BOLD = "Helvetica-Bold"
AUTHOR = "Splat360 Studio"
BULLET = "•"


# --------------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------------
@dataclass
class SheetLayout:
    """Everything needed to place tags on pages; produced by :func:`compute_layout`."""

    family: TagFamily
    ids: list[int]
    quiet_cells: int
    cell_mm: float
    tag_outer_mm: float          # tag bitmap + quiet zone, edge length
    page_w: float
    page_h: float
    margin: float
    mode: str                    # "grid" | "single"
    cols: int
    rows: int
    tags_per_page: int
    gap_x: float
    gap_y: float
    origin_x: float              # top-left of the first tag's quiet zone
    origin_y: float
    label_h: float               # label block under each gridded tag
    footer_h: float              # footer band height (scale bar / single-page label)
    footer_stacked: bool         # single mode: label on its own row above the scale bar
    largest_fit_mm: float        # largest tag_size_mm that fits one per page (this orientation)
    fits: bool
    tag_pages: int
    guide_pages: int
    pages: int
    message: str | None = None
    extra: dict = field(default_factory=dict)


def resolve_ids(req: TagSheetRequest, fam: TagFamily) -> list[int]:
    """Explicit ``ids`` or ``first_id .. first_id+count-1``; validated against the family."""
    ids = list(req.ids) if req.ids else list(range(req.first_id, req.first_id + req.count))
    if not ids:
        raise ValueError("No tag ids requested")
    bad = [i for i in ids if not 0 <= i < fam.ncodes]
    if bad:
        raise ValueError(
            f"{fam.name} has ids 0..{fam.ncodes - 1}; requested id(s) out of range: {bad[:5]}"
        )
    return ids


def quiet_cells_for(fam: TagFamily) -> int:
    """Extra white cells drawn around the family bitmap (2 for reversed-border families)."""
    return 2 if fam.reversed_border else 1


def page_size_mm(page: str, orientation: str) -> tuple[float, float]:
    w, h = PAGE_SIZES_MM[page]
    return (h, w) if orientation == "landscape" else (w, h)


def _guide_table_capacity(avail_w: float, avail_h: float) -> int:
    """How many id rows fit in a table area of the given size (multi-column)."""
    set_w = sum(GUIDE_TABLE_COL_MM)
    ncols = max(1, int((avail_w + GUIDE_TABLE_GAP_MM) // (set_w + GUIDE_TABLE_GAP_MM)))
    rows = max(0, int(avail_h // GUIDE_ROW_MM) - 1)  # minus header row
    return ncols * rows


# Vertical extent of the guide page's text + diagram block, before the id table.
GUIDE_HEADER_MM = 118.0


def _guide_page_count(n_ids: int, page_w: float, page_h: float, margin: float) -> int:
    avail_w = page_w - 2 * margin
    avail_h = page_h - 2 * margin
    first = _guide_table_capacity(avail_w, avail_h - GUIDE_HEADER_MM - 6)
    if n_ids <= first:
        return 1
    rest = _guide_table_capacity(avail_w, avail_h - 14)
    return 1 + math.ceil((n_ids - first) / max(1, rest))


def compute_layout(req: TagSheetRequest) -> SheetLayout:
    """Compute the page layout for a sheet request. Never raises for size; see ``fits``."""
    fam = get_family(req.family)
    ids = resolve_ids(req, fam)
    quiet = quiet_cells_for(fam)
    cell_mm = req.tag_size_mm / fam.width_at_border
    outer_cells = fam.outer_cells(quiet)
    outer_mm = outer_cells * cell_mm
    page_w, page_h = page_size_mm(req.page, req.orientation)
    margin = float(req.margin_mm)
    avail_w = page_w - 2 * margin
    avail_h = page_h - 2 * margin

    # ---- grid attempt -----------------------------------------------------
    footer_grid = FOOTER_SCALE_MM if req.include_scale_check else 0.0
    if req.label:
        label_h = LABEL_H_MM + (LABEL_PROJECT_EXTRA_MM if req.project_name else 0.0)
    else:
        label_h = LABEL_NONE_H_MM
    cell_w = outer_mm
    cell_h = outer_mm + label_h
    cols = int((avail_w + GAP_MM) // (cell_w + GAP_MM)) if cell_w > 0 else 0
    rows = int((avail_h - footer_grid + GAP_MM) // (cell_h + GAP_MM)) if cell_h > 0 else 0
    cols, rows = max(cols, 0), max(rows, 0)

    # ---- single-page geometry (also used for the "largest that fits" hint) --
    if req.label:
        stacked = avail_w < SCALE_BAR_MM + 95.0 and req.include_scale_check
        footer_single = FOOTER_SINGLE_MM + (FOOTER_SCALE_MM if stacked else 0.0)
    else:
        stacked = False
        footer_single = FOOTER_SCALE_MM if req.include_scale_check else FOOTER_TINY_MM
    single_limit = min(avail_w, avail_h - footer_single)
    largest_fit = math.floor(single_limit / outer_cells * fam.width_at_border) if single_limit > 0 else 0.0
    largest_fit = max(0.0, float(largest_fit))

    guide_pages = _guide_page_count(len(ids), page_w, page_h, margin) if req.include_guide else 0

    if cols * rows >= 2:
        per_page = cols * rows
        used_cols = min(cols, len(ids))
        used_rows = min(rows, math.ceil(len(ids) / cols))
        # widen gaps a little with spare space, then centre the used grid
        spare_x = avail_w - (cols * cell_w + (cols - 1) * GAP_MM)
        spare_y = (avail_h - footer_grid) - (rows * cell_h + (rows - 1) * GAP_MM)
        gap_x = min(MAX_GAP_MM, GAP_MM + (spare_x / (cols - 1) if cols > 1 else 0.0))
        gap_y = min(MAX_GAP_MM, GAP_MM + (spare_y / (rows - 1) if rows > 1 else 0.0))
        grid_w = used_cols * cell_w + (used_cols - 1) * gap_x
        grid_h = used_rows * cell_h + (used_rows - 1) * gap_y
        origin_x = margin + (avail_w - grid_w) / 2
        origin_y = margin + (avail_h - footer_grid - grid_h) / 2
        tag_pages = math.ceil(len(ids) / per_page)
        return SheetLayout(
            family=fam, ids=ids, quiet_cells=quiet, cell_mm=cell_mm, tag_outer_mm=outer_mm,
            page_w=page_w, page_h=page_h, margin=margin, mode="grid", cols=cols, rows=rows,
            tags_per_page=per_page, gap_x=gap_x, gap_y=gap_y, origin_x=origin_x, origin_y=origin_y,
            label_h=label_h, footer_h=footer_grid, footer_stacked=False,
            largest_fit_mm=largest_fit, fits=True, tag_pages=tag_pages, guide_pages=guide_pages,
            pages=tag_pages + guide_pages,
        )

    fits = outer_mm <= avail_w + 1e-6 and outer_mm <= avail_h - footer_single + 1e-6
    message = None
    if not fits:
        message = (
            f"A {req.tag_size_mm:g} mm {fam.name} tag needs {outer_mm:.0f} mm including its quiet zone, "
            f"which does not fit {req.page} {req.orientation} with {margin:g} mm margins. "
            f"The largest size that fits is {largest_fit:.0f} mm"
            + (" (or choose a larger page / reduce the margins)." if largest_fit > 0 else "; choose a larger page.")
        )
    origin_x = margin + (avail_w - outer_mm) / 2
    origin_y = margin + (avail_h - footer_single - outer_mm) / 2
    return SheetLayout(
        family=fam, ids=ids, quiet_cells=quiet, cell_mm=cell_mm, tag_outer_mm=outer_mm,
        page_w=page_w, page_h=page_h, margin=margin, mode="single", cols=1, rows=1,
        tags_per_page=1, gap_x=0.0, gap_y=0.0, origin_x=origin_x, origin_y=origin_y,
        label_h=0.0, footer_h=footer_single, footer_stacked=stacked,
        largest_fit_mm=largest_fit, fits=fits, tag_pages=len(ids) if fits else 0,
        guide_pages=guide_pages if fits else 0, pages=(len(ids) + guide_pages) if fits else 0,
        message=message,
    )


def sheet_layout(req: TagSheetRequest) -> dict:
    """Layout summary for the UI, computed without drawing anything.

    Returns ``{pages, tag_pages, guide_pages, tags_per_page, cell_mm, tag_outer_mm,
    grid: (cols, rows), largest_fit_mm, fits, mode, page_mm, message}``.
    Unlike :func:`render_tag_sheet` this does **not** raise when the tag is too
    large; ``fits`` is ``False`` and ``message`` explains, so the UI can show
    the largest size that fits before the user clicks "generate".
    """
    lay = compute_layout(req)
    return {
        "pages": lay.pages,
        "tag_pages": lay.tag_pages,
        "guide_pages": lay.guide_pages,
        "tags_per_page": lay.tags_per_page,
        "cell_mm": round(lay.cell_mm, 4),
        "tag_outer_mm": round(lay.tag_outer_mm, 3),
        "grid": (lay.cols, lay.rows),
        "largest_fit_mm": lay.largest_fit_mm,
        "fits": lay.fits,
        "mode": lay.mode,
        "page_mm": (lay.page_w, lay.page_h),
        "quiet_cells": lay.quiet_cells,
        "message": lay.message,
    }


# --------------------------------------------------------------------------
# Drawing helpers (mm, origin top-left)
# --------------------------------------------------------------------------
class _Canvas:
    """Thin wrapper over a reportlab canvas using mm from the top-left corner."""

    def __init__(self, c: rl_canvas.Canvas, page_h: float):
        self.c = c
        self.page_h = page_h

    def _y(self, y: float) -> float:
        return (self.page_h - y) * MM

    def rect(self, x: float, y: float, w: float, h: float, fill: str = "black") -> None:
        self.c.setFillColorRGB(*((0, 0, 0) if fill == "black" else (1, 1, 1)))
        self.c.rect(x * MM, self._y(y + h), w * MM, h * MM, stroke=0, fill=1)

    def line(self, x1: float, y1: float, x2: float, y2: float, width: float = 0.25) -> None:
        self.c.setStrokeColorRGB(0, 0, 0)
        self.c.setLineWidth(width * MM)
        self.c.line(x1 * MM, self._y(y1), x2 * MM, self._y(y2))

    def text(self, x: float, y_baseline: float, s: str, size: float = SMALL_PT,
             font: str = FONT, align: str = "left") -> None:
        self.c.setFillColorRGB(0, 0, 0)
        self.c.setFont(font, size)
        y = self._y(y_baseline)
        if align == "left":
            self.c.drawString(x * MM, y, s)
        elif align == "right":
            self.c.drawRightString(x * MM, y, s)
        else:
            self.c.drawCentredString(x * MM, y, s)

    def paragraph(self, x: float, y: float, s: str, width: float, size: float = 9.0,
                  font: str = FONT, leading: float | None = None) -> float:
        """Draw wrapped text; returns the y just below the last line."""
        lead = leading if leading is not None else size * 1.3 / MM  # mm
        lines = simpleSplit(s, font, size, width * MM)
        for ln in lines:
            y += lead
            self.text(x, y, ln, size=size, font=font)
        return y

    def dashed(self, on: bool) -> None:
        self.c.setDash([2 * MM, 1.5 * MM] if on else [])


def text_width_mm(s: str, size: float, font: str = FONT) -> float:
    return stringWidth(s, font, size) / MM


def draw_tag(cv: _Canvas, x: float, y: float, fam: TagFamily, tag_id: int,
             cell_mm: float, quiet_cells: int) -> None:
    """Draw one tag (bitmap + quiet zone) with its top-left quiet corner at (x, y) mm.

    A white rectangle covers the whole outer square; every horizontal run of
    black cells becomes a sub-rectangle of one filled path.
    """
    outer = fam.outer_cells(quiet_cells) * cell_mm
    cv.rect(x, y, outer, outer, fill="white")
    c = cv.c
    c.setFillColorRGB(0, 0, 0)
    p = c.beginPath()
    for row, col, n in black_runs(fam, tag_id, quiet_cells):
        p.rect((x + col * cell_mm) * MM, cv._y(y + (row + 1) * cell_mm), n * cell_mm * MM, cell_mm * MM)
    c.drawPath(p, stroke=0, fill=1)


def draw_crop_marks(cv: _Canvas, x: float, y: float, size: float) -> None:
    """L-shaped marks just outside the four corners of the square at (x, y, size)."""
    o, L = CROP_OFFSET_MM, CROP_MM
    for cx, sx in ((x, -1), (x + size, 1)):
        for cy, sy in ((y, -1), (y + size, 1)):
            cv.line(cx + sx * o, cy, cx + sx * (o + L), cy, width=0.2)
            cv.line(cx, cy + sy * o, cx, cy + sy * (o + L), width=0.2)


def draw_scale_bar(cv: _Canvas, x: float, y: float) -> None:
    """100 mm bar with ticks at 0/50/100 mm; (x, y) is the top-left of a 14 mm band."""
    bar_y = y + 5.0
    cv.line(x, bar_y, x + SCALE_BAR_MM, bar_y, width=0.3)
    for off, lab in ((0.0, "0"), (50.0, "50"), (100.0, "100 mm")):
        cv.line(x + off, bar_y - 2.5, x + off, bar_y + 2.5, width=0.3)
        cv.text(x + off, bar_y - 3.2, lab, size=5, align="center" if off < 100 else "right")
    cv.text(
        x, bar_y + 5.5,
        "Measure this bar: it must be 100 mm. If not, disable 'fit to page' / scaling in the print dialog.",
        size=SMALL_PT,
    )


def label_line(fam: TagFamily, tag_id: int, size_mm: float) -> str:
    return f"{fam.name}  id {tag_id}  {BULLET}  {size_mm:g} mm black square  {BULLET}  {AUTHOR}"


def _fit_font(s: str, max_w: float, size: float, font: str, min_size: float = 16.0) -> float:
    while size > min_size and text_width_mm(s, size, font) > max_w:
        size -= 2
    return size


def draw_grid_label(cv: _Canvas, x: float, y: float, w: float, fam: TagFamily, tag_id: int,
                    req: TagSheetRequest) -> None:
    """Label block under a gridded tag; (x, y) = bottom-left of the quiet zone."""
    cx = x + w / 2
    if not req.label:
        cv.text(x + w, y + 2.6, f"{fam.name} #{tag_id}", size=TINY_PT, align="right")
        return
    big = str(tag_id)
    size = _fit_font(big, w, BIG_ID_PT, FONT_BOLD)
    cv.text(cx, y + 12.5, big, size=size, font=FONT_BOLD, align="center")
    line = label_line(fam, tag_id, req.tag_size_mm)
    small = _fit_font(line, w, SMALL_PT, FONT, min_size=4.0)
    cv.text(cx, y + 16.0, line, size=small, align="center")
    if req.project_name:
        cv.text(cx, y + 19.0, req.project_name, size=_fit_font(req.project_name, w, SMALL_PT, FONT, 4.0),
                align="center")


def draw_single_footer(cv: _Canvas, lay: SheetLayout, tag_id: int, req: TagSheetRequest) -> None:
    """Footer band of a one-tag page: scale bar on the left, label on the right."""
    fam = lay.family
    left = lay.margin
    right = lay.page_w - lay.margin
    band_top = lay.page_h - lay.margin - lay.footer_h
    if not req.label:
        if req.include_scale_check:
            draw_scale_bar(cv, left, band_top)
        cv.text(right, lay.page_h - lay.margin - 0.5, f"{fam.name} #{tag_id}", size=TINY_PT, align="right")
        return
    # label row
    label_top = band_top
    bar_top = band_top + FOOTER_SINGLE_MM if lay.footer_stacked else band_top + 2.0
    if req.include_scale_check:
        draw_scale_bar(cv, left, bar_top)
    big = str(tag_id)
    big_w = text_width_mm(big, BIG_ID_PT, FONT_BOLD)
    cv.text(right, label_top + 13.5, big, size=BIG_ID_PT, font=FONT_BOLD, align="right")
    tx = right - big_w - 4.0
    avail = tx - left - (SCALE_BAR_MM + 6.0 if (req.include_scale_check and not lay.footer_stacked) else 0.0)
    line = label_line(fam, tag_id, req.tag_size_mm)
    cv.text(tx, label_top + 8.5, line, size=_fit_font(line, max(avail, 20.0), SMALL_PT, FONT, 4.0),
            align="right")
    if req.project_name:
        cv.text(tx, label_top + 12.0, req.project_name,
                size=_fit_font(req.project_name, max(avail, 20.0), SMALL_PT, FONT, 4.0), align="right")
    cv.text(tx, label_top + 15.5, "id", size=SMALL_PT, align="right")


# --------------------------------------------------------------------------
# Guide page
# --------------------------------------------------------------------------
PROTOCOL = [
    "Print at 100 % / 'actual size'. Disable 'fit to page', 'shrink to printable area' and any scaling.",
    "Measure the 100 mm scale bar on a printed tag page with a ruler. If it is not 100 mm, fix the print "
    "settings and reprint; a wrong scale gives a wrong model size.",
    "Mount every tag flat on rigid backing (foam board, cardboard, clipboard). Bent or wavy tags spoil the "
    "scale and level estimates. Matte paper is best; avoid lamination and glossy sheets (glare).",
    "Place 8-16 tags around the space (more for large or multi-room spaces) at varied heights between "
    "0.3 m and 1.8 m. Put some on the floor: floor tags let Splat360 level the scene.",
    "Spread them out so that at least 3 tags are visible from most positions along your walk. Corners "
    "and doorways are good spots; avoid clustering them on one wall.",
    "Avoid glare, shadows across a tag, partial occlusion by furniture and placement behind glass. "
    "Tags should face the areas you walk through, not the ceiling or a wall.",
    "Keep every tag in place and unchanged for the whole shoot. Do not move, swap or add tags mid-recording.",
    "Tick each id in the table below and note where it went. In the project settings enter the same "
    "family and tag size as printed on this sheet (the size is the black square edge).",
]


def draw_placement_diagram(cv: _Canvas, x: float, y: float, w: float, h: float) -> None:
    """A room seen from above: wall tags, floor tags and a walking loop."""
    cv.line(x, y, x + w, y, 0.4)
    cv.line(x, y + h, x + w, y + h, 0.4)
    cv.line(x, y, x, y + h, 0.4)
    cv.line(x + w, y, x + w, y + h, 0.4)
    # doorway gap on the bottom wall
    cv.rect(x + w * 0.62, y + h - 0.6, w * 0.14, 1.2, fill="white")
    s = 3.0
    # wall tags (drawn on the inside of the walls)
    wall_tags = [
        (x + w * 0.15, y + 0.6), (x + w * 0.5, y + 0.6), (x + w * 0.85, y + 0.6),
        (x + w * 0.2, y + h - 0.6 - s), (x + w * 0.45, y + h - 0.6 - s),
        (x + 0.6, y + h * 0.3), (x + 0.6, y + h * 0.7),
        (x + w - 0.6 - s, y + h * 0.25), (x + w - 0.6 - s, y + h * 0.75),
    ]
    for tx, ty in wall_tags:
        cv.rect(tx - s / 2, ty, s, s, fill="black")
    # floor tags (outlined squares with a dot)
    for fx, fy in [(x + w * 0.3, y + h * 0.5), (x + w * 0.65, y + h * 0.35), (x + w * 0.6, y + h * 0.7)]:
        cv.rect(fx - s / 2, fy - s / 2, s, s, fill="black")
        cv.rect(fx - s / 2 + 0.7, fy - s / 2 + 0.7, s - 1.4, s - 1.4, fill="white")
    # walking loop: dashed rounded rectangle with arrow heads
    cv.dashed(True)
    ix, iy, iw, ih = x + w * 0.18, y + h * 0.2, w * 0.64, h * 0.6
    c = cv.c
    c.setLineWidth(0.35 * MM)
    c.roundRect(ix * MM, cv._y(iy + ih), iw * MM, ih * MM, 6 * MM, stroke=1, fill=0)
    cv.dashed(False)
    # arrow heads on the loop (clockwise)
    ax, ay = ix + iw * 0.5, iy
    cv.line(ax - 2.5, ay - 1.5, ax, ay, 0.35)
    cv.line(ax - 2.5, ay + 1.5, ax, ay, 0.35)
    ax, ay = ix + iw * 0.5, iy + ih
    cv.line(ax + 2.5, ay - 1.5, ax, ay, 0.35)
    cv.line(ax + 2.5, ay + 1.5, ax, ay, 0.35)
    # operator with camera on a pole
    px, py = ix + iw, iy + ih * 0.5
    c.setLineWidth(0.35 * MM)
    c.circle(px * MM, cv._y(py), 1.3 * MM, stroke=1, fill=1)
    cv.line(px, py + 1.3, px, py + 5.0, 0.35)
    cv.line(px - 2.0, py + 7.0, px, py + 5.0, 0.35)
    cv.line(px + 2.0, py + 7.0, px, py + 5.0, 0.35)
    # legend
    ly = y + h + 4.5
    cv.rect(x, ly - 2.4, 2.4, 2.4, fill="black")
    cv.text(x + 4, ly, "wall tags, 0.3-1.8 m high", size=6.5)
    cv.rect(x + 42, ly - 2.4, 2.4, 2.4, fill="black")
    cv.rect(x + 42.6, ly - 1.8, 1.2, 1.2, fill="white")
    cv.text(x + 46, ly, "floor tags (level the scene)", size=6.5)
    ly += 4
    cv.dashed(True)
    cv.line(x, ly - 1.0, x + 6, ly - 1.0, 0.35)
    cv.dashed(False)
    cv.text(x + 8, ly, "walk a slow loop about 1-1.5 m from the walls, camera at 1.5-1.8 m", size=6.5)


def draw_guide_pages(cv: _Canvas, lay: SheetLayout, req: TagSheetRequest) -> None:
    fam = lay.family
    m = lay.margin
    left, right = m, lay.page_w - m
    avail_w = right - left
    y = m
    cv.text(left, y + 7, "Splat360 Studio", size=11, font=FONT_BOLD)
    y += 7
    cv.text(left, y + 8, "AprilTag placement guide", size=20, font=FONT_BOLD)
    y += 12
    if req.project_name:
        cv.text(left, y + 4, f"Project: {req.project_name}", size=9)
        y += 5
    ids = lay.ids
    id_desc = (
        f"{ids[0]}..{ids[-1]}" if ids == list(range(ids[0], ids[0] + len(ids)))
        else ", ".join(str(i) for i in ids[:12]) + (" ..." if len(ids) > 12 else "")
    )
    settings = [
        f"Family: {fam.name}     Tags: {len(ids)} (ids {id_desc})",
        f"Black square: {req.tag_size_mm:g} mm  ({lay.cell_mm:.3f} mm per cell, "
        f"{lay.tag_outer_mm:.0f} mm including the white quiet zone)",
        f"Page: {req.page} {req.orientation}, {lay.tags_per_page} tag(s) per page, "
        f"{lay.tag_pages} tag page(s)   {BULLET}   enter '{req.tag_size_mm:g} mm' as the tag size in the project settings",
    ]
    for s in settings:
        y += 4.5
        cv.text(left, y, s, size=8)
    y += 4

    # protocol (left column) + diagram (right column)
    diag_w = min(78.0, avail_w * 0.4)
    text_w = avail_w - diag_w - 8
    y_text = y
    cv.text(left, y_text + 5, "Protocol", size=11, font=FONT_BOLD)
    y_text += 7
    for i, step in enumerate(PROTOCOL, 1):
        cv.text(left, y_text + 3.2, f"{i}.", size=7.5, font=FONT_BOLD)
        y_text = cv.paragraph(left + 5, y_text, step, text_w - 5, size=7.5, leading=3.2)
        y_text += 1.2
    dx = right - diag_w
    cv.text(dx, y + 5, "Placement (top view)", size=11, font=FONT_BOLD)
    draw_placement_diagram(cv, dx, y + 9, diag_w, diag_w * 0.7)
    y = max(y_text, y + 9 + diag_w * 0.7 + 14) + 4
    y = max(y, m + GUIDE_HEADER_MM)

    # id table with checkbox and location columns, multi-column, overflowing to more pages
    cv.text(left, y + 5, "Tags on this sheet", size=11, font=FONT_BOLD)
    y += 7
    idx = 0
    page_no = 1
    while idx < len(ids):
        table_h = (lay.page_h - m) - y
        set_w = sum(GUIDE_TABLE_COL_MM)
        ncols = max(1, int((avail_w + GUIDE_TABLE_GAP_MM) // (set_w + GUIDE_TABLE_GAP_MM)))
        rows = max(0, int(table_h // GUIDE_ROW_MM) - 1)
        if rows <= 0:
            rows = 1
        for col in range(ncols):
            if idx >= len(ids):
                break
            cx = left + col * (set_w + GUIDE_TABLE_GAP_MM)
            c0, c1, c2 = GUIDE_TABLE_COL_MM
            cv.text(cx, y + 4, "id", size=7, font=FONT_BOLD)
            cv.text(cx + c0, y + 4, "placed", size=7, font=FONT_BOLD)
            cv.text(cx + c0 + c1, y + 4, "location", size=7, font=FONT_BOLD)
            cv.line(cx, y + 5.2, cx + set_w, y + 5.2, 0.2)
            ry = y + GUIDE_ROW_MM
            for _ in range(rows):
                if idx >= len(ids):
                    break
                cv.text(cx, ry + 4, str(ids[idx]), size=8, font=FONT_BOLD)
                bx, by = cx + c0 + 3, ry + 1.2
                cv.c.setLineWidth(0.25 * MM)
                cv.c.rect(bx * MM, cv._y(by + 3.6), 3.6 * MM, 3.6 * MM, stroke=1, fill=0)
                cv.line(cx + c0 + c1, ry + 4.6, cx + set_w - 2, ry + 4.6, 0.15)
                ry += GUIDE_ROW_MM
                idx += 1
        if idx < len(ids):
            cv.c.showPage()
            page_no += 1
            cv.text(left, m + 6, f"Tags on this sheet (continued, page {page_no})", size=11, font=FONT_BOLD)
            y = m + 8
    cv.c.showPage()


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------
def render_tag_sheet(req: TagSheetRequest) -> bytes:
    """Render a printable PDF for ``req`` and return its bytes.

    Raises ``ValueError`` when an id is out of range for the family or when
    the tag (with quiet zone) does not fit on the page; the message names the
    largest size that fits so the API layer can return it as a 422 detail.
    """
    lay = compute_layout(req)
    if not lay.fits:
        raise ValueError(lay.message)
    fam = lay.family

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(lay.page_w * MM, lay.page_h * MM), pageCompression=1)
    c.setTitle(f"AprilTag sheet {fam.name} {req.tag_size_mm:g} mm" + (f" - {req.project_name}" if req.project_name else ""))
    c.setAuthor(AUTHOR)
    c.setCreator(AUTHOR)
    c.setSubject(f"{len(lay.ids)} {fam.name} AprilTags, {req.tag_size_mm:g} mm black square, page {req.page}")
    c.setKeywords(["AprilTag", fam.name, "Splat360", "Gaussian splat"])
    cv = _Canvas(c, lay.page_h)

    if req.include_guide:
        draw_guide_pages(cv, lay, req)

    if lay.mode == "grid":
        for start in range(0, len(lay.ids), lay.tags_per_page):
            chunk = lay.ids[start:start + lay.tags_per_page]
            for k, tag_id in enumerate(chunk):
                col, row = k % lay.cols, k // lay.cols
                x = lay.origin_x + col * (lay.tag_outer_mm + lay.gap_x)
                y = lay.origin_y + row * (lay.tag_outer_mm + lay.label_h + lay.gap_y)
                draw_tag(cv, x, y, fam, tag_id, lay.cell_mm, lay.quiet_cells)
                draw_crop_marks(cv, x, y, lay.tag_outer_mm)
                draw_grid_label(cv, x, y + lay.tag_outer_mm, lay.tag_outer_mm, fam, tag_id, req)
            if req.include_scale_check:
                draw_scale_bar(cv, lay.margin, lay.page_h - lay.margin - FOOTER_SCALE_MM)
            c.showPage()
    else:
        for tag_id in lay.ids:
            draw_tag(cv, lay.origin_x, lay.origin_y, fam, tag_id, lay.cell_mm, lay.quiet_cells)
            if lay.margin >= CROP_MM + CROP_OFFSET_MM:
                draw_crop_marks(cv, lay.origin_x, lay.origin_y, lay.tag_outer_mm)
            draw_single_footer(cv, lay, tag_id, req)
            c.showPage()

    c.save()
    return buf.getvalue()

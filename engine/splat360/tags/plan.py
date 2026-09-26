"""Recommend how many tags to print, how big, and where to put them.

Heuristics
----------
Detection is reliable when the black square spans at least ~30 px in the
pinhole views. Views are 1600 px wide at 100° FOV, so the focal length is
about 671 px and the maximum reliable distance is
``671 * size_m / 30``: 130 mm -> 2.9 m, 200 mm -> 4.5 m, 300 mm -> 6.7 m.
Tags are square, so the shorter page edge is the limit: Letter/A4 fit
130 mm, Tabloid 170 mm, A3 180 mm, A2 260 mm (10 mm margins, one quiet cell).
Tags should be spaced so that several are visible from any point on the
walk, so spacing is ~0.6 x that distance and the count is the walk length
divided by the spacing, clamped to a per-scene range.
"""
from __future__ import annotations

import math

from ..models import TagPlan, TagPlanRequest
from .families import get_family

FOCAL_PX_1600_100 = 671.0
MIN_TAG_PX = 30.0
PAGES_MM = {"letter": (215.9, 279.4), "a4": (210.0, 297.0), "tabloid": (279.4, 431.8), "a3": (297.0, 420.0),
            "a2": (420.0, 594.0), "a1": (594.0, 841.0), "a0": (841.0, 1189.0)}
COUNT_RANGE = {"room": (8, 24), "multi_room": (12, 40), "outdoor": (16, 48), "object": (6, 12)}


def max_tag_size_for_printer(printer_max_mm: float, family: str = "tag36h11", margin_mm: float = 10.0,
                             quiet_cells: int = 1) -> float:
    fam = get_family(family)
    outer_cells = fam.total_width + 2 * quiet_cells
    usable = printer_max_mm - 2 * margin_mm
    size = usable * fam.width_at_border / outer_cells
    return max(0.0, math.floor(size / 10) * 10)


def page_for_size(size_mm: float, family: str = "tag36h11") -> tuple[str, str]:
    """Smallest standard page whose short edge fits the tag (portrait)."""
    for page in ("letter", "a4", "tabloid", "a3", "a2", "a1", "a0"):
        short, _ = PAGES_MM[page]
        if max_tag_size_for_printer(short, family) >= size_mm:
            return page, "portrait"
    return "a0", "portrait"


def plan_tags(req: TagPlanRequest) -> TagPlan:
    family = "tag36h11"
    size = max(100.0, max_tag_size_for_printer(req.printer_max_mm, family))
    warnings: list[str] = []
    if max_tag_size_for_printer(req.printer_max_mm, family) < 100:
        warnings.append(f"Your printer's {req.printer_max_mm:.0f} mm edge only fits {max_tag_size_for_printer(req.printer_max_mm, family):.0f} mm "
                        f"tags; 100 mm is the practical minimum. Use a print shop for larger tags.")
    max_dist = FOCAL_PX_1600_100 * (size / 1000.0) / MIN_TAG_PX
    spacing = 0.6 * max_dist
    lo, hi = COUNT_RANGE[req.scene]
    count = int(min(hi, max(lo, math.ceil(req.walk_length_m / spacing))))
    # Larger areas need more coverage even with a short walk.
    count = int(min(hi, max(count, math.ceil(math.sqrt(req.area_m2) * 1.5))))
    page, orientation = page_for_size(size, family)
    tips = [
        "Mount tags flat on rigid backing (foam board or cardboard); a curled tag breaks the scale estimate.",
        "Spread tags around the whole space, on walls and the floor, at heights between 0.3 m and 1.8 m.",
        "From most points on your walk at least 3 tags should be visible and closer than "
        f"{max_dist:.1f} m ({size:.0f} mm tags at 1600 px views).",
        "Put a few tags on the floor: they define the ground plane so the scene comes out level.",
        "Avoid glossy laminate, direct sunlight glare and half-hidden tags; matte paper is best.",
        "Leave the tags in place for the whole shoot and do not reuse an id twice in one scene.",
        "Enter the exact printed size in the project settings; measure the black square after printing.",
    ]
    if req.scene == "outdoor":
        tips.append("Outdoors, prefer the largest tags you can print and place them at corners and along paths.")
        if size < 200:
            warnings.append(f"{size:.0f} mm tags are only detected within ~{max_dist:.1f} m; outdoor scenes usually need 200 mm or larger.")
    if req.ceiling_height_m > 4:
        warnings.append("High ceilings: add a few tags above 2.5 m (on columns or shelving) so the upper structure is scaled too.")
    if req.scene == "object":
        tips.append("For an object, place tags on the surface it stands on, evenly around it, not on the object itself.")
    return TagPlan(recommended_count=count, recommended_size_mm=float(size), family=family, page=page,
                   orientation=orientation, spacing_m=round(spacing, 2), max_view_distance_m=round(max_dist, 2), placement_tips=tips,
                   warnings=warnings)

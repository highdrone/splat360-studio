import io
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from splat360.models import TagPlanRequest, TagSheetRequest
from splat360.tags.detect import TagDetector, detect_in_directory, load_observations, save_observations, summarize
from splat360.tags.families import get_family, list_families
from splat360.tags.plan import max_tag_size_for_printer, plan_tags
from splat360.tags.sheet import quiet_cells_for, render_tag_sheet, sheet_layout
from splat360.tags.svg import render_tag_png, render_tag_svg


@pytest.mark.parametrize("fam", [f.name for f in list_families()])
def test_png_roundtrip(fam):
    f = get_family(fam)
    det = TagDetector(fam)
    for tid in (0, 7, min(29, f.ncodes - 1)):
        png = render_tag_png(fam, tid, px=480)
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
        obs = det.detect(img, "v", 0, "front", 10.0)
        assert len(obs) == 1 and obs[0].tag_id == tid and obs[0].hamming == 0
        c = np.array(obs[0].corners)
        cells = f.total_width + 2 * quiet_cells_for(f)
        side = np.linalg.norm(c[1] - c[0])
        assert abs(side / (480 / cells) - f.width_at_border) < 0.5


def test_corner_order_is_bl_br_tr_tl():
    img = cv2.imdecode(np.frombuffer(render_tag_png("tag36h11", 5, px=400), np.uint8), cv2.IMREAD_GRAYSCALE)
    c = np.array(TagDetector().detect(img)[0].corners)
    bl, br, tr, tl = c
    assert bl[0] < br[0] and tl[0] < tr[0]          # left < right
    assert bl[1] > tl[1] and br[1] > tr[1]          # bottom has larger y


def test_detect_in_directory_and_summary(tmp_path):
    rng = np.random.default_rng(0)
    views = tmp_path / "views"
    for face in ("front", "down"):
        (views / face).mkdir(parents=True)
    (views / "masks" / "down").mkdir(parents=True)
    (views / "masks" / "down" / "00000.jpg.png").write_bytes(b"not an image")
    for idx in range(3):
        bg = rng.integers(0, 255, (600, 800), dtype=np.uint8)
        for k, tid in enumerate((1, 2, 3)):
            tag = get_family("tag36h11").image(tid, px_per_cell=8 + 3 * k, quiet_cells=1)
            y, x = 40 + 180 * k, 60 + 220 * k
            bg[y:y + tag.shape[0], x:x + tag.shape[1]] = tag
        cv2.imwrite(str(views / "front" / f"{idx:05d}.jpg"), bg, [cv2.IMWRITE_JPEG_QUALITY, 97])
    cv2.imwrite(str(views / "down" / "00000.jpg"), np.full((600, 800), 128, np.uint8))
    calls = []
    obs = detect_in_directory(views, "tag36h11", 20.0, None, lambda d, t: calls.append((d, t)), threads=2)
    assert calls[-1] == (4, 4)
    assert {o.tag_id for o in obs} == {1, 2, 3}
    assert len(obs) == 9
    assert all(o.face == "front" for o in obs)
    obs2 = detect_in_directory(views, "tag36h11", 20.0, {2}, None, threads=1)
    assert {o.tag_id for o in obs2} == {2}
    s = summarize(obs, "tag36h11", 130.0, 4)
    assert s.unique_tags == 3 and s.views_with_tags == 3 and s.per_tag_counts == {1: 3, 2: 3, 3: 3}
    assert s.weak_tags == [] and abs(s.coverage_fraction - 0.75) < 1e-9
    save_observations(tmp_path / "o.json", obs)
    back = load_observations(tmp_path / "o.json")
    assert back == obs


def test_sheet_layouts_and_errors():
    for page, orient, size, expect_fit in (("letter", "portrait", 130, True), ("letter", "portrait", 200, False),
                                           ("tabloid", "portrait", 170, True), ("a3", "portrait", 180, True),
                                           ("tabloid", "landscape", 200, False), ("a0", "portrait", 500, True)):
        lay = sheet_layout(TagSheetRequest(page=page, orientation=orient, tag_size_mm=size, count=6))
        assert lay["fits"] == expect_fit, lay
        if expect_fit:
            pdf = render_tag_sheet(TagSheetRequest(page=page, orientation=orient, tag_size_mm=size, count=6,
                                                   project_name="T"))
            assert pdf.startswith(b"%PDF")
            assert pdf.count(b"/Type /Page") - pdf.count(b"/Type /Pages") == lay["pages"]
        else:
            with pytest.raises(ValueError, match="largest size"):
                render_tag_sheet(TagSheetRequest(page=page, orientation=orient, tag_size_mm=size))
    small = sheet_layout(TagSheetRequest(page="letter", tag_size_mm=50, count=12))
    assert small["tags_per_page"] > 1


@pytest.mark.skipif(shutil.which("pdftoppm") is None, reason="poppler not installed")
def test_sheet_physical_size(tmp_path):
    size_mm, dpi = 130.0, 100
    pdf = render_tag_sheet(TagSheetRequest(page="letter", tag_size_mm=size_mm, count=1, include_guide=False))
    (tmp_path / "s.pdf").write_bytes(pdf)
    subprocess.run(["pdftoppm", "-r", str(dpi), "-gray", "-png", str(tmp_path / "s.pdf"), str(tmp_path / "p")], check=True)
    png = next(tmp_path.glob("p*.png"))
    img = cv2.imread(str(png), cv2.IMREAD_GRAYSCALE)
    obs = TagDetector().detect(img, "p", 0, "p", 10.0)
    assert len(obs) == 1 and obs[0].tag_id == 0
    c = np.array(obs[0].corners)
    side_px = np.mean([np.linalg.norm(c[(i + 1) % 4] - c[i]) for i in range(4)])
    expected = size_mm / 25.4 * dpi
    assert abs(side_px - expected) / expected < 0.01, (side_px, expected)


def test_svg():
    s = render_tag_svg("tag36h11", 4, 130.0)
    assert s.startswith("<svg") or s.startswith("<?xml")
    assert 'data-id="4"' in s and 'mm"' in s
    # the black square is 130 mm; the whole image adds the white ring and quiet zone (10+2 cells of 8)
    assert 'width="195mm"' in s


def test_plan_monotonic():
    a = plan_tags(TagPlanRequest(area_m2=30, walk_length_m=15, printer_max_mm=216))
    b = plan_tags(TagPlanRequest(area_m2=200, walk_length_m=60, printer_max_mm=216))
    c = plan_tags(TagPlanRequest(area_m2=30, walk_length_m=15, printer_max_mm=297))
    assert a.recommended_size_mm == 130 and a.page == "letter" and a.orientation == "portrait"
    assert b.recommended_count >= a.recommended_count
    assert c.recommended_size_mm == 180 and c.page == "a3"
    assert 8 <= a.recommended_count <= 24
    assert max_tag_size_for_printer(215.9) == 130 and max_tag_size_for_printer(279.4) == 170
    out = plan_tags(TagPlanRequest(scene="outdoor", printer_max_mm=210))
    assert out.warnings

import numpy as np

from splat360.colmap.model import (
    Camera,
    Image,
    Model,
    Point3D,
    apply_similarity,
    read_model,
    write_model_bin,
    write_model_txt,
)
from splat360.colmap.pairs import build_pairs
from splat360.pipeline import geometry as G

FACES = ["front", "right", "back", "left", "up", "down"]


def test_pairs_unique_sorted_and_reasonable():
    pairs = build_pairs(list(range(20)), FACES, "cube6", 4, 5, "jpg")
    assert pairs == sorted(set(pairs))
    assert all(a < b for a, b in pairs)
    # within-frame neighbours present, opposite faces absent
    assert ("front/00000.jpg", "right/00000.jpg") in pairs
    assert ("back/00000.jpg", "front/00000.jpg") not in pairs
    # same face across window present
    assert ("front/00000.jpg", "front/00004.jpg") in pairs
    assert ("front/00000.jpg", "front/00006.jpg") not in pairs  # outside window and not both anchors
    # loop closure between anchors 0 and 10
    assert ("front/00000.jpg", "left/00010.jpg") in pairs


def _model():
    cams = {1: Camera(1, "PINHOLE", 800, 800, [600.0, 600.0, 400.0, 400.0])}
    ims = {}
    for i, spec in enumerate(G.CUBE6):
        R = G.cam_from_rig(spec)
        q = G.quat_wxyz_from_matrix(R)
        t = np.array([0.1 * i, 0.0, 0.5])
        ims[i + 1] = Image(i + 1, q, t, 1, f"{spec.name}/00000.jpg", np.array([[1.0, 2.0], [3.5, 4.5]]),
                           np.array([1, -1]))
    pts = {1: Point3D(1, np.array([1.0, 2.0, 3.0]), np.array([10, 20, 30], dtype=np.uint8), 0.5, [(1, 0), (2, 1)])}
    return Model(cams, ims, pts)


def test_model_bin_txt_roundtrip(tmp_path):
    m = _model()
    write_model_bin(m, tmp_path / "bin")
    write_model_txt(m, tmp_path / "txt")
    for d in ("bin", "txt"):
        r = read_model(tmp_path / d)
        assert r.cameras[1].params == m.cameras[1].params
        assert len(r.images) == 6
        im = r.images[3]
        assert im.name == "back/00000.jpg"
        assert np.allclose(im.qvec, m.images[3].qvec)
        assert np.allclose(im.tvec, m.images[3].tvec)
        assert np.allclose(im.xys, m.images[3].xys)
        assert list(im.point3D_ids) == [1, -1]
        p = r.points[1]
        assert np.allclose(p.xyz, [1, 2, 3]) and p.track == [(1, 0), (2, 1)]


def test_apply_similarity_keeps_projection():
    m = _model()
    s, R, t = 2.5, G.rot_y(33) @ G.rot_x(-12), np.array([1.0, -2.0, 0.3])
    m2 = apply_similarity(m, s, R, t)
    X = m.points[1].xyz
    X2 = m2.points[1].xyz
    for iid in m.images:
        a, b = m.images[iid], m2.images[iid]
        xa = a.R @ X + a.tvec
        xb = b.R @ X2 + b.tvec
        assert np.allclose(xa / xa[2], xb / xb[2], atol=1e-9)  # same image point
        assert np.allclose(xb, s * xa, atol=1e-9)              # depth scales

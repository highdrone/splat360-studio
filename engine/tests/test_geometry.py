import math

import numpy as np

from splat360.pipeline import geometry as G


def test_equirect_roundtrip():
    W, H = 2048, 1024
    u = np.array([0.0, 512.0, 1023.5, 1500.0, 2047.0])
    v = np.array([0.0, 256.0, 511.5, 700.0, 1023.0])
    d = G.equirect_to_dirs(u, v, W, H)
    assert np.allclose(np.linalg.norm(d, axis=-1), 1)
    u2, v2 = G.dirs_to_equirect(d, W, H)
    assert np.allclose(u2, u, atol=1e-6)
    assert np.allclose(v2, v, atol=1e-6)


def test_front_view_centre_maps_to_equirect_centre():
    W, H, S = 2048, 1024, 512
    mx, my = G.view_remap(G.ViewSpec("front", 0, 0), S, 90, W, H)
    assert abs(mx[S // 2, S // 2] - (W / 2 - 0.5)) < 1.0
    assert abs(my[S // 2, S // 2] - (H / 2 - 0.5)) < 1.0
    # right face centre maps to lon=+90 -> u = 3W/4
    mx, my = G.view_remap(G.ViewSpec("right", 90, 0), S, 90, W, H)
    assert abs(mx[S // 2, S // 2] - (0.75 * W - 0.5)) < 1.0
    # up face centre maps to v=0
    mx, my = G.view_remap(G.ViewSpec("up", 0, 90), S, 90, W, H)
    assert my[S // 2, S // 2] < 1.0


def test_rotations_are_orthonormal_and_quaternion_roundtrip():
    for spec in G.CUBE6 + G.RING8:
        R = G.rig_from_cam(spec)
        assert np.allclose(R @ R.T, np.eye(3), atol=1e-12)
        q = G.quat_wxyz_from_matrix(R)
        assert np.allclose(G.matrix_from_quat_wxyz(q), R, atol=1e-10)
        assert q[0] >= 0


def test_focal_from_fov():
    assert math.isclose(G.focal_px(1600, 90), 800.0)
    assert G.focal_px(1600, 100) < 800


def test_nadir_mask_only_on_down_face():
    for spec in G.CUBE6:
        m = G.nadir_mask(spec, 256, 100, 30)
        if spec.name == "down":
            assert m is not None and (m == 0).mean() > 0.1
        else:
            assert m is None


def test_neighbours_symmetric():
    for layout in ("cube6", "ring8"):
        nb = G.neighbours(layout)
        for a, lst in nb.items():
            for b in lst:
                assert a in nb[b]

import numpy as np

from splat360.pipeline.extract import select_keyframes
from splat360.train.ply import SH_C0, ply_to_splat, read_gaussian_ply, splat_count, write_gaussian_ply


def test_select_keyframes_even_and_sharp():
    rng = np.random.default_rng(0)
    scores = [(i, i / 30, float(rng.uniform(50, 100))) for i in range(300)]
    # inject blurry frames every 10th
    scores = [(i, t, 5.0 if i % 10 == 0 else s) for i, t, s in scores]
    chosen = select_keyframes(scores, 30, 0.3)
    assert len(chosen) == 30
    assert all(c[2] > 5.0 for c in chosen)
    idx = [c[0] for c in chosen]
    assert idx == sorted(idx)
    gaps = np.diff(idx)
    assert gaps.max() <= 20 and gaps.min() >= 1


def test_select_keyframes_small_inputs():
    assert select_keyframes([], 10, 0.2) == []
    s = [(0, 0.0, 1.0), (1, 0.1, 2.0)]
    assert len(select_keyframes(s, 10, 0.2)) == 2


def test_gaussian_ply_roundtrip_and_splat(tmp_path):
    n = 50
    rng = np.random.default_rng(1)
    xyz = rng.normal(size=(n, 3)).astype(np.float32)
    rgb = rng.uniform(size=(n, 3)).astype(np.float32)
    f_dc = (rgb - 0.5) / SH_C0
    f_rest = rng.normal(size=(n, 45)).astype(np.float32)
    opac = rng.normal(size=(n, 1)).astype(np.float32)
    scale = np.log(rng.uniform(0.01, 0.1, size=(n, 3))).astype(np.float32)
    rot = rng.normal(size=(n, 4)).astype(np.float32)
    p = tmp_path / "s.ply"
    write_gaussian_ply(p, xyz, f_dc, f_rest, opac, scale, rot)
    cols = read_gaussian_ply(p)
    assert splat_count(p) == n
    assert np.allclose(cols["x"], xyz[:, 0]) and np.allclose(cols["f_rest_44"], f_rest[:, 44])
    out = tmp_path / "s.splat"
    assert ply_to_splat(p, out) == n
    assert out.stat().st_size == 32 * n
    rec = np.frombuffer(out.read_bytes(), dtype=[("pos", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4)])
    # positions preserved as a set (order changes by importance)
    assert np.allclose(np.sort(rec["pos"][:, 0]), np.sort(xyz[:, 0]))
    # colour decoded within 1/255
    i = int(np.argmin(np.abs(rec["pos"][:, 0] - xyz[0, 0])))
    assert np.all(np.abs(rec["rgba"][i, :3] / 255.0 - rgb[0]) < 2 / 255)

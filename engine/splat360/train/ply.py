"""Gaussian-splat PLY reading/writing and conversion to the ``.splat`` format."""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np

SH_C0 = 0.28209479177387814


def write_gaussian_ply(path: Path, xyz: np.ndarray, f_dc: np.ndarray, f_rest: np.ndarray | None,
                       opacity: np.ndarray, scale: np.ndarray, rot: np.ndarray) -> None:
    n = len(xyz)
    n_rest = 0 if f_rest is None else f_rest.shape[1]
    props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    props += [f"f_rest_{i}" for i in range(n_rest)]
    props += ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    dtype = np.dtype([(p, "<f4") for p in props])
    arr = np.zeros(n, dtype=dtype)
    arr["x"], arr["y"], arr["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    arr["f_dc_0"], arr["f_dc_1"], arr["f_dc_2"] = f_dc[:, 0], f_dc[:, 1], f_dc[:, 2]
    for i in range(n_rest):
        arr[f"f_rest_{i}"] = f_rest[:, i]
    arr["opacity"] = opacity[:, 0]
    for i in range(3):
        arr[f"scale_{i}"] = scale[:, i]
    for i in range(4):
        arr[f"rot_{i}"] = rot[:, i]
    header = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n" + \
        "".join(f"property float {p}\n" for p in props) + "end_header\n"
    with open(path, "wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(arr.tobytes())


def read_gaussian_ply(path: Path) -> dict[str, np.ndarray]:
    """Read a binary little-endian 3DGS PLY into a dict of named columns."""
    with open(path, "rb") as fh:
        header = b""
        while not header.endswith(b"end_header\n"):
            chunk = fh.readline()
            if not chunk:
                raise ValueError("bad PLY header")
            header += chunk
        text = header.decode("ascii", "replace")
        if "binary_little_endian" not in text:
            raise ValueError("only binary_little_endian PLY is supported")
        m = re.search(r"element vertex (\d+)", text)
        if not m:
            raise ValueError("no vertex element")
        n = int(m.group(1))
        props = []
        in_vertex = False
        for line in text.splitlines():
            if line.startswith("element"):
                in_vertex = line.startswith("element vertex")
            elif line.startswith("property") and in_vertex:
                _, typ, name = line.split()[:3]
                props.append((name, {"float": "<f4", "float32": "<f4", "double": "<f8", "uchar": "u1",
                                     "uint8": "u1", "int": "<i4", "uint": "<u4"}[typ]))
        dtype = np.dtype(props)
        data = np.frombuffer(fh.read(n * dtype.itemsize), dtype=dtype)
    return {name: data[name] for name, _ in props}


def ply_to_splat(ply_path: Path, splat_path: Path) -> int:
    """Convert a 3DGS PLY to the antimatter15 ``.splat`` format (32 bytes per splat)."""
    cols = read_gaussian_ply(ply_path)
    n = len(cols["x"])
    xyz = np.stack([cols["x"], cols["y"], cols["z"]], axis=1).astype(np.float32)
    scales = np.exp(np.stack([cols["scale_0"], cols["scale_1"], cols["scale_2"]], axis=1).astype(np.float32))
    rgb = 0.5 + SH_C0 * np.stack([cols["f_dc_0"], cols["f_dc_1"], cols["f_dc_2"]], axis=1).astype(np.float32)
    alpha = 1.0 / (1.0 + np.exp(-cols["opacity"].astype(np.float32)))
    rot = np.stack([cols["rot_0"], cols["rot_1"], cols["rot_2"], cols["rot_3"]], axis=1).astype(np.float32)
    rot /= np.maximum(np.linalg.norm(rot, axis=1, keepdims=True), 1e-9)
    # Sort by importance (opacity * volume), largest first, as the reference converter does.
    importance = alpha * np.prod(scales, axis=1)
    order = np.argsort(-importance)
    rec = np.zeros(n, dtype=[("pos", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4)])
    rec["pos"] = xyz[order]
    rec["scale"] = scales[order]
    rec["rgba"][:, :3] = np.clip(rgb[order] * 255, 0, 255).astype(np.uint8)
    rec["rgba"][:, 3] = np.clip(alpha[order] * 255, 0, 255).astype(np.uint8)
    rec["rot"] = np.clip(rot[order] * 128 + 128, 0, 255).astype(np.uint8)
    with open(splat_path, "wb") as fh:
        fh.write(rec.tobytes())
    return n


def splat_count(ply_path: Path) -> int:
    with open(ply_path, "rb") as fh:
        head = fh.read(4096).decode("ascii", "replace")
    m = re.search(r"element vertex (\d+)", head)
    return int(m.group(1)) if m else 0

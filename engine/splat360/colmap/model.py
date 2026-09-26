"""Read and write COLMAP sparse models (text and binary formats)."""
from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import numpy as np

from ..pipeline import geometry as G


@dataclass
class Camera:
    camera_id: int
    model: str
    width: int
    height: int
    params: list[float]

    @property
    def K(self) -> np.ndarray:
        if self.model in ("PINHOLE", "OPENCV", "FULL_OPENCV", "OPENCV_FISHEYE"):
            fx, fy, cx, cy = self.params[:4]
        elif self.model in ("SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL", "SIMPLE_RADIAL_FISHEYE", "RADIAL_FISHEYE"):
            f, cx, cy = self.params[:3]
            fx = fy = f
        else:
            raise ValueError(f"Unsupported camera model {self.model}")
        return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1.0]])


@dataclass
class Image:
    image_id: int
    qvec: np.ndarray        # cam_from_world rotation (w,x,y,z)
    tvec: np.ndarray        # cam_from_world translation
    camera_id: int
    name: str
    xys: np.ndarray = field(default_factory=lambda: np.zeros((0, 2)))
    point3D_ids: np.ndarray = field(default_factory=lambda: np.zeros((0,), dtype=np.int64))

    @property
    def R(self) -> np.ndarray:
        return G.matrix_from_quat_wxyz(self.qvec)

    @property
    def center(self) -> np.ndarray:
        return -self.R.T @ self.tvec

    def cam_from_world(self) -> np.ndarray:
        T = np.eye(4)
        T[:3, :3] = self.R
        T[:3, 3] = self.tvec
        return T


@dataclass
class Point3D:
    id: int
    xyz: np.ndarray
    rgb: np.ndarray
    error: float
    track: list[tuple[int, int]]   # (image_id, point2D_idx)


@dataclass
class Model:
    cameras: dict[int, Camera]
    images: dict[int, Image]
    points: dict[int, Point3D]

    def image_by_name(self) -> dict[str, Image]:
        return {im.name: im for im in self.images.values()}

    def stats(self) -> dict:
        errs = [p.error for p in self.points.values()]
        tracks = [len(p.track) for p in self.points.values()]
        return {
            "images": len(self.images),
            "points": len(self.points),
            "mean_reprojection_error_px": float(np.mean(errs)) if errs else None,
            "mean_track_length": float(np.mean(tracks)) if tracks else None,
        }


CAMERA_MODEL_IDS = {
    0: ("SIMPLE_PINHOLE", 3), 1: ("PINHOLE", 4), 2: ("SIMPLE_RADIAL", 4), 3: ("RADIAL", 5),
    4: ("OPENCV", 8), 5: ("OPENCV_FISHEYE", 8), 6: ("FULL_OPENCV", 12), 7: ("FOV", 5),
    8: ("SIMPLE_RADIAL_FISHEYE", 4), 9: ("RADIAL_FISHEYE", 5), 10: ("THIN_PRISM_FISHEYE", 12),
}
CAMERA_MODEL_NAMES = {v[0]: (k, v[1]) for k, v in CAMERA_MODEL_IDS.items()}


def _read(fh, fmt: str):
    return struct.unpack("<" + fmt, fh.read(struct.calcsize("<" + fmt)))


# --- binary -------------------------------------------------------------
def read_cameras_bin(path: Path) -> dict[int, Camera]:
    cams = {}
    with open(path, "rb") as fh:
        (n,) = _read(fh, "Q")
        for _ in range(n):
            cid, mid, w, h = _read(fh, "iiQQ")
            name, np_ = CAMERA_MODEL_IDS[mid]
            params = list(_read(fh, "d" * np_))
            cams[cid] = Camera(cid, name, int(w), int(h), params)
    return cams


def read_images_bin(path: Path, with_points: bool = True) -> dict[int, Image]:
    ims = {}
    with open(path, "rb") as fh:
        (n,) = _read(fh, "Q")
        for _ in range(n):
            iid = _read(fh, "i")[0]
            q = np.array(_read(fh, "dddd"))
            t = np.array(_read(fh, "ddd"))
            cid = _read(fh, "i")[0]
            name = b""
            while True:
                c = fh.read(1)
                if c == b"\x00" or not c:
                    break
                name += c
            (npts,) = _read(fh, "Q")
            raw = fh.read(24 * npts)
            if with_points and npts:
                arr = np.frombuffer(raw, dtype=[("x", "<f8"), ("y", "<f8"), ("id", "<i8")])
                xys = np.stack([arr["x"], arr["y"]], axis=1)
                ids = arr["id"].astype(np.int64)
            else:
                xys, ids = np.zeros((0, 2)), np.zeros((0,), dtype=np.int64)
            ims[iid] = Image(iid, q, t, cid, name.decode("utf-8"), xys, ids)
    return ims


def read_points3d_bin(path: Path) -> dict[int, Point3D]:
    pts = {}
    with open(path, "rb") as fh:
        (n,) = _read(fh, "Q")
        for _ in range(n):
            pid = _read(fh, "Q")[0]
            xyz = np.array(_read(fh, "ddd"))
            rgb = np.array(_read(fh, "BBB"), dtype=np.uint8)
            err = _read(fh, "d")[0]
            (tl,) = _read(fh, "Q")
            raw = fh.read(8 * tl)
            track = np.frombuffer(raw, dtype="<i4").reshape(-1, 2)
            pts[pid] = Point3D(pid, xyz, rgb, err, [(int(a), int(b)) for a, b in track])
    return pts


# --- text ---------------------------------------------------------------
def read_cameras_txt(path: Path) -> dict[int, Camera]:
    cams = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        p = line.split()
        cams[int(p[0])] = Camera(int(p[0]), p[1], int(p[2]), int(p[3]), [float(x) for x in p[4:]])
    return cams


def read_images_txt(path: Path) -> dict[int, Image]:
    ims = {}
    lines = [l for l in path.read_text().splitlines() if l.strip() and not l.startswith("#")]
    for i in range(0, len(lines), 2):
        p = lines[i].split()
        iid = int(p[0])
        q = np.array([float(x) for x in p[1:5]])
        t = np.array([float(x) for x in p[5:8]])
        cid = int(p[8])
        name = " ".join(p[9:])
        pts = lines[i + 1].split() if i + 1 < len(lines) else []
        arr = np.array([float(x) for x in pts]).reshape(-1, 3) if pts else np.zeros((0, 3))
        ims[iid] = Image(iid, q, t, cid, name, arr[:, :2], arr[:, 2].astype(np.int64))
    return ims


def read_points3d_txt(path: Path) -> dict[int, Point3D]:
    pts = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        p = line.split()
        pid = int(p[0])
        xyz = np.array([float(x) for x in p[1:4]])
        rgb = np.array([int(x) for x in p[4:7]], dtype=np.uint8)
        err = float(p[7])
        tr = [int(x) for x in p[8:]]
        pts[pid] = Point3D(pid, xyz, rgb, err, list(zip(tr[0::2], tr[1::2])))
    return pts


def read_model(path: Path, with_points: bool = True) -> Model:
    path = Path(path)
    if (path / "cameras.bin").exists():
        return Model(read_cameras_bin(path / "cameras.bin"),
                     read_images_bin(path / "images.bin", with_points),
                     read_points3d_bin(path / "points3D.bin") if with_points else {})
    if (path / "cameras.txt").exists():
        return Model(read_cameras_txt(path / "cameras.txt"),
                     read_images_txt(path / "images.txt"),
                     read_points3d_txt(path / "points3D.txt") if with_points else {})
    raise FileNotFoundError(f"No COLMAP model in {path}")


def write_model_txt(model: Model, path: Path) -> None:
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    with open(path / "cameras.txt", "w") as fh:
        fh.write("# Camera list with one line of data per camera:\n#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n")
        for c in model.cameras.values():
            fh.write(f"{c.camera_id} {c.model} {c.width} {c.height} {' '.join(repr(float(p)) for p in c.params)}\n")
    with open(path / "images.txt", "w") as fh:
        fh.write("# Image list with two lines of data per image:\n#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n#   POINTS2D[] as (X, Y, POINT3D_ID)\n")
        for im in model.images.values():
            q = " ".join(repr(float(x)) for x in im.qvec)
            t = " ".join(repr(float(x)) for x in im.tvec)
            fh.write(f"{im.image_id} {q} {t} {im.camera_id} {im.name}\n")
            fh.write(" ".join(f"{x} {y} {int(i)}" for (x, y), i in zip(im.xys, im.point3D_ids)) + "\n")
    with open(path / "points3D.txt", "w") as fh:
        fh.write("# 3D point list with one line of data per point:\n#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n")
        for p in model.points.values():
            xyz = " ".join(repr(float(x)) for x in p.xyz)
            rgb = " ".join(str(int(x)) for x in p.rgb)
            tr = " ".join(f"{a} {b}" for a, b in p.track)
            fh.write(f"{p.id} {xyz} {rgb} {p.error} {tr}\n")


def write_model_bin(model: Model, path: Path) -> None:
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    with open(path / "cameras.bin", "wb") as fh:
        fh.write(struct.pack("<Q", len(model.cameras)))
        for c in model.cameras.values():
            mid, np_ = CAMERA_MODEL_NAMES[c.model]
            fh.write(struct.pack("<iiQQ", c.camera_id, mid, c.width, c.height))
            fh.write(struct.pack("<" + "d" * np_, *c.params[:np_]))
    with open(path / "images.bin", "wb") as fh:
        fh.write(struct.pack("<Q", len(model.images)))
        for im in model.images.values():
            fh.write(struct.pack("<i", im.image_id))
            fh.write(struct.pack("<dddd", *[float(x) for x in im.qvec]))
            fh.write(struct.pack("<ddd", *[float(x) for x in im.tvec]))
            fh.write(struct.pack("<i", im.camera_id))
            fh.write(im.name.encode("utf-8") + b"\x00")
            fh.write(struct.pack("<Q", len(im.xys)))
            for (x, y), i in zip(im.xys, im.point3D_ids):
                fh.write(struct.pack("<ddq", float(x), float(y), int(i)))
    with open(path / "points3D.bin", "wb") as fh:
        fh.write(struct.pack("<Q", len(model.points)))
        for p in model.points.values():
            fh.write(struct.pack("<Q", p.id))
            fh.write(struct.pack("<ddd", *[float(x) for x in p.xyz]))
            fh.write(struct.pack("<BBB", *[int(x) for x in p.rgb]))
            fh.write(struct.pack("<d", float(p.error)))
            fh.write(struct.pack("<Q", len(p.track)))
            for a, b in p.track:
                fh.write(struct.pack("<ii", int(a), int(b)))


def apply_similarity(model: Model, s: float, R: np.ndarray, t: np.ndarray) -> Model:
    """Return a copy of ``model`` with world points transformed by ``x' = s R x + t``.

    Camera poses are cam_from_world: R_c' = R_c R^T, t_c' = s t_c - R_c' t.
    """
    new_images = {}
    for im in model.images.values():
        Rc = im.R
        Rc2 = Rc @ R.T
        tc2 = s * im.tvec - Rc2 @ t
        new_images[im.image_id] = Image(im.image_id, G.quat_wxyz_from_matrix(Rc2), tc2, im.camera_id, im.name,
                                        im.xys, im.point3D_ids)
    new_points = {pid: Point3D(p.id, s * (R @ p.xyz) + t, p.rgb, p.error, p.track) for pid, p in model.points.items()}
    return Model(dict(model.cameras), new_images, new_points)


def write_points_ply(points: Iterable[Point3D], path: Path) -> int:
    pts = list(points)
    with open(path, "wb") as fh:
        header = (
            "ply\nformat binary_little_endian 1.0\n"
            f"element vertex {len(pts)}\n"
            "property float x\nproperty float y\nproperty float z\n"
            "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
        )
        fh.write(header.encode("ascii"))
        if pts:
            arr = np.zeros(len(pts), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
            xyz = np.array([p.xyz for p in pts], dtype=np.float32)
            rgb = np.array([p.rgb for p in pts], dtype=np.uint8)
            arr["x"], arr["y"], arr["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
            arr["r"], arr["g"], arr["b"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
            fh.write(arr.tobytes())
    return len(pts)

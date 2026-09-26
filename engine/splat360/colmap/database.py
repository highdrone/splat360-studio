"""Small helpers for the COLMAP SQLite database."""
from __future__ import annotations

import sqlite3
from pathlib import Path


def image_cameras(db_path: Path) -> dict[str, tuple[int, int]]:
    """Map image name -> (image_id, camera_id)."""
    con = sqlite3.connect(str(db_path))
    try:
        rows = con.execute("SELECT image_id, name, camera_id FROM images").fetchall()
    finally:
        con.close()
    return {name: (int(iid), int(cid)) for iid, name, cid in rows}


def folder_camera_ids(db_path: Path) -> dict[str, int]:
    """Map image folder prefix (e.g. 'front/') -> camera_id (single_camera_per_folder layout)."""
    out: dict[str, int] = {}
    for name, (_, cid) in image_cameras(db_path).items():
        prefix = name.split("/")[0] + "/" if "/" in name else ""
        out.setdefault(prefix, cid)
    return out


def counts(db_path: Path) -> dict[str, int]:
    con = sqlite3.connect(str(db_path))
    try:
        images = con.execute("SELECT COUNT(*) FROM images").fetchone()[0]
        kp = con.execute("SELECT COALESCE(SUM(rows),0) FROM keypoints").fetchone()[0]
        matches = con.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
        tvg = con.execute("SELECT COUNT(*) FROM two_view_geometries WHERE rows > 0").fetchone()[0]
    finally:
        con.close()
    return {"images": int(images), "keypoints": int(kp), "match_pairs": int(matches), "verified_pairs": int(tvg)}

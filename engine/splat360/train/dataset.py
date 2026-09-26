"""Assemble a COLMAP-style dataset folder that Brush and OpenSplat can read.

Layout::

    dataset/
      sparse/0/{cameras,images,points3D}.bin   aligned model
      images/<face>/<frame>.jpg                hard links to the pinhole views
      masks/<face>/<frame>.jpg.png             hard links to the masks (if any)
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from ..colmap.model import read_model, write_model_bin


def _link(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def prepare_dataset(model_dir: Path, views_dir: Path, dataset_dir: Path, *, max_images: int | None = None) -> dict:
    if dataset_dir.exists():
        shutil.rmtree(dataset_dir)
    (dataset_dir / "sparse" / "0").mkdir(parents=True)
    model = read_model(model_dir)
    names = sorted(im.name for im in model.images.values())
    if max_images and len(names) > max_images:
        keep = set(names[:: max(1, len(names) // max_images)][:max_images])
        model.images = {k: v for k, v in model.images.items() if v.name in keep}
        names = sorted(keep)
    write_model_bin(model, dataset_dir / "sparse" / "0")
    n_masks = 0
    for name in names:
        _link(views_dir / name, dataset_dir / "images" / name)
        m = views_dir / "masks" / (name + ".png")
        if m.exists():
            _link(m, dataset_dir / "masks" / (name + ".png"))
            n_masks += 1
    return {"images": len(names), "masks": n_masks, "points": len(model.points)}

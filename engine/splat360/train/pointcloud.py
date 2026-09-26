"""Fallback "trainer": converts the SfM point cloud into a splat PLY.

No optimisation happens; every sparse point becomes a small isotropic
Gaussian. It exists so the whole pipeline (and the viewer) can be exercised
on machines without a GPU trainer, and it doubles as the instant preview.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from ..colmap.model import read_model
from ..models import TrainReport, TrainSettings
from .base import ProgressCb, Trainer
from .ply import SH_C0, write_gaussian_ply


class PointCloudTrainer(Trainer):
    name = "mock"
    label = "Point cloud preview (no training)"

    def executable(self) -> Optional[str]:
        return "builtin"

    def train(self, dataset_dir: Path, out_dir: Path, settings: TrainSettings, *, cancel=None,
              on_progress: Optional[ProgressCb] = None, log: Optional[Callable[[str], None]] = None,
              metrics: Optional[Callable[[dict], None]] = None) -> TrainReport:
        t0 = time.time()
        out_dir.mkdir(parents=True, exist_ok=True)
        model = read_model(dataset_dir / "sparse" / "0")
        pts = list(model.points.values())
        n = len(pts)
        xyz = np.array([p.xyz for p in pts], dtype=np.float32).reshape(-1, 3)
        rgb = np.array([p.rgb for p in pts], dtype=np.float32).reshape(-1, 3) / 255.0
        # Point spacing -> splat radius
        if n > 1:
            centre = xyz.mean(axis=0)
            extent = np.percentile(np.linalg.norm(xyz - centre, axis=1), 90)
            radius = float(extent / max(30.0, n ** (1 / 3) * 4))
        else:
            radius = 0.01
        f_dc = (rgb - 0.5) / SH_C0
        opac = np.full((n, 1), 3.0, dtype=np.float32)   # sigmoid(3) ~ 0.95
        scales = np.full((n, 3), np.log(max(radius, 1e-4)), dtype=np.float32)
        rots = np.tile(np.array([1, 0, 0, 0], dtype=np.float32), (n, 1))
        out = out_dir / "splat.ply"
        write_gaussian_ply(out, xyz, f_dc, None, opac, scales, rots)
        if on_progress:
            on_progress(1.0, f"Wrote {n} preview splats")
        return TrainReport(backend=self.name, iterations=0, duration_s=time.time() - t0, final_splats=n,
                           ply_path=str(out), notes=["Preview only: SfM points rendered as small Gaussians. "
                                                     "Install Brush for real training."])

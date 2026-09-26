"""End-to-end test on a synthetic tagged room. Needs ffmpeg + COLMAP; runs the mock trainer.

Skipped unless SPLAT360_E2E=1 (takes several minutes on CPU).
"""
import json
import os
import time
from pathlib import Path

import numpy as np
import pytest

from splat360.util.proc import find_tool

pytestmark = pytest.mark.skipif(
    os.environ.get("SPLAT360_E2E") != "1" or not (find_tool("ffmpeg") and find_tool("colmap")),
    reason="set SPLAT360_E2E=1 with ffmpeg and colmap installed",
)


def test_full_pipeline_recovers_metric_scale(data_dir, tmp_path):
    from splat360.jobs import JobManager
    from splat360.models import JobStatus, KeyframeSettings, PipelineSettings, SfmSettings, TagSettings, TrainSettings, ViewSettings
    from splat360.pipeline.probe import probe_video
    from splat360.pipeline.stages import STAGE_FUNCTIONS
    from splat360.store import ProjectStore
    from splat360.synth import render_synthetic_clip

    video = tmp_path / "synthetic.mp4"
    gt = render_synthetic_clip(video, frames=60, width=2048)
    store = ProjectStore(data_dir)
    settings = PipelineSettings(
        keyframes=KeyframeSettings(target_count=30), views=ViewSettings(size_px=800),
        tags=TagSettings(size_mm=gt["room"]["tag_size_m"] * 1000, placement="mixed"),
        sfm=SfmSettings(window=4, loop_stride=8, max_features=4096),
        train=TrainSettings(backend="mock"))
    p = store.create("e2e", settings)
    p.source = probe_video(video)
    store.save(p)
    m = JobManager(store, STAGE_FUNCTIONS)
    job = m.submit(p, None, False)
    t0 = time.time()
    while m.get(job.id).is_active and time.time() - t0 < 3600:
        time.sleep(2)
    j = m.get(job.id)
    assert j.status == JobStatus.complete, (j.error, [(s.name, s.status, s.error) for s in j.stages])
    report = json.loads((store.paths(p.id).export / "report.json").read_text())
    assert report["sfm"]["registered_fraction"] > 0.9
    assert report["alignment"]["method"] == "tags"
    # Camera trajectory should match ground truth in metres after alignment (loop radius ~ 1.7 x 1.4 m).
    cams = json.loads((store.paths(p.id).align / "cameras.json").read_text())["frames"]
    pos = np.array([c["position"] for c in cams])
    kf = json.loads((store.paths(p.id).keyframes / "index.json").read_text())["items"]
    gt_pos = np.array([gt["cameras"][kf[c["index"]]["source_frame"]]["position"] for c in cams])
    # compare pairwise distances (alignment fixes translation/rotation up to a yaw, distances are invariant)
    d_est = np.linalg.norm(pos[:, None] - pos[None], axis=-1)
    d_gt = np.linalg.norm(gt_pos[:, None] - gt_pos[None], axis=-1)
    rel = np.abs(d_est - d_gt)[d_gt > 0.5] / d_gt[d_gt > 0.5]
    assert np.median(rel) < 0.03, f"median relative distance error {np.median(rel):.3f}"
    # floor at y=0 and cameras ~1.6 m above it (+Y down)
    assert abs(-pos[:, 1].mean() - gt["room"]["camera_height_m"]) < 0.1
    assert (store.paths(p.id).export / "splat.ply").exists()
    assert (store.paths(p.id).export / "splat.splat").exists()

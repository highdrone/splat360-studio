"""Brush trainer (https://github.com/ArthurBrussee/brush) — wgpu/Metal, runs on Apple Silicon."""
from __future__ import annotations

import math
import re
import time
from pathlib import Path
from typing import Callable, Optional

from ..models import TrainReport, TrainSettings
from ..util.proc import CancelToken, ToolError, find_tool, run_streaming
from .base import ProgressCb, Trainer

_STEPS = re.compile(r"(\d+)\s*/\s*(\d+)\s+Steps")
_REFINE = re.compile(r"Refine iter (\d+), (\d+) splats")
_EVAL = re.compile(r"Eval iter (\d+): PSNR ([\d.]+), ssim ([\d.]+)")
_ITER = re.compile(r"\biter(?:ation)?\s*[:=]?\s*(\d+)", re.I)


class BrushTrainer(Trainer):
    name = "brush"
    label = "Brush (Metal / wgpu)"
    CANDIDATES = ("brush-cli", "brush_cli", "brush", "brush_app")

    def executable(self) -> Optional[str]:
        return find_tool(self.CANDIDATES)

    def train(self, dataset_dir: Path, out_dir: Path, settings: TrainSettings, *, cancel=None,
              on_progress: Optional[ProgressCb] = None, log: Optional[Callable[[str], None]] = None,
              metrics: Optional[Callable[[dict], None]] = None) -> TrainReport:
        exe = self.executable()
        if not exe:
            raise ToolError("Brush not found. Run scripts/setup-mac.sh or see docs/INSTALL.md")
        log = log or (lambda s: None)
        out_dir.mkdir(parents=True, exist_ok=True)
        iters = int(settings.iterations)
        every = settings.checkpoint_every if settings.checkpoint_every and iters % settings.checkpoint_every == 0 else iters
        cmd = [
            exe, str(dataset_dir),
            "--total-train-iters", str(iters),
            "--max-resolution", str(settings.max_resolution),
            "--sh-degree", str(settings.sh_degree),
            "--max-splats", str(settings.max_splats),
            "--export-every", str(every),
            "--export-path", str(out_dir),
            "--export-name", "checkpoint_{iter}.ply",
            "--eval-every", str(max(1000, every)),
        ]
        if Path(exe).name in ("brush", "brush_app"):
            cmd += ["--with-viewer", "false"]
        cmd += list(settings.extra_args)
        log("$ " + " ".join(cmd))
        t0 = time.time()
        state = {"iter": 0, "splats": None, "psnr": None, "ssim": None, "last_log": 0.0}

        def on_line(line: str) -> None:
            m = _STEPS.search(line)
            if m:
                state["iter"] = int(m.group(1))
                if on_progress:
                    frac = state["iter"] / max(1, iters)
                    on_progress(min(0.99, frac), f"Training {state['iter']}/{iters} iterations"
                                + (f", {state['splats']:,} splats" if state["splats"] else ""))
                return
            m = _REFINE.search(line)
            if m:
                state["iter"], state["splats"] = int(m.group(1)), int(m.group(2))
                if metrics:
                    metrics({"iteration": state["iter"], "splats": state["splats"]})
                return
            m = _EVAL.search(line)
            if m:
                state["psnr"], state["ssim"] = float(m.group(2)), float(m.group(3))
                log(line)
                if metrics:
                    metrics({"iteration": int(m.group(1)), "psnr": state["psnr"], "ssim": state["ssim"]})
                return
            if any(k in line for k in ("error", "Error", "panic", "warning", "Warning", "Compute backend", "Loading",
                                       "Completed", "Training took", "Skipped", "⚠️", "❌")):
                log(line)
            elif time.time() - state["last_log"] > 30:
                state["last_log"] = time.time()
                log(line)

        env = {"RUST_LOG": "info", "NO_COLOR": "1"}
        run_streaming(cmd, on_line=on_line, cancel=cancel, env=env, cwd=dataset_dir.parent)
        plys = sorted(out_dir.glob("checkpoint_*.ply"), key=lambda p: int(re.findall(r"\d+", p.stem)[-1]))
        if not plys:
            # Brush may resolve a relative export path against the dataset parent.
            plys = sorted(dataset_dir.parent.rglob("checkpoint_*.ply"),
                          key=lambda p: int(re.findall(r"\d+", p.stem)[-1]))
        if not plys:
            raise ToolError("Brush finished but produced no PLY export")
        final = plys[-1]
        return TrainReport(backend=self.name, iterations=iters, duration_s=time.time() - t0,
                           final_splats=state["splats"], psnr=state["psnr"], ssim=state["ssim"],
                           ply_path=str(final), notes=[f"Brush export: {final.name}"])

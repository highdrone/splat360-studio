"""OpenSplat trainer (https://github.com/pierotofy/OpenSplat) — libtorch, MPS on Apple Silicon."""
from __future__ import annotations

import re
import time
from collections.abc import Callable
from pathlib import Path

from ..models import TrainReport, TrainSettings
from ..util.proc import ToolError, find_tool, run_streaming
from .base import ProgressCb, Trainer

_STEP = re.compile(r"Step\s+(\d+)[:/]\s*(?:loss\s*[=:]?\s*([\d.]+))?", re.IGNORECASE)


class OpenSplatTrainer(Trainer):
    name = "opensplat"
    label = "OpenSplat (libtorch / MPS)"

    def executable(self) -> str | None:
        return find_tool(["opensplat"])

    def train(self, dataset_dir: Path, out_dir: Path, settings: TrainSettings, *, cancel=None,
              on_progress: ProgressCb | None = None, log: Callable[[str], None] | None = None,
              metrics: Callable[[dict], None] | None = None) -> TrainReport:
        exe = self.executable()
        if not exe:
            raise ToolError("OpenSplat not found")
        log = log or (lambda s: None)
        out_dir.mkdir(parents=True, exist_ok=True)
        final = out_dir / "splat.ply"
        iters = int(settings.iterations)
        cmd = [exe, str(dataset_dir), "-n", str(iters), "-o", str(final), "--sh-degree", str(settings.sh_degree)]
        if settings.checkpoint_every:
            cmd += ["--save-every", str(settings.checkpoint_every)]
        cmd += list(settings.extra_args)
        log("$ " + " ".join(cmd))
        t0 = time.time()
        state = {"iter": 0, "last": 0.0}

        def on_line(line: str) -> None:
            m = _STEP.search(line)
            if m:
                state["iter"] = int(m.group(1))
                if on_progress:
                    on_progress(min(0.99, state["iter"] / iters), f"Training {state['iter']}/{iters} iterations")
                if metrics and m.group(2):
                    metrics({"iteration": state["iter"], "loss": float(m.group(2))})
                if time.time() - state["last"] > 30:
                    state["last"] = time.time()
                    log(line)
            else:
                log(line)

        run_streaming(cmd, on_line=on_line, cancel=cancel, cwd=dataset_dir.parent)
        if not final.exists():
            raise ToolError("OpenSplat finished but produced no PLY")
        return TrainReport(backend=self.name, iterations=iters, duration_s=time.time() - t0, ply_path=str(final))

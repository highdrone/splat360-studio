"""Environment check: external tools, platform, trainer availability."""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

from .config import ENGINE_VERSION, is_apple_silicon, is_macos
from .config import settings as cfg
from .models import DoctorReport, PlatformInfo, ToolStatus
from .train.registry import TRAINERS, installed_trainer
from .util.proc import find_tool, tool_version

BREW = "brew install"


def _gpu_name() -> str | None:
    if is_macos():
        try:
            out = subprocess.run(["system_profiler", "SPDisplaysDataType"], capture_output=True, text=True, timeout=20)
            for line in out.stdout.splitlines():
                if "Chipset Model" in line or "Chip:" in line:
                    return line.split(":", 1)[1].strip()
        except Exception:
            return None
        return None
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                             text=True, timeout=10)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip().splitlines()[0]
    except Exception:
        pass
    return None


@lru_cache(maxsize=1)
def platform_info() -> PlatformInfo:
    try:
        import psutil
        ram = psutil.virtual_memory().total / 1e9
    except Exception:
        ram = 0.0
    try:
        free = shutil.disk_usage(cfg.data_dir if cfg.data_dir.exists() else Path.home()).free / 1e9
    except Exception:
        free = 0.0
    return PlatformInfo(
        os={"darwin": "macOS", "linux": "Linux", "win32": "Windows"}.get(sys.platform, sys.platform),
        os_version=platform.mac_ver()[0] if is_macos() else platform.release(),
        arch=platform.machine(), cpu_count=os.cpu_count() or 1, ram_gb=round(ram, 1), disk_free_gb=round(free, 1),
        gpu=_gpu_name(), python=platform.python_version(), apple_silicon=is_apple_silicon(),
    )


def check_tools() -> list[ToolStatus]:
    tools: list[ToolStatus] = []

    def add(name, cands, required, role, hint, version_cmd=None, pattern=r"(\d+\.\d+(?:\.\d+)?)", notes=None):
        path = find_tool(cands)
        ver = tool_version([path] + (version_cmd or ["--version"]), pattern) if path else None
        tools.append(ToolStatus(name=name, found=bool(path), path=path, version=ver, required=required, role=role,
                                install_hint=hint, notes=notes or []))
        return path

    add("ffmpeg", ["ffmpeg"], True, "Decodes the 360° video and extracts keyframes", f"{BREW} ffmpeg", ["-version"])
    add("ffprobe", ["ffprobe"], True, "Reads video metadata", f"{BREW} ffmpeg", ["-version"])
    cm = add("colmap", ["colmap"], True, "Structure-from-motion (camera poses and sparse points)", f"{BREW} colmap",
             ["help"], r"COLMAP\s+(\d+\.\d+(?:\.\d+)?)")
    if cm:
        try:
            from .colmap.runner import Colmap
            c = Colmap(cm)
            t = tools[-1]
            t.notes.append("native rig support" if c.has_native_rigs else
                           ("legacy rig bundle adjuster" if c.has_rig_bundle_adjuster else "no rig support"))
            t.notes.append("CUDA" if c.has_cuda() else "CPU only (normal on macOS)")
        except Exception:
            pass
    add("glomap", ["glomap"], False, "Optional faster global SfM engine", f"{BREW} glomap", ["-h"], r"GLOMAP\s+(\d+\.\d+(?:\.\d+)?)")
    add("brush", list(TRAINERS["brush"].CANDIDATES), False, "Gaussian splat trainer (recommended, Metal GPU)",
        "cargo install --git https://github.com/ArthurBrussee/brush.git brush-cli  (or run scripts/setup-mac.sh)",
        ["--help"], r"(\d+\.\d+\.\d+)")
    add("opensplat", ["opensplat"], False, "Alternative Gaussian splat trainer (libtorch / MPS)",
        "Build from source: https://github.com/pierotofy/OpenSplat", ["--help"])
    return tools


def run_doctor() -> DoctorReport:
    tools = check_tools()
    found = {t.name: t.found for t in tools}
    can_reconstruct = found["ffmpeg"] and found["ffprobe"] and found["colmap"]
    trainer = installed_trainer()
    msgs: list[str] = []
    if not can_reconstruct:
        missing = [t.name for t in tools if t.required and not t.found]
        msgs.append("Missing required tools: " + ", ".join(missing) + ". Run scripts/setup-mac.sh or install them with Homebrew.")
    if not trainer:
        msgs.append("No Gaussian splat trainer found. The pipeline will produce a point-cloud preview only. "
                    "Install Brush to train real splats.")
    pi = platform_info()
    if pi.os == "macOS" and not pi.apple_silicon:
        msgs.append("Intel Mac detected: training will be slow or unsupported; Apple Silicon is recommended.")
    if pi.disk_free_gb < 20:
        msgs.append(f"Only {pi.disk_free_gb:.0f} GB free; an 8K project needs 10-30 GB of working space.")
    return DoctorReport(ready=bool(can_reconstruct and trainer), can_reconstruct=bool(can_reconstruct),
                        can_train=bool(trainer), tools=tools, platform=pi, trainer=trainer,
                        data_dir=str(cfg.data_dir), engine_version=ENGINE_VERSION, messages=msgs)

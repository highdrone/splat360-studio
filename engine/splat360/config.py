"""Engine configuration: data directory, tool search paths, constants."""
from __future__ import annotations

import os
import platform
import sys
from pathlib import Path

ENGINE_VERSION = "1.0.0"
APP_NAME = "Splat360"


def is_macos() -> bool:
    return sys.platform == "darwin"


def is_apple_silicon() -> bool:
    return is_macos() and platform.machine() in ("arm64", "aarch64")


def default_data_dir() -> Path:
    env = os.environ.get("SPLAT360_DATA_DIR")
    if env:
        return Path(env).expanduser()
    if is_macos():
        return Path.home() / "Library" / "Application Support" / APP_NAME
    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
        return Path(base) / APP_NAME
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg) if xdg else Path.home() / ".local" / "share") / APP_NAME.lower()


def extra_bin_dirs() -> list[Path]:
    """Directories searched for external tools in addition to PATH."""
    dirs = [
        default_data_dir() / "bin",
        Path.home() / ".cargo" / "bin",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        Path("/Applications/COLMAP.app/Contents/MacOS"),
    ]
    env = os.environ.get("SPLAT360_BIN_DIRS")
    if env:
        dirs = [Path(p).expanduser() for p in env.split(os.pathsep) if p] + dirs
    return dirs


class Settings:
    """Process-wide runtime settings (populated by the CLI)."""

    data_dir: Path = default_data_dir()
    host: str = "127.0.0.1"
    port: int = 8765
    max_parallel_jobs: int = 1

    @classmethod
    def projects_dir(cls) -> Path:
        return cls.data_dir / "projects"

    @classmethod
    def logs_dir(cls) -> Path:
        return cls.data_dir / "logs"

    @classmethod
    def cache_dir(cls) -> Path:
        return cls.data_dir / "cache"

    @classmethod
    def ensure_dirs(cls) -> None:
        for d in (cls.data_dir, cls.projects_dir(), cls.logs_dir(), cls.cache_dir()):
            d.mkdir(parents=True, exist_ok=True)


settings = Settings

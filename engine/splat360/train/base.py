"""Trainer adapter interface."""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from pathlib import Path

from ..models import TrainReport, TrainSettings
from ..util.proc import CancelToken

ProgressCb = Callable[[float, str], None]


class Trainer(ABC):
    name: str = "base"
    label: str = "Base trainer"

    @abstractmethod
    def executable(self) -> str | None:
        """Path to the trainer binary, or None if not installed."""

    def available(self) -> bool:
        return self.executable() is not None

    @abstractmethod
    def train(
        self,
        dataset_dir: Path,
        out_dir: Path,
        settings: TrainSettings,
        *,
        cancel: CancelToken | None = None,
        on_progress: ProgressCb | None = None,
        log: Callable[[str], None] | None = None,
        metrics: Callable[[dict], None] | None = None,
    ) -> TrainReport:
        """Train and return a report whose ``ply_path`` points at the final splat PLY."""

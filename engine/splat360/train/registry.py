from __future__ import annotations

from typing import Optional

from .base import Trainer
from .brush import BrushTrainer
from .opensplat import OpenSplatTrainer
from .pointcloud import PointCloudTrainer

TRAINERS: dict[str, Trainer] = {
    "brush": BrushTrainer(),
    "opensplat": OpenSplatTrainer(),
    "mock": PointCloudTrainer(),
}
PREFERENCE = ["brush", "opensplat"]


def resolve_trainer(backend: str) -> Trainer:
    if backend == "auto":
        for name in PREFERENCE:
            if TRAINERS[name].available():
                return TRAINERS[name]
        return TRAINERS["mock"]
    return TRAINERS[backend]


def installed_trainer() -> Optional[str]:
    for name in PREFERENCE:
        if TRAINERS[name].available():
            return name
    return None

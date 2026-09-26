"""ASGI entry point (``uvicorn splat360.server:app``)."""
from .api import create_app

app = create_app()

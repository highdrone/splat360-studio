# Splat360 Studio — developer entry points. See README.md "Development".
#
#   make setup        one-shot macOS setup (Homebrew tools, engine venv, Brush)
#   make dev          engine (reload) + Vite dev server;  make dev-desktop adds Electron
#   make test         engine pytest + frontend vitest + desktop vitest
#   make lint         ruff + eslint + tsc
#   make build-mac    DMG in desktop/release/
#
# PYTHON defaults to the venv the desktop app uses, falling back to python3.

SHELL := /bin/bash
.DEFAULT_GOAL := help

DATA_DIR ?= $(HOME)/Library/Application Support/Splat360
VENV     ?= $(DATA_DIR)/venv
PYTHON   ?= $(shell if [ -x "$(VENV)/bin/python" ]; then echo "$(VENV)/bin/python"; \
                    elif [ -x "$(CURDIR)/engine/.venv/bin/python" ]; then echo "$(CURDIR)/engine/.venv/bin/python"; \
                    else command -v python3; fi)
NPM      ?= npm

.PHONY: help setup setup-engine dev dev-desktop test test-engine test-frontend test-desktop \
        lint lint-engine lint-frontend lint-desktop build-mac build-frontend doctor demo clean

help:
	@grep -E '^#   make' Makefile | sed 's/^#   //'

# --- setup -------------------------------------------------------------------
setup:
	scripts/setup-mac.sh

setup-engine:
	scripts/setup-mac.sh --engine-only

# --- run ---------------------------------------------------------------------
dev:
	scripts/dev.sh

dev-desktop:
	scripts/dev.sh --desktop

doctor:
	"$(PYTHON)" -m splat360 doctor

demo:
	"$(PYTHON)" -m splat360 demo -o synthetic.mp4

# --- dependencies (idempotent) ----------------------------------------------
frontend/node_modules: frontend/package.json frontend/package-lock.json
	$(NPM) --prefix frontend install
	@touch $@

desktop/node_modules: desktop/package.json desktop/package-lock.json
	$(NPM) --prefix desktop install
	@touch $@

# --- test --------------------------------------------------------------------
test: test-engine test-frontend test-desktop

test-engine:
	"$(PYTHON)" -c "import splat360" 2>/dev/null || "$(PYTHON)" -m pip install -e "engine[dev]"
	cd engine && "$(PYTHON)" -m pytest tests -q

test-frontend: frontend/node_modules
	$(NPM) --prefix frontend run typecheck
	$(NPM) --prefix frontend test

test-desktop: desktop/node_modules
	$(NPM) --prefix desktop run typecheck
	$(NPM) --prefix desktop test

# Full pipeline on a synthetic clip (needs ffmpeg + COLMAP, several minutes).
test-e2e:
	cd engine && SPLAT360_E2E=1 "$(PYTHON)" -m pytest tests/test_e2e_synthetic.py -q

# --- lint --------------------------------------------------------------------
lint: lint-engine lint-frontend lint-desktop

lint-engine:
	"$(PYTHON)" -m ruff check engine

lint-frontend: frontend/node_modules
	$(NPM) --prefix frontend run lint

lint-desktop: desktop/node_modules
	$(NPM) --prefix desktop run typecheck

# --- build -------------------------------------------------------------------
build-frontend: frontend/node_modules
	$(NPM) --prefix frontend run build

build-mac:
	scripts/build-mac.sh

# --- housekeeping ------------------------------------------------------------
clean:
	rm -rf frontend/dist desktop/dist desktop/release
	find engine -name __pycache__ -type d -prune -exec rm -rf {} +
	rm -rf engine/.pytest_cache engine/.ruff_cache

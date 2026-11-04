"""Where the repository is. The agent runs from a checkout: it builds the bridge in bridge/,
deploys deploy/laptop, and keeps fetched game files and run logs in .deps/ (never committed)."""

from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DEPS = REPO / ".deps"

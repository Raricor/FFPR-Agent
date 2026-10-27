"""Export ludo.guide parsing from the cached real pages (port fixture).

Run from dsh-port-04:
    PYTHONDONTWRITEBYTECODE=1 /root/data/mediaflow/FFPR-Agent/.venv/bin/python \
        scripts/fixtures/ludo.py
"""

import json
from pathlib import Path

from ffpr_agent.guide import ludo

REPO = Path("/root/data/mediaflow/FFPR-Agent")
PAGES = REPO / ".deps" / "knowledge" / "ff5" / "pages"
OUT = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "ludo" / "pages.json"
SLUGS = ["walse-town-and-castle", "ship-graveyard"]


def main() -> None:
    pages = []
    for slug in SLUGS:
        html = (PAGES / f"ludo-{slug}.html").read_text(encoding="utf-8")
        chapter = ludo.parse(slug, html)
        pages.append({"slug": slug, "html": html, "chapter": chapter.as_dict()})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"pages": pages}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(pages)} pages -> {OUT}")
    print(f"fixture {OUT.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()

"""Export Steam guide parsing from the cached real pages (port fixture).

Run from dsh-port-04:
    PYTHONDONTWRITEBYTECODE=1 /root/data/mediaflow/FFPR-Agent/.venv/bin/python \
        scripts/fixtures/steam.py
"""

import json
import re
from pathlib import Path

from ffpr_agent.guide import steam

REPO = Path("/root/data/mediaflow/FFPR-Agent")
PAGES = REPO / ".deps" / "knowledge" / "ff5" / "pages"
OUT = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "steam" / "cases.json"
TITLES = ("Tule", "Walse", "Tower of Walse", "Karnak")


def section_html(page: str) -> dict[str, str]:
    """The raw HTML of each section, from its title div to the next one."""
    starts = [match.start() for match in re.finditer(r'<div class="subSectionTitle">', page)]
    out = {}
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(page)
        fragment = page[start:end]
        title = steam.clean(fragment.split("</div>", 1)[0].split(">", 1)[1])
        out[title] = fragment
    return out


def main() -> None:
    bestiary_html = (PAGES / "steam-bestiary.html").read_text(encoding="utf-8")
    names = steam.bestiary(bestiary_html)
    walkthrough_html = (PAGES / "steam-walkthrough.html").read_text(encoding="utf-8")
    sections = steam.sections(walkthrough_html)
    snippets = section_html(walkthrough_html)
    selected = []
    for section in sections:
        if section["title"] not in TITLES:
            continue
        section["shops"] = steam.shops(section, frozenset(names.values()))
        section["treasures"] = steam.treasures(section, frozenset(names.values()))
        selected.append({"html": snippets[section["title"]], "section": section})
    data = {
        "bestiaryHtml": bestiary_html,
        "bestiary": [[number, name] for number, name in sorted(names.items())],
        "sectionTitles": [section["title"] for section in sections],
        "sections": selected,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(selected)} sections, {len(names)} bestiary -> {OUT}")
    print(f"fixture {OUT.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()

"""Read the Final Fantasy V walkthrough on ludo.guide (human-written, covers the Pixel
Remaster) into structured chapters: steps, tips, monsters with bestiary numbers, bosses,
items, and the chapter order. The pages are cached under .deps, never committed: the text is
the guide's, kept for our own play with its source URL on every chapter.

    chapters = [parse(slug, html) for slug, html in pages]
"""

import html as htmlib
import re
from dataclasses import asdict, dataclass, field

BASE = "https://www.ludo.guide/guide/final-fantasy-v"
INDEX = BASE
SLUG = re.compile(r'href="/guide/final-fantasy-v/([a-z0-9-]+)"')
# 030 Jackanapes (Level 20, HP 666, Steal: Speed Shake, Elixir, Drop: Phoenix Down, ...)
MONSTER = re.compile(r"^(\d{3})\s+(.+?)\s+\((.*)\)\s*$")
STEP = re.compile(r"^(\d{1,2})\s+(.+)$")
HEADINGS = ("Prerequisites", "Walkthrough", "Tips")
END = "More in this chapter"


@dataclass
class Monster:
    book: int  # the bestiary number (the game's PictureBook id)
    name: str
    area: str
    level: int | None = None
    hp: int | None = None
    weak: list[str] = field(default_factory=list)
    steal: str = ""
    drop: str = ""
    blue: str = ""  # blue magic it teaches
    notes: str = ""  # anything else in the parentheses


@dataclass
class Chapter:
    slug: str
    title: str
    url: str
    summary: str = ""
    prerequisites: list[str] = field(default_factory=list)
    steps: list[str] = field(default_factory=list)
    tips: list[str] = field(default_factory=list)
    monsters: list[Monster] = field(default_factory=list)
    bosses: dict[str, list[str]] = field(default_factory=dict)  # area → boss names
    items: dict[str, list[str]] = field(default_factory=dict)  # area → items
    previous: str = ""
    next: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def slugs(index_html: str) -> list[str]:
    seen = []
    for slug in SLUG.findall(index_html):
        if slug not in seen and slug != "about":
            seen.append(slug)
    return seen


def text_lines(page: str) -> list[str]:
    page = re.sub(r"<script.*?</script>|<style.*?</style>|<!--.*?-->", "", page, flags=re.S)
    page = re.sub(r"<(br|/p|/li|/h[1-6]|/div|/tr|/dt|/dd)[^>]*>", "\n", page)
    text = htmlib.unescape(re.sub(r"<[^>]+>", " ", page))
    lines = (re.sub(r"[ \t ]+", " ", line).strip() for line in text.splitlines())
    return [line for line in lines if line]


def parse_monster(line: str, area: str) -> Monster | None:
    m = MONSTER.match(line)
    if not m:
        return None
    book, name, inside = int(m.group(1)), m.group(2).strip(), m.group(3)
    monster = Monster(book=book, name=name, area=area)
    rest = []
    for part in re.split(r",\s*(?=[A-Z][A-Za-z ]+:|Level|HP)", inside):
        part = part.strip()
        if part.startswith("Level"):
            monster.level = _int(part)
        elif part.startswith("HP"):
            monster.hp = _int(part)
        elif part.startswith("Weak:"):
            monster.weak = [w.strip() for w in part[5:].split(",") if w.strip()]
        elif part.startswith("Steal:"):
            monster.steal = part[6:].strip()
        elif part.startswith("Drop:"):
            monster.drop = part[5:].strip()
        elif part.startswith("Blue Magic:"):
            monster.blue = part[11:].strip()
        elif part:
            rest.append(part)
    monster.notes = ", ".join(rest)
    return monster


def _int(text: str) -> int | None:
    m = re.search(r"\d+", text.replace(",", ""))
    return int(m.group()) if m else None


def parse(slug: str, page: str) -> Chapter:
    lines = text_lines(page)
    title_match = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S)
    title = slug
    if title_match:
        title = htmlib.unescape(re.sub(r"<[^>]+>", "", title_match.group(1))).strip()
    chapter = Chapter(slug=slug, title=title, url=f"{BASE}/{slug}")
    section, area = "", ""
    for i, line in enumerate(lines):
        if line == END:
            break
        if line in HEADINGS:
            section = line
            if i > 0 and not chapter.summary and section == "Prerequisites":
                chapter.summary = lines[i - 2] if lines[i - 1] in ("⚡",) else lines[i - 1]
            continue
        if line.startswith("Monsters in ") and line.endswith(":"):
            section, area = "Monsters", line[len("Monsters in ") : -1]
            continue
        if line.startswith("Bosses in ") and line.endswith(":"):
            section, area = "Bosses", line[len("Bosses in ") : -1]
            continue
        if line.startswith("Items in ") and line.endswith(":"):
            section, area = "Items", line[len("Items in ") : -1]
            continue
        if section == "Prerequisites":
            chapter.prerequisites.append(line)
        elif section == "Walkthrough":
            m = STEP.match(line)
            if m:
                chapter.steps.append(m.group(2))
            elif chapter.steps:
                chapter.steps[-1] += " " + line
        elif section == "Tips":
            chapter.tips.append(line)
        elif section == "Monsters":
            monster = parse_monster(line, area)
            if monster:
                chapter.monsters.append(monster)
        elif section == "Bosses":
            chapter.bosses.setdefault(area, []).append(line)
        elif section == "Items":
            chapter.items.setdefault(area, []).append(line)
    for line in lines:
        if line.startswith("Previous: "):
            chapter.previous = line[len("Previous: ") :]
        elif line.startswith("Next: "):
            chapter.next = line[len("Next: ") :]
    return chapter

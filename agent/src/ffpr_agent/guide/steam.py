"""Steam Community guides for FINAL FANTASY V (Pixel Remaster, app 1173810), the sources the
user pointed to (10-21): the full walkthrough (77 sections, the whole game: shops with prices,
each area's monsters by bestiary number, boss stat tables with weaknesses, strategies) and the
simplified bestiary (bestiary number → English name for every enemy). Cached under .deps.
"""

import html as htmlib
import re

APP = 1173810
WALKTHROUGH = "https://steamcommunity.com/sharedfiles/filedetails/?id=2651014732"
BESTIARY = "https://steamcommunity.com/sharedfiles/filedetails/?id=2682517364"
MISSABLES = "https://steamcommunity.com/sharedfiles/filedetails/?id=2651019340"
ENTRY = re.compile(r"^(\d{1,3})\.\s+(.+)$")


def clean(fragment: str) -> str:
    """A section's HTML as lines of text (table cells one per line, as Steam renders them)."""
    fragment = re.sub(r"<br\s*/?>", "\n", fragment)
    fragment = re.sub(r"<(div|td|th|tr|li|p)[^>]*>", "\n", fragment)
    text = htmlib.unescape(re.sub(r"<[^>]+>", "", fragment))
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def sections(page: str) -> list[dict]:
    """[{"title", "text"}] in guide order."""
    out = []
    for part in re.split(r'<div class="subSectionTitle">', page)[1:]:
        title, _, body = part.partition("</div>")
        body = body.split('<div class="subSectionTitle">')[0]
        # the guide's footer and comments follow the last section
        body = re.split(r'<div class="commentthread|<div id="commentthread', body)[0]
        out.append({"title": clean(title), "text": clean(body)})
    return out


def bestiary(page: str) -> dict[int, str]:
    """Bestiary number → English name, from the simplified bestiary's list."""
    names: dict[int, str] = {}
    for line in clean(page).splitlines():
        m = ENTRY.match(line)
        if m and int(m.group(1)) not in names:
            names[int(m.group(1))] = m.group(2).strip()
    return names


CHEST = re.compile(r"\[(\d+)(?:-\d+)?/225\]")  # a chest's running number among the 225
HIDDEN = re.compile(r"\{(\d+)(?:-\d+)?/46\}")  # a hidden item's among the 46 (pots, barrels)
SHOP_KINDS = {
    "Inn": "旅店",
    "Items": "道具",
    "Weapons": "武器",
    "Armor": "防具",
    "Shields": "盾",
    "Helmets": "头盔",
    "Accessories": "饰品",
    "Magic": "魔法",
}
TABLE_WORDS = {"Item", "Service", "Cost", "Description"} | {
    "ID",
    "MONSTER",
    "HP",
    "MP",
    "GIL",
    "EXP",
}


def is_place(line: str, skip: frozenset[str] = frozenset()) -> bool:
    """A sub-area heading in the walkthrough ("Tower of Walse - 5F", "Castle Walse"): short,
    no sentence punctuation, not a table cell, not a monster's name (`skip`: the bestiary's
    names, which the monster tables put on lines of their own)."""
    return (
        line not in skip
        and len(line) <= 40
        and not re.search(r"[.!?:,;{}\[\]()]", line)
        and not line.isdigit()
        and line not in TABLE_WORDS
        and line not in SHOP_KINDS
        and line[:1].isupper()
    )


def treasures(section: dict, skip: frozenset[str] = frozenset()) -> list[dict]:
    """Chests ([n/225]) and hidden items ({n/46}) of a section: the line that finds them, with
    its running number and the sub-area heading above it."""
    out, place = [], section["title"]
    for line in section["text"].splitlines():
        if is_place(line, skip):
            place = line
        for kind, mark in (("chest", CHEST), ("hidden", HIDDEN)):
            m = mark.search(line)
            if m:
                text = mark.sub("", line).strip()
                out.append({"kind": kind, "n": int(m.group(1)), "where": place, "text": text})
    return out


def shops(section: dict, skip: frozenset[str] = frozenset()) -> list[dict]:
    """The shop tables of a section: [{"where", "kind", "goods": [{"name", "cost", "note"}]}].
    Tables run category, header cells, then name / cost / description triples (the inn: service
    / cost pairs); a price cell sometimes reads "Cost" instead of a number."""
    lines = section["text"].splitlines()
    out, place, i = [], section["title"], 0
    while i < len(lines):
        line = lines[i]
        header = lines[i + 1 : i + 4]
        if line in SHOP_KINDS and header[:1] in (["Item"], ["Service"]):
            width = 2 if header[0] == "Service" else 3
            i += 1 + width  # past the header cells
            goods = []
            while i + width - 1 < len(lines):
                name, cost = lines[i], lines[i + 1]
                if not (cost.isdigit() or cost == "Cost") or name in TABLE_WORDS:
                    break
                note = lines[i + 2] if width == 3 else ""
                price = int(cost) if cost.isdigit() else None
                goods.append({"name": name, "cost": price, "note": note})
                i += width
            if goods:
                out.append({"where": place, "kind": SHOP_KINDS[line], "goods": goods})
            continue
        if is_place(line, skip):
            place = line
        i += 1
    return out

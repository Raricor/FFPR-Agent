"""The guide knowledge base (control plan §4.11): what the walkthroughs say about an area,
a monster or a boss, looked up by Chinese, Japanese or English name, or by bestiary number
(the number the game's bestiary gives a monster, which the bridge reads in battle).

Sources, all fetched by `ffpr-guide fetch` into .deps/knowledge/ff5 (a local cache for our
own play, never committed; every answer names its source):
- the Steam Community walkthrough for the Pixel Remaster (the user's pick, 10-21): the whole
  game in 77 sections, with shops, each area's monsters by number, boss stat tables;
- the Steam simplified bestiary: number → English name for all 302 enemies;
- ludo.guide's walkthrough: World 1 in 30 short chapters, with tips such as "RUN from
  Jackanapes".

    guide = Guide.load()
    guide.lookup("沃尔斯城")      # the Walse sections
    guide.lookup("30")            # Jackanapes, wherever the guides mention it
"""

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from ffpr_agent.guide import ludo, steam
from ffpr_agent.repo import DEPS

HOME = DEPS / "knowledge" / "ff5"
TOUGH = re.compile(r"\brun\b|tough|avoid|dangerous|careful|one-visit", re.I)
INDEX_FILE = HOME / "guide.json"

# English area names as the Steam walkthrough titles them → the game's Chinese names (seen in
# the probe logs, 10-20) and Japanese map names. Areas not visited yet carry the names the
# English suggests; anything unmatched falls back to a text search.
AREAS = {
    "Prologue": ["泰空陨石", "タイクーンの隕石"],
    "Tule": ["图尔村", "佐克的家", "トゥールの村"],
    "Wind Shrine": ["风之神殿", "風の神殿"],
    "Pirate's Hideout": ["海盗据点", "海盗船", "海賊のアジト"],
    "Torna Canal": ["托纳运河", "トルナ運河"],
    "Ship Graveyard": ["船舶墓场", "沉船", "船の墓場"],
    "Carwen": ["卡文镇", "卡尔温", "カーウェン"],
    "North Mountain": ["北山", "北の山"],
    "Castle Tycoon": ["泰空城", "タイクーン城"],
    "Walse": ["沃尔斯城", "沃尔斯镇", "ウォルス城", "ウォルスの町"],
    "Tower of Walse": ["沃尔斯塔", "水之塔", "ウォルスの塔"],
    "Karnak": ["卡尔纳克", "カルナック"],
    "Fire-Powered Ship": ["火力船"],
    "Karnak Castle": ["卡尔纳克城", "カルナック城"],
    "Library of the Ancients": ["古代图书馆", "古代図書館"],
    "Crescent": ["克雷森特", "クレセント"],
    "Black Chocobo Forest": ["黑陆行鸟森林", "黒チョコボの森"],
    "Istory": ["伊斯托里", "イストリー"],
    "Jachol": ["贾克尔", "ジャコール"],
    "Lix": ["里克斯村", "巴兹的家", "リックスの村"],
    "Desert of Shifting Sands": ["流沙沙漠", "流砂の砂漠"],
    "Gohn": ["戈恩", "滅びの町ゴーン"],
    "Tycoon Meteorite": ["泰空陨石", "タイクーンの隕石"],
    "Ronka Ruins": ["罗卡遗迹", "ロンカ遺跡"],
}


def fetch(home: Path = HOME, refresh: bool = False, pause: float = 1.0, say=print) -> Path:
    """Download the guides (each page once; `refresh` again), parse them, write guide.json."""
    home.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": "Mozilla/5.0 (FFPR-Agent guide cache; personal use)"}
    with httpx.Client(headers=headers, timeout=60, follow_redirects=True) as client:

        def get(name: str, url: str) -> str:
            path = home / "pages" / f"{name}.html"
            if path.exists() and not refresh:
                return path.read_text(encoding="utf-8")
            path.parent.mkdir(parents=True, exist_ok=True)
            response = client.get(url)
            response.raise_for_status()
            path.write_text(response.text, encoding="utf-8")
            time.sleep(pause)
            return response.text

        names = steam.bestiary(get("steam-bestiary", steam.BESTIARY))
        monsters = frozenset(names.values())
        walkthrough = steam.sections(get("steam-walkthrough", steam.WALKTHROUGH))
        for section in walkthrough:
            section["shops"] = steam.shops(section, monsters)
            section["treasures"] = steam.treasures(section, monsters)
        say(
            f"  Steam 攻略:{len(walkthrough)} 节,"
            f"{sum(len(s['shops']) for s in walkthrough)} 张商店表,"
            f"{sum(len(s['treasures']) for s in walkthrough)} 条宝箱和拾取物"
        )
        say(f"  Steam 图鉴:{len(names)} 种怪物")
        missables = steam.sections(get("steam-missables", steam.MISSABLES))
        say(f"  Steam 可错过内容:{len(missables)} 节")
        chapters = [
            ludo.parse(slug, get(f"ludo-{slug}", f"{ludo.BASE}/{slug}")).as_dict()
            for slug in ludo.slugs(get("ludo-index", ludo.INDEX))
        ]
        say(f"  ludo.guide:{len(chapters)} 章")
    data = {
        "fetched": time.strftime("%Y-%m-%d"),
        "sources": {
            "walkthrough": steam.WALKTHROUGH,
            "bestiary": steam.BESTIARY,
            "missables": steam.MISSABLES,
            "ludo": ludo.BASE,
        },
        "walkthrough": walkthrough,
        "missables": missables,
        "bestiary": {str(k): v for k, v in sorted(names.items())},
        "ludo": chapters,
    }
    out = home / "guide.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


@dataclass
class Guide:
    walkthrough: list[dict]
    bestiary: dict[int, str]
    ludo: list[dict] = field(default_factory=list)
    missables: list[dict] = field(default_factory=list)
    sources: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path = INDEX_FILE) -> "Guide | None":
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            walkthrough=data.get("walkthrough") or [],
            bestiary={int(k): v for k, v in (data.get("bestiary") or {}).items()},
            ludo=data.get("ludo") or [],
            missables=data.get("missables") or [],
            sources=data.get("sources") or {},
        )

    def areas_for(self, query: str) -> list[str]:
        """English area names the query means: by Chinese / Japanese alias or by English."""
        q = query.strip().lower()
        keys = []
        for key, aliases in AREAS.items():
            names = [key.lower(), *(a.lower() for a in aliases)]
            if any(q == n or (len(n) > 1 and n in q) or (len(q) > 2 and q in n) for n in names):
                keys.append(key)
        return keys

    def area(self, query: str, limit: int = 3500, part: int = 1) -> str:
        """The walkthrough sections for an area (an exact title first), and ludo's tips."""
        keys = self.areas_for(query)
        if not keys:
            return ""
        exact = [s for s in self.walkthrough if s["title"] in keys]
        loose = [
            s
            for s in self.walkthrough
            if s not in exact and any(k.lower() in s["title"].lower() for k in keys)
        ]
        texts = [f"【{s['title']}】\n{s['text']}" for s in exact + loose[:1]]
        tips = [
            t
            for c in self.ludo
            if any(k.lower() in c["title"].lower() for k in keys)
            for t in c.get("tips") or []
        ]
        if tips:
            texts.append("ludo.guide 提示:\n" + "\n".join(f"- {t}" for t in tips))
        return page("\n\n".join(texts), limit, part, self.sources.get("walkthrough", ""))

    def monster(self, query: str, context: int = 10, limit: int = 3000) -> str:
        """Where the guides mention a monster (by bestiary number or English name): the lines
        around each mention, with the section's title, and ludo's line for it."""
        name = query.strip()
        number = None
        if name.lstrip("#").isdigit():
            number = int(name.lstrip("#"))
            name = self.bestiary.get(number, "")
        if not name:
            return ""
        out = [f"图鉴 #{number:03d}:{name}" if number else f"怪物:{name}"]
        word = re.compile(rf"\b{re.escape(name)}\b", re.I)
        for s in self.walkthrough:
            lines = s["text"].splitlines()
            hits = [i for i, line in enumerate(lines) if word.search(line)]
            if hits:
                i = hits[0]
                out.append(f"【{s['title']}】\n" + "\n".join(lines[max(0, i - 3) : i + context]))
        for c in self.ludo:
            for m in c.get("monsters") or []:
                if m["name"].lower() == name.lower():
                    out.append(f"ludo.guide:{m}")
            out += [f"ludo.guide 提示:{t}" for t in c.get("tips") or [] if word.search(t)]
            out += [f"ludo.guide 步骤:{t}" for t in c.get("steps") or [] if word.search(t)]
        if len(out) == 1:
            return ""
        return page("\n\n".join(dict.fromkeys(out)), limit, 1, self.sources.get("walkthrough", ""))

    def warnings(self, area: str, limit: int = 5) -> list[str]:
        """Short things to know before going in: one-visit locations, missables, and the
        tips that tell to run or call something tough."""
        keys = self.areas_for(area)
        out = []
        for s in self.walkthrough:
            if s["title"] in keys:
                for line in s["text"].splitlines():
                    if line.startswith("WARNING") or "one-visit" in line:
                        out.append(line)
        for c in self.ludo:
            if any(k.lower() in c["title"].lower() for k in keys):
                out += [t for t in c.get("tips") or [] if TOUGH.search(t)]
        return list(dict.fromkeys(out))[:limit]

    def monster_note(self, book: int, limit: int = 500) -> str:
        """A monster's name and what the guides warn or advise about it, short."""
        name = self.bestiary.get(book)
        if not name:
            return ""
        word = re.compile(rf"\b{re.escape(name)}\b", re.I)
        notes = []
        for c in self.ludo:
            for m in c.get("monsters") or []:
                if m["name"].lower() == name.lower():
                    weak = f",弱点 {'、'.join(m['weak'])}" if m.get("weak") else ""
                    notes.append(f"Lv{m.get('level')} HP {m.get('hp')}{weak}")
            notes += [t for t in (c.get("tips") or []) + (c.get("steps") or []) if word.search(t)]
        for s in self.walkthrough:
            for line in s["text"].splitlines():
                if word.search(line) and len(line) > len(name) + 20:
                    notes.append(line)
                    break
        text = f"{name}:" + " / ".join(dict.fromkeys(notes))
        return text[:limit] if notes else ""

    def sections_for(self, query: str) -> list[dict]:
        """The walkthrough sections for an area: an exact title first, then titles that
        contain it (Tower of Walse for Walse comes last)."""
        keys = self.areas_for(query)
        exact = [s for s in self.walkthrough if s["title"] in keys]
        loose = [
            s
            for s in self.walkthrough
            if s not in exact and any(k.lower() in s["title"].lower() for k in keys)
        ]
        return exact + loose

    def shops(self, query: str, limit: int = 2500) -> str:
        """What the area's shops sell: the inn's price, items, weapons, armour, magic, with
        prices and what each does (English names; the game shows them in Chinese)."""
        out = []
        for s in self.sections_for(query)[:1]:
            for shop in s.get("shops") or []:
                goods = ";".join(
                    f"{g['name']} {g['cost'] if g['cost'] is not None else '?'}"
                    + (f"({g['note']})" if g.get("note") else "")
                    for g in shop["goods"]
                )
                out.append(f"{shop['kind']}({shop['where']}):{goods}")
            if out:
                out.insert(0, f"【{s['title']}】的商店(攻略里的英文名,游戏里是中文名):")
        return page("\n".join(out), limit, 1, self.sources.get("walkthrough", "")) if out else ""

    def treasures(self, query: str, limit: int = 2500) -> str:
        """The area's chests ([n/225]) and hidden items ({n/46}, pots, barrels, bushes), each
        with where it is and how the guide finds it."""
        out = []
        for s in self.sections_for(query)[:1]:
            for t in s.get("treasures") or []:
                mark = f"宝箱 [{t['n']}/225]" if t["kind"] == "chest" else f"拾取物 {{{t['n']}/46}}"
                out.append(f"{mark} {t['where']}:{t['text']}")
            if out:
                out.insert(0, f"【{s['title']}】的宝箱和可拾取物品:")
        return page("\n".join(out), limit, 1, self.sources.get("walkthrough", "")) if out else ""

    def lookup(self, query: str, part: int = 1, kind: str = "area") -> str:
        """An area, a monster (number or name) or anything else: the area's sections, the
        monster's mentions, or the walkthrough's lines that contain the words. `kind` "shop"
        or "treasure" gives only the area's shops or its chests and hidden items."""
        q = query.strip()
        if not q:
            return ""
        if kind == "shop":
            return self.shops(q)
        if kind == "treasure":
            return self.treasures(q)
        if q.lstrip("#").isdigit():
            return self.monster(q)
        found = self.area(q, part=part)
        if found:
            return found
        if any(name.lower() == q.lower() for name in self.bestiary.values()):
            return self.monster(q)
        return self.search(q)

    def search(self, q: str, limit: int = 3000) -> str:
        word = q.lower()
        out = []
        for s in self.walkthrough + self.missables:
            lines = s["text"].splitlines()
            for i, line in enumerate(lines):
                if word in line.lower():
                    out.append(f"【{s['title']}】\n" + "\n".join(lines[max(0, i - 2) : i + 6]))
                    break
        return page("\n\n".join(out), limit, 1, self.sources.get("walkthrough", "")) if out else ""


def page(text: str, limit: int, part: int, source: str) -> str:
    """One `limit`-sized part of a long answer, numbered, with the source."""
    parts = max(1, -(-len(text) // limit))
    part = min(max(part, 1), parts)
    body = text[(part - 1) * limit : part * limit]
    more = f"\n(第 {part}/{parts} 段;要看后面就带 part={part + 1} 再查)" if part < parts else ""
    return f"{body}{more}\n出处:{source}"

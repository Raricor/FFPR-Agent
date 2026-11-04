# ruff: noqa: E501  (fixtures are copies of the guides' HTML)
from ffpr_agent.guide import ludo, steam
from ffpr_agent.guide.kb import Guide

LUDO_PAGE = """<h1>Walse (Town and Castle)</h1><div>Explore Walse Town.</div><div>⚡</div>
<div>Prerequisites</div><div>Bartz, Lenna, Galuf, Faris party.</div>
<div>Walkthrough</div><div>1 In Walse Town, access the shops: Inn (20 Gil).</div>
<div>2 In the basement, RUN from Jackanapes. The left path leads to a chest.</div>
<div>Tips</div><div>Jackanapes in the basement are very tough; it is recommended to run from them.</div>
<div>Monsters in Castle Walse Area:</div>
<div>030 Jackanapes (Level 20, HP 666, Steal: Speed Shake, Elixir, Drop: Phoenix Down, Blue Magic: Moon Flute)</div>
<div>026 Ice Soldier (Level 13, HP 160, Steal: Mythril Sword, Potion, Drop: Long Sword, Weak: Fire)</div>
<div>Bosses in Castle Walse:</div><div>Shiva, Ice Commander</div>
<div>More in this chapter</div><div>Previous: Walse &amp; Karnak Meteorites</div><div>Next: Karnak</div>"""

STEAM_PAGE = """<div class="subSectionTitle">Walse</div><div>Overworld<br>Head into the town first.<br>
Phoenix Down<br>1000</div><div class="subSectionTitle">Tower of Walse</div>
<div>WARNING: This is a one-visit location.<br>028<br>Wyvern<br>200</div>"""


def test_ludo_chapter_parses_steps_tips_monsters():
    c = ludo.parse("walse-town-and-castle", LUDO_PAGE)
    assert c.title == "Walse (Town and Castle)" and c.next == "Karnak"
    assert c.steps[1].startswith("In the basement, RUN from Jackanapes")
    jack, soldier = c.monsters
    assert (jack.book, jack.name, jack.level, jack.hp, jack.blue) == (
        30,
        "Jackanapes",
        20,
        666,
        "Moon Flute",
    )
    assert soldier.weak == ["Fire"] and soldier.steal == "Mythril Sword, Potion"
    assert c.bosses == {"Castle Walse": ["Shiva, Ice Commander"]}


def test_steam_sections_and_bestiary():
    secs = steam.sections(STEAM_PAGE)
    assert [s["title"] for s in secs] == ["Walse", "Tower of Walse"]
    assert "Phoenix Down\n1000" in secs[0]["text"]
    assert steam.bestiary("<div>Bestiary<br>1. Goblin<br>30. Jackanapes</div>") == {
        1: "Goblin",
        30: "Jackanapes",
    }


def guide() -> Guide:
    return Guide(
        walkthrough=steam.sections(STEAM_PAGE),
        bestiary={30: "Jackanapes", 28: "Wyvern"},
        ludo=[ludo.parse("walse-town-and-castle", LUDO_PAGE).as_dict()],
        sources={
            "walkthrough": "https://steamcommunity.com/sharedfiles/filedetails/?id=2651014732"
        },
    )


def test_lookup_by_chinese_area_and_by_bestiary_number():
    g = guide()
    walse = g.lookup("沃尔斯城")
    assert walse.startswith("【Walse】") and "run from them" in walse and "出处:" in walse
    assert g.lookup("沃尔斯塔").startswith("【Tower of Walse】")
    assert "Jackanapes" in g.lookup("30") and "RUN from Jackanapes" in g.lookup("#30")
    assert g.lookup("没有这个地方") == ""


def test_warnings_and_monster_notes():
    g = guide()
    assert g.warnings("沃尔斯塔") == ["WARNING: This is a one-visit location."]
    assert g.warnings("沃尔斯城") == [
        "Jackanapes in the basement are very tough; it is recommended to run from them."
    ]
    note = g.monster_note(30)
    assert note.startswith("Jackanapes:Lv20 HP 666") and "run from them" in note
    assert g.monster_note(99) == ""


SHOP_SECTION = {
    "title": "Walse",
    "text": "\n".join(
        [
            "Walse",
            "Inspect the white pot to find Silver Specs. {22/46}",
            "Inn",
            "Service",
            "Cost",
            "Rest",
            "20",
            "Weapons",
            "Item",
            "Cost",
            "Description",
            "Battle Axe",
            "650",
            "Attack +23 Can be two-handed",
            "Long Sword",
            "Cost",
            "Attack +22",
            "Magic",
            "Item",
            "Cost",
            "Description",
            "Haste",
            "320",
            "Hastens the passing of time for one ally.",
            "Some great stuff in the Magic Shop.",
            "Tower of Walse - 5F",
            "Ricard Mage",
            "Open the chest for a Silk Robe. [27/225]",
        ]
    ),
}


def test_shop_tables_and_treasures_parse_from_a_section():
    tables = steam.shops(SHOP_SECTION)
    assert [(t["kind"], t["where"]) for t in tables] == [
        ("旅店", "Walse"),
        ("武器", "Walse"),
        ("魔法", "Walse"),
    ]
    assert tables[0]["goods"] == [{"name": "Rest", "cost": 20, "note": ""}]
    assert tables[1]["goods"][1] == {"name": "Long Sword", "cost": None, "note": "Attack +22"}
    found = steam.treasures(SHOP_SECTION, frozenset({"Ricard Mage"}))
    assert found == [
        {
            "kind": "hidden",
            "n": 22,
            "where": "Walse",
            "text": "Inspect the white pot to find Silver Specs.",
        },
        {
            "kind": "chest",
            "n": 27,
            "where": "Tower of Walse - 5F",
            "text": "Open the chest for a Silk Robe.",
        },
    ]


def test_lookup_by_kind_lists_shops_and_treasures():
    section = dict(SHOP_SECTION)
    section["shops"] = steam.shops(section)
    section["treasures"] = steam.treasures(section, frozenset({"Ricard Mage"}))
    g = Guide(walkthrough=[section], bestiary={}, sources={"walkthrough": "https://example"})
    shops = g.lookup("沃尔斯城", kind="shop")
    assert "魔法(Walse):Haste 320(Hastens" in shops and "武器(Walse):Battle Axe 650" in shops
    chests = g.lookup("沃尔斯城", kind="treasure")
    assert "宝箱 [27/225] Tower of Walse - 5F:Open the chest for a Silk Robe." in chests
    assert "拾取物 {22/46} Walse:" in chests

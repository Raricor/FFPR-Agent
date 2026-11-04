import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  bestiary,
  sections,
  shops,
  treasures,
  type SteamSection,
} from "../src/engine/guide/steam.ts";

interface SteamFixture {
  readonly bestiaryHtml: string;
  readonly bestiary: readonly (readonly [number, string])[];
  readonly sectionTitles: readonly string[];
  readonly sections: readonly {
    readonly html: string;
    readonly section: SteamSection;
  }[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "steam", "cases.json"), "utf8"),
) as SteamFixture;

const names = new Set(fixture.bestiary.map(([, name]) => name));

void test("steam bestiary parses the real cached page", () => {
  assert.deepEqual(
    [...bestiary(fixture.bestiaryHtml)],
    fixture.bestiary.map(([number, name]) => [number, name]),
  );
});

for (const item of fixture.sections) {
  void test(`steam parses the real section ${item.section.title}`, () => {
    const parsed = sections(item.html);
    assert.equal(parsed.length, 1);
    const section = parsed[0];
    assert.ok(section);
    assert.equal(section.title, item.section.title);
    assert.equal(section.text, item.section.text);
    assert.deepEqual(shops(section, names), item.section.shops);
    assert.deepEqual(treasures(section, names), item.section.treasures);
  });
}

const STEAM_PAGE = `<div class="subSectionTitle">Walse</div><div>Overworld<br>Head into the town first.<br>
Phoenix Down<br>1000</div><div class="subSectionTitle">Tower of Walse</div>
<div>WARNING: This is a one-visit location.<br>028<br>Wyvern<br>200</div>`;

void test("steam sections and bestiary", () => {
  const parsed = sections(STEAM_PAGE);
  assert.deepEqual(
    parsed.map((section) => section.title),
    ["Walse", "Tower of Walse"],
  );
  assert.ok(parsed[0]?.text.includes("Phoenix Down\n1000"));
  assert.deepEqual(
    [...bestiary("<div>Bestiary<br>1. Goblin<br>30. Jackanapes</div>")],
    [
      [1, "Goblin"],
      [30, "Jackanapes"],
    ],
  );
});

const SHOP_SECTION: SteamSection = {
  title: "Walse",
  text: [
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
  ].join("\n"),
};

void test("steam shop tables and treasures parse from a section", () => {
  const tables = shops(SHOP_SECTION);
  assert.deepEqual(
    tables.map((table) => [table.kind, table.where]),
    [
      ["旅店", "Walse"],
      ["武器", "Walse"],
      ["魔法", "Walse"],
    ],
  );
  assert.deepEqual(tables[0]?.goods, [{ name: "Rest", cost: 20, note: "" }]);
  assert.deepEqual(tables[1]?.goods[1], { name: "Long Sword", cost: null, note: "Attack +22" });
  assert.deepEqual(treasures(SHOP_SECTION, new Set(["Ricard Mage"])), [
    {
      kind: "hidden",
      n: 22,
      where: "Walse",
      text: "Inspect the white pot to find Silver Specs.",
    },
    {
      kind: "chest",
      n: 27,
      where: "Tower of Walse - 5F",
      text: "Open the chest for a Silk Robe.",
    },
  ]);
});

void test("the cached walkthrough has the expected section order", () => {
  assert.equal(fixture.sectionTitles.length, 77);
  assert.equal(fixture.sectionTitles[0], "Introduction");
  assert.equal(fixture.sectionTitles[1], "Prologue");
});

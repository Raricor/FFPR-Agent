import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { asDict, parse, slugs, type Chapter } from "../src/engine/guide/ludo.ts";

interface LudoFixture {
  readonly pages: readonly {
    readonly slug: string;
    readonly html: string;
    readonly chapter: Chapter;
  }[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "ludo", "pages.json"), "utf8"),
) as LudoFixture;

for (const page of fixture.pages) {
  void test(`ludo parses the real cached chapter ${page.slug}`, () => {
    assert.deepEqual(asDict(parse(page.slug, page.html)), page.chapter);
  });
}

const LUDO_PAGE = `<h1>Walse (Town and Castle)</h1><div>Explore Walse Town.</div><div>⚡</div>
<div>Prerequisites</div><div>Bartz, Lenna, Galuf, Faris party.</div>
<div>Walkthrough</div><div>1 In Walse Town, access the shops: Inn (20 Gil).</div>
<div>2 In the basement, RUN from Jackanapes. The left path leads to a chest.</div>
<div>Tips</div><div>Jackanapes in the basement are very tough; it is recommended to run from them.</div>
<div>Monsters in Castle Walse Area:</div>
<div>030 Jackanapes (Level 20, HP 666, Steal: Speed Shake, Elixir, Drop: Phoenix Down, Blue Magic: Moon Flute)</div>
<div>026 Ice Soldier (Level 13, HP 160, Steal: Mythril Sword, Potion, Drop: Long Sword, Weak: Fire)</div>
<div>Bosses in Castle Walse:</div><div>Shiva, Ice Commander</div>
<div>More in this chapter</div><div>Previous: Walse &amp; Karnak Meteorites</div><div>Next: Karnak</div>`;

void test("ludo parses the fire-powered-ship enemies and boss weaknesses", () => {
  const page = fixture.pages.find((item) => item.slug === "fire-powered-ship");
  assert.ok(page);
  const chapter = parse(page.slug, page.html);
  const stats = new Map(
    chapter.monsters.map((monster) => [
      monster.name,
      { book: monster.book, weak: monster.weak, absorb: monster.absorb, immune: monster.immune },
    ]),
  );
  assert.deepEqual(stats.get("Crew Dust"), {
    book: 37,
    weak: ["Ice", "Water", "Wind"],
    absorb: [],
    immune: [],
  });
  assert.deepEqual(stats.get("Poltergeist")?.weak, ["Water", "Wind"]);
  assert.deepEqual(stats.get("Defeater")?.weak, ["Ice"]);
  assert.deepEqual(stats.get("Motor Trap")?.weak, ["Lightning"]);
  assert.deepEqual(stats.get("Liquid Flame")?.weak, ["Ice", "Water", "Wind"]);
});

void test("ludo reads weak, absorb, immune and null rows", () => {
  const page = `<h1>Test</h1><div>Monsters in Test Area:</div>
    <div>001 One (Level 1, HP 10, Weak: Fire, Ice, Absorb: Water, Immune: Lightning, Null: Holy)</div>
    <div>002 Two (Level 2, HP 20, Weak to nothing)</div>`;
  const chapter = parse("test", page);
  const [one, two] = chapter.monsters;
  assert.ok(one && two);
  assert.deepEqual(one.weak, ["Fire", "Ice"]);
  assert.deepEqual(one.absorb, ["Water"]);
  assert.deepEqual(one.immune, ["Lightning", "Holy"]);
  assert.deepEqual(two.weak, []);
});

void test("ludo chapter parses steps tips monsters", () => {
  const chapter = parse("walse-town-and-castle", LUDO_PAGE);
  assert.equal(chapter.title, "Walse (Town and Castle)");
  assert.equal(chapter.next, "Karnak");
  assert.ok(chapter.steps[1]?.startsWith("In the basement, RUN from Jackanapes"));
  const [jack, soldier] = chapter.monsters;
  assert.ok(jack && soldier);
  assert.deepEqual(
    [jack.book, jack.name, jack.level, jack.hp, jack.blue],
    [30, "Jackanapes", 20, 666, "Moon Flute"],
  );
  assert.deepEqual(soldier.weak, ["Fire"]);
  assert.equal(soldier.steal, "Mythril Sword, Potion");
  assert.deepEqual(chapter.bosses, { "Castle Walse": ["Shiva, Ice Commander"] });
});

void test("ludo slugs keep the index order without about or duplicates", () => {
  const index = `<a href="/guide/final-fantasy-v/tule">Tule</a>
    <a href="/guide/final-fantasy-v/walse-town-and-castle">Walse</a>
    <a href="/guide/final-fantasy-v/tule">Tule again</a>
    <a href="/guide/final-fantasy-v/about">About</a>`;
  assert.deepEqual(slugs(index), ["tule", "walse-town-and-castle"]);
});

void test("ludo keeps item and boss areas and decodes entities", () => {
  const page = `<h1>A &amp; B</h1><div>Prerequisites</div><div>None.</div>
    <div>Items in Castle Walse:</div><div>Elven Mantle (Chest)</div>
    <div>More in this chapter</div><div>Next: Karnak</div>`;
  const chapter = parse("a-b", page);
  assert.equal(chapter.title, "A & B");
  assert.deepEqual(chapter.items, { "Castle Walse": ["Elven Mantle (Chest)"] });
});

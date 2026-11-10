import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseGuideSection, parseWalkthrough } from "../src/engine/stage/guide-steps.ts";

void test("a section header groups the steps that follow it", () => {
  const section = parseGuideSection(
    {
      title: "Test Town",
      text: [
        "Overworld",
        "Head north to the town.",
        "Test Town",
        "Talk to the guard.",
        "Test Town - Pub",
        "Play the piano.",
      ].join("\n"),
    },
    3,
  );
  assert.equal(section.order, 3);
  assert.deepEqual(section.places, ["Overworld", "Test Town", "Test Town - Pub"]);
  assert.deepEqual(
    section.steps.map((step) => step.where),
    ["Overworld", "Test Town", "Test Town - Pub"],
  );
  assert.deepEqual(
    section.steps.map((step) => step.kind),
    ["move", "talk", "piano"],
  );
});

void test("chest and hidden-item marks become refs with the item name", () => {
  const section = parseGuideSection(
    {
      title: "Cave",
      text: ["Open the chest for a Tent. [6/225]", "Search the pot for 150 Gil. {1/46}"].join("\n"),
    },
    0,
  );
  assert.deepEqual(
    section.steps.map((step) => step.ref),
    [
      { kind: "chest", n: 6 },
      { kind: "hidden", n: 1 },
    ],
  );
  assert.deepEqual(
    section.steps.map((step) => step.kind),
    ["chest", "hidden"],
  );
  assert.deepEqual(
    section.steps.map((step) => step.item),
    ["Tent", "150 Gil"],
  );
});

void test("one line with several items is split and numbered backwards", () => {
  const section = parseGuideSection(
    {
      title: "Town",
      text: [
        "Search the pot for a Potion, the barrel for a Phoenix Down, and the box for a Tent. {8/46}",
        "Also, open both chests for an Ether and 100 Gil. [4/225]",
      ].join("\n"),
    },
    0,
  );
  const hidden = section.steps.filter((step) => step.ref?.kind === "hidden");
  assert.deepEqual(
    hidden.map((step) => step.ref?.n),
    [6, 7, 8],
  );
  assert.deepEqual(
    hidden.map((step) => step.item),
    ["Potion", "Phoenix Down", "Tent"],
  );
  const chests = section.steps.filter((step) => step.ref?.kind === "chest");
  assert.deepEqual(
    chests.map((step) => step.ref?.n),
    [3, 4],
  );
  assert.deepEqual(
    chests.map((step) => step.item),
    ["Ether", "100 Gil"],
  );
  assert.ok(
    section.steps.every(
      (step) => step.text.includes("Search the pot") || step.text.includes("both chests"),
    ),
  );
});

void test("a bestiary table yields monsters with blue magic and no table steps", () => {
  const section = parseGuideSection(
    {
      title: "Cave",
      text: [
        "Cave - 1F",
        "BESTIARY: CAVE",
        "ID",
        "MONSTER",
        "HP",
        "MP",
        "GIL",
        "EXP",
        "005",
        "Killer Bee",
        "20",
        "0",
        "20",
        "15",
        "008",
        "Black Goblin",
        "20",
        "0",
        "21",
        "20",
        "BM: Goblin Punch",
        "Head north.",
      ].join("\n"),
    },
    0,
  );
  assert.deepEqual(section.monsters, [
    { id: 5, name: "Killer Bee", blueMagic: null, where: "Cave - 1F" },
    { id: 8, name: "Black Goblin", blueMagic: "Goblin Punch", where: "Cave - 1F" },
  ]);
  assert.deepEqual(
    section.steps.map((step) => step.kind),
    ["move"],
  );
});

void test("a boss block carries its HP, weaknesses and resistances", () => {
  const section = parseGuideSection(
    {
      title: "Wind Shrine",
      text: [
        "Crystal Room",
        "Wing Raptor",
        "ID",
        "HP",
        "MP",
        "ATK",
        "DEF",
        "EVA",
        "M.DEF",
        "MAG",
        "WEAKNESS",
        "RESIST.",
        "ABSORBS",
        "CANCELS",
        "229",
        "250",
        "25",
        "7",
        "0",
        "0",
        "10",
        "1",
        "None",
        "Mini, Toad, Petrify",
        "None",
        "None",
        "After the fight, head upstairs.",
      ].join("\n"),
    },
    1,
  );
  const boss = section.steps[0];
  assert.equal(boss?.kind, "boss");
  assert.equal(boss.text, "Wing Raptor");
  assert.deepEqual(boss.boss, {
    name: "Wing Raptor",
    hp: 250,
    weak: [],
    resist: ["Mini", "Toad", "Petrify"],
    absorb: [],
  });
  assert.equal(section.steps[1]?.kind, "move");
});

void test("prose lines are classified by keyword, with save before heal", () => {
  const section = parseGuideSection(
    {
      title: "Keys",
      text: [
        "Speak to the elder.",
        "Flip the switch on the wall.",
        "Save at the consecrated circle.",
        "Rest at the healing point.",
        "Watch the cutscene.",
        "Visit the shop.",
        "Play the piano.",
        "Head north.",
        "Heal up and quick-save.",
        "The wind is strong today.",
      ].join("\n"),
    },
    0,
  );
  assert.deepEqual(
    section.steps.map((step) => step.kind),
    ["talk", "switch", "save", "heal", "cutscene", "shop", "piano", "move", "save", "note"],
  );
});

void test("walkthrough input is checked and keeps its order", () => {
  const sections = parseWalkthrough([
    { title: "One", text: "Head north." },
    { title: "Two", text: "Head south." },
  ]);
  assert.deepEqual(
    sections.map((section) => section.title),
    ["One", "Two"],
  );
  assert.deepEqual(
    sections.map((section) => section.order),
    [0, 1],
  );
  assert.throws(() => parseWalkthrough({}), /数组/);
  assert.throws(() => parseWalkthrough([{ title: 1, text: "x" }]), /title/);
});

void test("the cached walkthrough parses into 77 sections with the known finds", async (t) => {
  const path = join(import.meta.dirname, "../../.deps/knowledge/ff5/guide.json");
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("没有攻略缓存");
      return;
    }
    throw error;
  }
  const raw: unknown = JSON.parse(body);
  assert.ok(typeof raw === "object" && raw !== null && !Array.isArray(raw));
  const sections = parseWalkthrough((raw as { walkthrough?: unknown }).walkthrough);
  assert.equal(sections.length, 77);

  const wind = sections.find((section) => section.title === "Wind Shrine");
  assert.ok(wind !== undefined);
  assert.deepEqual(
    wind.steps.filter((step) => step.ref?.kind === "chest").map((step) => step.ref?.n),
    [6, 7, 8, 9],
  );
  const windBoss = wind.steps.find((step) => step.kind === "boss")?.boss;
  assert.equal(windBoss?.name, "Wing Raptor");
  assert.equal(windBoss.hp, 250);
  assert.deepEqual(windBoss.weak, []);
  assert.deepEqual(windBoss.resist, ["Mini", "Toad", "Petrify"]);

  const tule = sections.find((section) => section.title === "Tule");
  assert.ok(tule !== undefined);
  const hidden = tule.steps.filter((step) => step.ref?.kind === "hidden");
  assert.deepEqual(
    hidden.map((step) => step.ref?.n),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(new Set(hidden.map((step) => step.ref?.n)).size, hidden.length);

  const chests = new Set<number>();
  const hiddens = new Set<number>();
  for (const section of sections) {
    for (const step of section.steps) {
      if (step.ref?.kind === "chest") chests.add(step.ref.n);
      if (step.ref?.kind === "hidden") hiddens.add(step.ref.n);
    }
  }
  assert.equal(chests.size, 217);
  assert.equal(hiddens.size, 43);
});

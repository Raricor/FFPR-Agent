import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Guide, HOME } from "../src/engine/guide/kb.ts";
import { parse as parseLudo, type Chapter } from "../src/engine/guide/ludo.ts";
import { sections, type SteamSection } from "../src/engine/guide/steam.ts";
import type { Json } from "../src/engine/values.ts";

interface KbCase {
  readonly method: "lookup" | "warnings" | "monster_note" | "search" | "area" | "sections_for";
  readonly args: Json;
  readonly kwargs: Json;
  readonly expected: string | string[];
}

interface KbFixture {
  readonly data: {
    readonly walkthrough: readonly SteamSection[];
    readonly bestiary: Readonly<Record<string, string>>;
    readonly ludo: readonly Chapter[];
    readonly missables: readonly SteamSection[];
    readonly sources: Readonly<Record<string, string>>;
  };
  readonly cases: readonly KbCase[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "kb", "cases.json"), "utf8"),
) as KbFixture;

function makeGuide(): Guide {
  return new Guide(
    fixture.data.walkthrough,
    new Map(Object.entries(fixture.data.bestiary).map(([key, name]) => [Number(key), name])),
    fixture.data.ludo,
    fixture.data.missables,
    fixture.data.sources,
  );
}

function stringArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function runCase(guide: Guide, item: KbCase): void {
  const query = stringArg(item.args.query);
  switch (item.method) {
    case "lookup":
      assert.equal(
        guide.lookup(query, Number(item.kwargs.part ?? 1), stringArg(item.kwargs.kind) || "area"),
        item.expected,
      );
      break;
    case "warnings":
      assert.deepEqual(guide.warnings(stringArg(item.args.area)), item.expected);
      break;
    case "monster_note":
      assert.equal(guide.monsterNote(Number(item.args.book)), item.expected);
      break;
    case "search":
      assert.equal(guide.search(stringArg(item.args.q)), item.expected);
      break;
    case "area":
      assert.equal(
        guide.area(query, Number(item.kwargs.limit ?? 3500), Number(item.kwargs.part ?? 1)),
        item.expected,
      );
      break;
    case "sections_for":
      assert.deepEqual(
        guide.sectionsFor(query).map((section) => section.title),
        item.expected,
      );
      break;
  }
}

void test("guide matches the Python lookups on the cached guide", () => {
  const guide = makeGuide();
  for (const item of fixture.cases) runCase(guide, item);
});

void test("Guide.load reads the same index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-kb-"));
  const path = join(directory, "guide.json");
  try {
    await writeFile(path, JSON.stringify(fixture.data), "utf8");
    const guide = await Guide.load(path);
    assert.ok(guide);
    for (const item of fixture.cases) runCase(guide, item);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("Guide.load returns null when the index is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-kb-"));
  try {
    assert.equal(await Guide.load(join(directory, "absent.json")), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

const STEAM_PAGE = `<div class="subSectionTitle">Walse</div><div>Overworld<br>Head into the town first.<br>
Phoenix Down<br>1000</div><div class="subSectionTitle">Tower of Walse</div>
<div>WARNING: This is a one-visit location.<br>028<br>Wyvern<br>200</div>`;

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

function smallGuide(): Guide {
  return new Guide(
    sections(STEAM_PAGE),
    new Map([
      [30, "Jackanapes"],
      [28, "Wyvern"],
    ]),
    [parseLudo("walse-town-and-castle", LUDO_PAGE)],
    [],
    { walkthrough: "https://steamcommunity.com/sharedfiles/filedetails/?id=2651014732" },
  );
}

void test("lookup by Chinese area and by bestiary number", () => {
  const guide = smallGuide();
  const walse = guide.lookup("沃尔斯城");
  assert.ok(walse.startsWith("【Walse】"));
  assert.ok(walse.includes("run from them") && walse.includes("出处:"));
  assert.ok(guide.lookup("沃尔斯塔").startsWith("【Tower of Walse】"));
  assert.ok(guide.lookup("30").includes("Jackanapes"));
  assert.ok(guide.lookup("#30").includes("RUN from Jackanapes"));
  assert.equal(guide.lookup("没有这个地方"), "");
});

void test("warnings and monster notes", () => {
  const guide = smallGuide();
  assert.deepEqual(guide.warnings("沃尔斯塔"), ["WARNING: This is a one-visit location."]);
  assert.deepEqual(guide.warnings("沃尔斯城"), [
    "Jackanapes in the basement are very tough; it is recommended to run from them.",
  ]);
  const note = guide.monsterNote(30);
  assert.ok(note.startsWith("030 Jackanapes (Level 20, HP 666"));
  assert.ok(note.includes("run from them"));
  assert.ok(note.includes("RUN from Jackanapes."));
  assert.ok(!note.includes("The left path leads"));
  assert.ok(Array.from(note).length <= 300);
  assert.equal(guide.monsterNote(99), "");
});

void test("game map names and room suffixes find the area", () => {
  const guide = makeGuide();
  assert.ok(guide.lookup("卡纳克").startsWith("【Karnak】"));
  assert.ok(guide.lookup("卡纳克镇 旅店").startsWith("【Karnak】"));
  const withShip = new Guide(
    [{ title: "Fire-Powered Ship: Part I", text: "机房里的传送带。" }],
    new Map(),
    [],
    [],
    { walkthrough: "https://example.test/walkthrough" },
  );
  assert.ok(withShip.lookup("火力船 机房").startsWith("【Fire-Powered Ship: Part I】"));
});

void test("a monster note keeps only its own row and sentences about it", async (t) => {
  const path = join(HOME, "pages", "ludo-fire-powered-ship.html");
  let html: string;
  try {
    html = await readFile(path, "utf8");
  } catch {
    t.skip("攻略缓存不在,跳过真页测试");
    return;
  }
  const chapter = parseLudo("fire-powered-ship", html);
  const guide = new Guide(
    [],
    new Map([
      [37, "Crew Dust"],
      [38, "Poltergeist"],
      [39, "Defeater"],
      [40, "Motor Trap"],
    ]),
    [chapter],
  );
  const crew = guide.monsterNote(37);
  assert.ok(crew.startsWith("037 Crew Dust (Level 17, HP 240)"));
  assert.ok(crew.includes("Crew Dust uses Flash when it is the only enemy remaining."));
  assert.ok(!crew.includes("Engine Room Section 4"));
  assert.ok(!crew.includes("Poltergeist"));
  const poltergeist = guide.monsterNote(38);
  assert.ok(poltergeist.startsWith("038 Poltergeist (Level 17, HP 240)"));
  assert.ok(!poltergeist.includes("Crew Dust") && !poltergeist.includes("Engine Room Section 4"));
  const defeater = guide.monsterNote(39);
  assert.ok(defeater.startsWith("039 Defeater (Level 18, HP 260)"));
  assert.ok(!defeater.includes("Crew Dust") && !defeater.includes("Engine Room Section 4"));
  const motor = guide.monsterNote(40);
  assert.ok(motor.startsWith("040 Motor Trap (Level 17, HP 240)"));
  assert.ok(motor.includes("Weak to Lightning") && motor.includes("Speed Shake"));
  assert.ok(!motor.includes("Engine Room Section 4"));
  for (const note of [crew, poltergeist, defeater, motor]) {
    assert.ok(Array.from(note).length <= 300);
  }
});

void test("lookup by kind lists shops and treasures", () => {
  const section = {
    ...SHOP_SECTION,
    shops: undefined,
    treasures: undefined,
  };
  const withTables: SteamSection = {
    ...section,
    shops: [
      { where: "Walse", kind: "旅店", goods: [{ name: "Rest", cost: 20, note: "" }] },
      {
        where: "Walse",
        kind: "武器",
        goods: [{ name: "Battle Axe", cost: 650, note: "Attack +23" }],
      },
      {
        where: "Walse",
        kind: "魔法",
        goods: [
          {
            name: "Haste",
            cost: 320,
            note: "Hastens the passing of time for one ally.",
          },
        ],
      },
    ],
    treasures: [
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
    ],
  };
  const guide = new Guide([withTables], new Map(), [], [], { walkthrough: "https://example" });
  const shopText = guide.lookup("沃尔斯城", 1, "shop");
  assert.ok(shopText.includes("魔法(Walse):Haste 320(Hastens"));
  assert.ok(shopText.includes("武器(Walse):Battle Axe 650"));
  const chests = guide.lookup("沃尔斯城", 1, "treasure");
  assert.ok(chests.includes("宝箱 [27/225] Tower of Walse - 5F:Open the chest for a Silk Robe."));
  assert.ok(chests.includes("拾取物 {22/46} Walse:"));
});

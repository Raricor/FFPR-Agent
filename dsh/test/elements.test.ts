import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeElements, Elements } from "../src/engine/elements.ts";
import { parse, type Chapter } from "../src/engine/guide/ludo.ts";

interface LudoFixture {
  readonly pages: readonly { readonly slug: string; readonly html: string }[];
}

const ludoFixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "ludo", "pages.json"), "utf8"),
) as LudoFixture;

const BESTIARY = new Map([
  [37, "Crew Dust"],
  [38, "Poltergeist"],
  [39, "Defeater"],
  [40, "Motor Trap"],
  [237, "Liquid Flame☆"],
]);

function firePoweredShip(): Chapter {
  const page = ludoFixture.pages.find((item) => item.slug === "fire-powered-ship");
  assert.ok(page, "missing fire-powered-ship fixture");
  return parse(page.slug, page.html);
}

void test("the guide's fire-powered-ship enemies become Chinese single characters", () => {
  const elements = Elements.fromChapters([firePoweredShip()], BESTIARY);
  assert.equal(
    describeElements(elements.lookup({ book: 37 }) ?? assert.fail()),
    "弱 冰、水、风;吸收 —",
  );
  assert.equal(
    describeElements(elements.lookup({ book: 38 }) ?? assert.fail()),
    "弱 水、风;吸收 —",
  );
  assert.equal(describeElements(elements.lookup({ book: 39 }) ?? assert.fail()), "弱 冰;吸收 —");
  assert.equal(describeElements(elements.lookup({ book: 40 }) ?? assert.fail()), "弱 雷;吸收 —");
  // The page names the boss only in prose; the bestiary gives it book 237.
  assert.equal(
    describeElements(elements.lookup({ book: 237, name: "利奎德火焰" }) ?? assert.fail()),
    "弱 冰、水、风;吸收 —",
  );
});

void test("a learned absorb is saved and read back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-elements-"));
  const path = join(directory, "elements-ff5.json");
  try {
    const elements = await Elements.load(path);
    const first = await elements.learnAbsorb({ book: 37, name: "败怨魔" }, "冰");
    assert.equal(first, "败怨魔 吸收冰,以后不对它用冰");
    assert.equal(await elements.learnAbsorb({ book: 37, name: "败怨魔" }, "冰"), null);
    const text = await readFile(path, "utf8");
    assert.ok(text.includes('"absorb"') && text.includes("冰"));

    const reloaded = await Elements.load(path, [firePoweredShip()], undefined, BESTIARY);
    assert.deepEqual(reloaded.lookup({ book: 37 })?.absorb, ["冰"]);
    // The learned absorb beats the guide's "weak to Ice" for the same monster.
    assert.deepEqual(reloaded.lookup({ book: 37 })?.weak, ["水", "风"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("learning a weakness as absorb removes the contradictory weakness", async () => {
  const elements = Elements.fromChapters([firePoweredShip()], BESTIARY);
  const before = elements.lookup({ book: 37 });
  assert.deepEqual(before?.weak, ["冰", "水", "风"]);
  // No path means no write, which keeps this test off disk.
  const note = await elements.learnAbsorb({ book: 37, name: "Crew Dust" }, "冰");
  assert.equal(note, "Crew Dust 吸收冰,以后不对它用冰");
  assert.deepEqual(elements.lookup({ book: 37 })?.weak, ["水", "风"]);
  assert.deepEqual(elements.lookup({ book: 37 })?.absorb, ["冰"]);
});

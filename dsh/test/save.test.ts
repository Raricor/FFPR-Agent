import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptEntry } from "./fake-pilot.ts";
import { FakePilot, recordedCalls, scriptReplies } from "./fake-pilot.ts";
import { highlightedSlot, loadGame, moveToSlot, saveGame } from "../src/engine/skills/save.ts";

interface Case {
  readonly name: string;
  readonly out: unknown;
  readonly calls: unknown[];
  readonly transcript: TranscriptEntry[];
}

interface Fixture {
  readonly highlighted: (number | null)[];
  readonly cases: Case[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "save", "save.json"), "utf8"),
) as Fixture;

const SLOTS = [21, 22, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

void test("highlighted slot maps the cursor through display order", () => {
  const cursor = { open: true, current: null, cursor: 12, slots: SLOTS };
  assert.equal(highlightedSlot(cursor), fixture.highlighted[0]);
  assert.equal(highlightedSlot({ cursor: null, current: 3, slots: [] }), fixture.highlighted[1]);
});

const runners: Record<string, (pilot: FakePilot) => Promise<unknown>> = {
  "move to slot by display order": async (pilot) => ({
    ui: await moveToSlot(pilot, { open: true, cursor: 0, slots: SLOTS }, 3),
  }),
  "save to an empty slot": (pilot) => saveGame(pilot, 3),
  "load from the title screen": (pilot) => loadGame(pilot, 3),
};

for (const item of fixture.cases) {
  void test(item.name, async () => {
    const run = runners[item.name] ?? assert.fail(`no runner for ${item.name}`);
    const pilot = new FakePilot();
    scriptReplies(pilot, item.transcript);
    assert.deepEqual(await run(pilot), item.out);
    assert.deepEqual(recordedCalls(pilot), item.calls);
  });
}

// 10-29 (task 26): FF5 now saves to slot 20 like the five new games; a list that stops at 19
// must not confirm on the wrong slot.
void test("a save whose cursor cannot reach slot 20 does not press confirm", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Player", saves: 2 } });
  pilot.on("keys", { ok: true });
  pilot.on("leave", { ok: true, presses: 1 });
  pilot.onQuery("menu", {
    menu: {
      open: true,
      commands: [{ id: "Items" }, { id: "Save", enabled: true }],
      cursor: 1,
    },
  });
  pilot.onQuery("saveui", {
    saveui: {
      open: true,
      cursor: 0,
      slots: [21, 22, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    },
  });
  assert.deepEqual(await saveGame(pilot, 20), [false, "光标没能移到存档位 20"]);
  // Tab, Enter (open the list); no confirm on the wrong slot.
  assert.deepEqual(pilot.keys(), [["Tab"], ["Enter"]]);
});

/** A save that goes through the menu; `timer` mirrors bridge 0.14.3's countdown. */
function saveFlow(
  pilot: FakePilot,
  timer: { readonly active: boolean; readonly seconds: number | null } | undefined,
): void {
  let saved = false;
  let stage: "menu" | "list" | "saved" = "menu";
  pilot.on("pos", () => ({
    pos: {
      state: "Player",
      map: 1,
      cell: [1, 1],
      saves: saved ? 1 : 0,
      ...(timer === undefined ? {} : { timer }),
    },
  }));
  pilot.on("keys", (fields) => {
    const keys = Array.isArray(fields.keys) ? fields.keys : [];
    if (keys.includes("Enter")) {
      if (stage === "menu") stage = "list";
      else if (stage === "list") {
        saved = true;
        stage = "saved";
      }
    }
    return { ok: true };
  });
  pilot.on("leave", { ok: true, presses: 1 });
  pilot.onQuery("menu", {
    menu: { open: true, commands: [{ id: "Save", enabled: true }], cursor: 0 },
  });
  pilot.onQuery("saveui", { saveui: { open: true, cursor: 0, slots: [20] } });
}

void test("save under a countdown with 200 seconds left is refused before a key", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", {
    pos: { state: "Player", map: 1, saves: 0, timer: { active: true, seconds: 200 } },
  });
  assert.deepEqual(await saveGame(pilot, 20, 300), [
    false,
    "倒计时只剩 200 秒，存档会把这段时间固定在 20 号位;剩不到 300 秒不存",
  ]);
  assert.deepEqual(pilot.keys(), []);
});

void test("save under a countdown with 400 seconds left still saves", async () => {
  const pilot = new FakePilot();
  saveFlow(pilot, { active: true, seconds: 400 });
  assert.deepEqual(await saveGame(pilot, 20, 300), [true, "已存到 20 号位(第 1 次存档)"]);
});

void test("an old bridge without a timer field still saves", async () => {
  const pilot = new FakePilot();
  saveFlow(pilot, undefined);
  assert.deepEqual(await saveGame(pilot, 20, 300), [true, "已存到 20 号位(第 1 次存档)"]);
});

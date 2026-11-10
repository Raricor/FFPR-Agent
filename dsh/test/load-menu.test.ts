import assert from "node:assert/strict";
import test from "node:test";
import { FakePilot } from "./fake-pilot.ts";
import { loadSlotFromMenu } from "../src/engine/skills/load.ts";

/** 11-10's real field-menu ids. */
const COMMANDS = [
  "Item",
  "Magic",
  "Equipment",
  "Job",
  "Ability",
  "Status",
  "Sort",
  "Config",
  "Interruption",
  "Save",
  "Load",
];
const SLOTS = Array.from({ length: 20 }, (_, index) => index + 1);

interface World {
  stage: "idle" | "menu" | "list" | "confirm" | "loading" | "loaded";
  menuCursor: number;
  listCursor: number;
  yes: boolean;
  loadedAt: number;
}

function install(pilot: FakePilot, options: { commands?: string[]; slots?: number[] } = {}): World {
  const world: World = {
    stage: "idle",
    menuCursor: 0,
    listCursor: 0,
    yes: false,
    loadedAt: 0,
  };
  const commands = options.commands ?? COMMANDS;
  const slots = options.slots ?? SLOTS;
  pilot.on("pos", () => {
    if (world.stage === "loading" && pilot.now() >= world.loadedAt + 500) world.stage = "loaded";
    const loaded = world.stage === "loaded";
    const state = loaded || world.stage === "idle" || world.stage === "menu" ? "Player" : "Event";
    return {
      pos: {
        state,
        map: loaded ? 30 : 1,
        cell: loaded ? [12, 8] : [0, 0],
        saves: loaded ? 5 : 4,
      },
    };
  });
  pilot.on("keys", (fields) => {
    const keys = Array.isArray(fields.keys) ? fields.keys : [];
    for (const key of keys) {
      if (typeof key !== "string") continue;
      if (key === "Tab" && world.stage === "idle") {
        world.stage = "menu";
        world.menuCursor = 0;
      } else if (key === "Down" || key === "Up") {
        const delta = key === "Down" ? 1 : -1;
        if (world.stage === "menu") {
          world.menuCursor = Math.max(0, Math.min(commands.length - 1, world.menuCursor + delta));
        } else if (world.stage === "list" || world.stage === "confirm") {
          world.listCursor = Math.max(0, Math.min(slots.length - 1, world.listCursor + delta));
        }
      } else if (key === "Enter") {
        if (world.stage === "menu" && commands[world.menuCursor] === "Load") {
          world.stage = "list";
          world.listCursor = 0;
        } else if (world.stage === "list" && slots[world.listCursor] === 20) {
          world.stage = "confirm";
          world.yes = false;
        } else if (world.stage === "confirm") {
          world.stage = "loading";
          world.loadedAt = pilot.now();
        }
      } else if (key === "Left" && world.stage === "confirm") {
        world.yes = true;
      }
    }
    return { ok: true };
  });
  pilot.onQuery("menu", () => ({
    menu:
      world.stage === "menu"
        ? {
            open: true,
            commands: commands.map((id) => ({ id, enabled: true })),
            cursor: world.menuCursor,
          }
        : { open: false },
  }));
  pilot.onQuery("saveui", () => {
    const open = world.stage === "list" || world.stage === "confirm";
    return {
      saveui: {
        open,
        cursor: open ? world.listCursor : null,
        current: open ? slots[world.listCursor] : null,
        slots: open ? slots : [],
      },
    };
  });
  return world;
}

void test("load slot 20 through the real menu, list and default-No confirmation", async () => {
  const pilot = new FakePilot();
  const world = install(pilot);
  assert.deepEqual(await loadSlotFromMenu(pilot, 20), [
    true,
    "已读取 20 号位(第 5 次存档):地图 30 (12,8)",
  ]);
  assert.equal(world.stage, "loaded");
  assert.equal(world.yes, true);
  const keys = pilot.keys();
  assert.deepEqual(keys[0], ["Tab"]);
  assert.deepEqual(keys.at(-1), ["Left", "Enter"]);
  // Load is the eleventh command: ten Down presses, read after each one.
  assert.deepEqual(
    keys.slice(1, 11),
    Array.from({ length: 10 }, () => ["Down"]),
  );
  assert.deepEqual(keys[11], ["Enter"]);
});

void test("a slot other than 20 is refused before any key", async () => {
  const pilot = new FakePilot();
  const [ok, message] = await loadSlotFromMenu(pilot, 19);
  assert.equal(ok, false);
  assert.match(message, /只允许读取 20 号位/u);
  assert.deepEqual(pilot.calls, []);
});

void test("an unreadable menu cursor stops without pressing Enter", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Player" } });
  pilot.on("keys", { ok: true });
  pilot.onQuery("menu", {
    menu: {
      open: true,
      commands: COMMANDS.map((id) => ({ id, enabled: true })),
      cursor: null,
    },
  });
  const [ok, message] = await loadSlotFromMenu(pilot, 20);
  assert.equal(ok, false);
  assert.match(message, /光标/u);
  assert.deepEqual(pilot.keys(), [["Tab"]]);
});

void test("a cursor stuck away from Load stops without pressing Enter", async () => {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Player" } });
  pilot.on("keys", { ok: true });
  pilot.onQuery("menu", {
    menu: {
      open: true,
      commands: COMMANDS.map((id) => ({ id, enabled: true })),
      cursor: 0,
    },
  });
  const [ok] = await loadSlotFromMenu(pilot, 20);
  assert.equal(ok, false);
  assert.ok(!pilot.keys().some((keys) => keys.includes("Enter")));
});

void test("a menu without Load stops without pressing Enter", async () => {
  const pilot = new FakePilot();
  install(pilot, { commands: COMMANDS.filter((id) => id !== "Load") });
  const [ok, message] = await loadSlotFromMenu(pilot, 20);
  assert.equal(ok, false);
  assert.match(message, /Load/u);
  assert.deepEqual(pilot.keys(), [["Tab"]]);
});

void test("a load list without slot 20 stops before confirming", async () => {
  const pilot = new FakePilot();
  install(pilot, { slots: [1, 2, 3] });
  const [ok, message] = await loadSlotFromMenu(pilot, 20);
  assert.equal(ok, false);
  assert.match(message, /没有 20 号位/u);
  assert.equal(pilot.keys().filter((keys) => keys.includes("Enter")).length, 1);
});

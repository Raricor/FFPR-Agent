/**
 * Loading slot 20 from the field menu (task 102). The scout saves slot 20 before entering a
 * one-time dungeon, records the dungeon's map structure, then returns with this function
 * instead of starting a new game or walking to a save point.
 *
 * 11-10 real-machine menu ids:
 *   ['Item','Magic','Equipment','Job','Ability','Status','Sort','Config','Interruption',
 *    'Save','Load']
 * and the load confirmation starts on 否, so it takes Left then Enter. Every position that can
 * be read is checked through the bridge before the next key: the menu's commands/cursor, the
 * save list's slots/cursor, and the highlighted slot before confirming. If a reading does not
 * match, the function stops and reports what it saw; it never presses Enter on an unchecked
 * cursor. Only slot 20 is allowed, because that is the one save this project owns.
 */

import type { Pilot } from "../pilot.ts";
import { isRecord, list, num, records, record, text, truthy } from "../values.ts";
import { steer } from "./cursor.ts";
import { menuState, waitMenu } from "./menu.ts";
import { highlightedSlot, saveUi } from "./save.ts";

/** The only save slot this project writes; loading any other would touch the user's saves. */
export const SCOUT_SLOT = 20;

function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(([key, item]) => `'${key}': ${show(item)}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(value);
}

function cellText(value: unknown): string {
  const cell = list(value);
  const x = num(cell[0]);
  const y = num(cell[1]);
  return x === undefined || y === undefined ? "?" : `(${x},${y})`;
}

async function readMenuCursor(pilot: Pilot): Promise<number | null> {
  const menu = await menuState(pilot);
  if (!truthy(menu.open)) return null;
  return num(menu.cursor) ?? null;
}

/** The last save list read, or null when it is not open. */
async function readSaveUi(pilot: Pilot): Promise<Record<string, unknown> | null> {
  const ui = record((await pilot.query("saveui")).saveui);
  return truthy(ui.open) ? ui : null;
}

/**
 * Move the load list's cursor one key at a time, reading the highlighted slot after each
 * press. The existing save helper sends `Down*19` in one command; the scout needs a check
 * before every key, and a list cursor that does not match must stop rather than confirm.
 */
async function steerSaveList(pilot: Pilot, slot: number): Promise<Record<string, unknown> | null> {
  const first = await readSaveUi(pilot);
  if (first === null) return null;
  let ui = first;
  const slots = list(ui.slots);
  if (!slots.includes(slot)) return null;
  const target = slots.indexOf(slot);
  for (let tries = 0; tries < slots.length + 2; tries++) {
    if (highlightedSlot(ui) === slot) return ui;
    const at = num(ui.cursor);
    if (at === undefined || at < 0 || at >= slots.length) return null;
    const key = target > at ? "Down" : "Up";
    await pilot.send("keys", { keys: [key], gap: 110 });
    const next = await readSaveUi(pilot);
    if (next === null) return null;
    ui = next;
  }
  return highlightedSlot(ui) === slot ? ui : null;
}

/**
 * Load slot 20 from the field main menu. Returns `[ok, Chinese report]`; on any failed check it
 * returns `false` and the report says which reading did not match. It does not press Escape to
 * close a half-opened menu: "stop, do not press blindly" also means not guessing cleanup keys.
 */
export async function loadSlotFromMenu(
  pilot: Pilot,
  slot = SCOUT_SLOT,
  timeout = 150,
): Promise<[boolean, string]> {
  if (slot !== SCOUT_SLOT) {
    return [false, `只允许读取 ${SCOUT_SLOT} 号位,收到的是 ${show(slot)};没有按键`];
  }
  const before = record((await pilot.send("pos")).pos);
  if (before.state !== "Player") {
    return [false, `现在不能打开菜单(状态 ${show(before.state)});没有按键`];
  }

  await pilot.send("keys", { keys: ["Tab"], gap: 100 });
  const menu = await waitMenu(pilot, (value) => truthy(value.open) && truthy(value.commands));
  if (!truthy(menu.open)) {
    return [false, `菜单没有打开:${show(menu)}`];
  }
  const commands = records(menu.commands);
  const ids = commands.map((command) => text(command.id) ?? "");
  const target = ids.indexOf("Load");
  if (target < 0) {
    return [false, `菜单里没有「读取」(Load);看到的是 ${ids.filter((id) => id !== "").join("、")}`];
  }
  if (commands[target]?.enabled === false) {
    return [false, "菜单里的「读取」是灰的,这里不能读档"];
  }
  if (
    !(await steer(
      readMenuCursor.bind(null, pilot),
      async (key) => {
        await pilot.send("keys", { keys: [key], gap: 110 });
      },
      target,
    ))
  ) {
    return [false, "光标没能移到「读取」,没有按 Enter"];
  }
  const chosenMenu = await menuState(pilot);
  if (!truthy(chosenMenu.open) || num(chosenMenu.cursor) !== target) {
    return [false, `光标读数不对(期望 ${target},读到 ${show(chosenMenu.cursor)}),没有按 Enter`];
  }

  await pilot.send("keys", { keys: ["Enter"], gap: 100 });
  const opened = await saveUi(pilot, (ui) => truthy(ui.open) && list(ui.slots).length > 0);
  if (!truthy(opened.open)) {
    return [false, "读档列表没有打开"];
  }
  if (!list(opened.slots).includes(slot)) {
    return [false, `读档列表里没有 ${slot} 号位,有 ${list(opened.slots).join("、")}`];
  }
  const moved = await steerSaveList(pilot, slot);
  if (moved === null) {
    return [false, `光标没能落到 ${slot} 号位,没有按 Enter`];
  }

  const beforeSlot = await readSaveUi(pilot);
  if (beforeSlot === null || highlightedSlot(beforeSlot) !== slot) {
    return [false, `读档列表的光标读数不对,没有按 Enter`];
  }
  await pilot.send("keys", { keys: ["Enter"], gap: 100 });
  // The confirmation is a common popup with no bridge reader. 11-10's real machine starts it
  // on 否, so Left then Enter is the known choice; the highlighted slot was checked just
  // before this Enter, and there is no readable confirmation state to check in between.
  await pilot.sleep(250);
  await pilot.send("keys", { keys: ["Left", "Enter"], gap: 300 });

  const deadline = pilot.now() + timeout * 1000;
  for (;;) {
    const current = record((await pilot.send("pos")).pos);
    if (current.state === "Player") {
      const ui = await readSaveUi(pilot);
      if (ui === null) {
        const saves = num(current.saves);
        return [
          true,
          `已读取 ${slot} 号位` +
            (saves === undefined ? "" : `(第 ${show(saves)} 次存档)`) +
            `:地图 ${show(current.map)} ${cellText(current.cell)}`,
        ];
      }
    }
    if (pilot.now() > deadline) {
      return [false, `读档后没有回到可操作状态(状态 ${show(current.state)})`];
    }
    await pilot.sleep(200);
  }
}

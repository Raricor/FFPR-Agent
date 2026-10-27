/**
 * Saving and loading, checked against the save list the bridge reads (0.3.0+). Ported from
 * ffpr_agent/skills/save.py.
 */

import type { Pilot, Reply } from "../pilot.ts";
import { isRecord, list, num, records, record, text, truthy } from "../values.ts";
import { steer } from "./cursor.ts";
import { leaveMenu, menuState, waitMenu } from "./menu.ts";

/** Python's str() for a value the messages embed, so None does not become "undefined". */
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

export function highlightedSlot(ui: Reply): number | null {
  const slots = list(ui.slots);
  const cursor = num(ui.cursor);
  if (cursor !== undefined && cursor >= 0 && cursor < slots.length) {
    const slot = slots[cursor];
    return typeof slot === "number" ? slot : null;
  }
  return num(ui.current) ?? null;
}

/** Move the list cursor onto `slot` by display position; returns the final ui or null. */
export async function moveToSlot(pilot: Pilot, ui: Reply, slot: number): Promise<Reply | null> {
  const slots = list(ui.slots);
  if (!slots.includes(slot)) return null;
  for (let i = 0; i < slots.length + 2; i++) {
    const here = highlightedSlot(ui);
    if (here === slot) return ui;
    const target = slots.indexOf(slot);
    const at = num(ui.cursor) ?? 0;
    const key = target > at ? "Down" : "Up";
    await pilot.send("keys", { keys: [`${key}*${Math.abs(target - at)}`], gap: 150 });
    ui = record((await pilot.query("saveui")).saveui);
  }
  return null;
}

/** Polls the save list until `ok(ui)` holds or the time is up; returns the last read. */
export async function saveUi(
  pilot: Pilot,
  ok: (ui: Reply) => boolean = (ui) => truthy(ui.open),
  timeout = 3.0,
): Promise<Reply> {
  const deadline = pilot.now() + timeout * 1000;
  for (;;) {
    const ui = record((await pilot.query("saveui")).saveui);
    if (ok(ui) || pilot.now() > deadline) return ui;
    await pilot.sleep(150);
  }
}

/**
 * Save to `slot` from the main menu, checking every step through the bridge: the Save
 * command and whether it is enabled (0.4.1+), the highlighted slot id before confirming
 * (0.3.0+), and the save counter afterwards. Waits for each screen to open: on the LAN link
 * the readings come faster than the menus open (10-20: a world-map save read as greyed).
 */
export async function saveGame(pilot: Pilot, slot = 3): Promise<[boolean, string]> {
  const before = record((await pilot.send("pos")).pos);
  if (before.state !== "Player") {
    return [false, `现在不能打开菜单(状态 ${show(before.state)})`];
  }
  try {
    return await saveFromMenu(pilot, slot, num(before.saves) ?? 0);
  } finally {
    await leaveMenu(pilot);
  }
}

async function saveFromMenu(pilot: Pilot, slot: number, saves: number): Promise<[boolean, string]> {
  await pilot.send("keys", { keys: ["Tab"], gap: 100 });
  const menu = await waitMenu(pilot, (m) => truthy(m.open) && truthy(m.commands));
  const commands = records(menu.commands);
  const ids = commands.map((command) => text(command.id));
  if (!ids.includes("Save")) return [false, `菜单没有打开:${show(menu)}`];
  if (commands[ids.indexOf("Save")]?.enabled === false) {
    return [false, "这里不能存档(「保存」是灰的),要到世界地图或存档点"];
  }

  const readCursor = async (): Promise<number | null> =>
    num((await menuState(pilot)).cursor) ?? null;
  if (
    !(await steer(
      readCursor,
      async (key) => {
        await pilot.send("keys", { keys: [key], gap: 110 });
      },
      ids.indexOf("Save"),
    ))
  ) {
    return [false, "光标没能移到「保存」"];
  }
  await pilot.send("keys", { keys: ["Enter"], gap: 100 });
  const ui = await saveUi(pilot, (u) => truthy(u.open) && truthy(u.slots));
  if (!truthy(ui.open)) return [false, "存档列表没有打开"];
  if ((await moveToSlot(pilot, ui, slot)) === null) {
    return [false, `光标没能移到存档位 ${slot}`];
  }
  await pilot.send("keys", { keys: ["Enter"], gap: 100 });
  // An occupied slot asks "overwrite?" with the cursor on No; an empty one saves at once.
  for (const confirm of [[], ["Left", "Enter"]]) {
    if (confirm.length > 0) await pilot.send("keys", { keys: confirm, gap: 300 });
    const deadline = pilot.now() + 2000;
    while (pilot.now() < deadline) {
      const after = record((await pilot.send("pos")).pos);
      if ((num(after.saves) ?? 0) > saves) {
        await pilot.send("keys", { keys: ["Enter"], gap: 300 }); // the "saved" message
        return [true, `已存到 ${slot} 号位(第 ${show(after.saves)} 次存档)`];
      }
      await pilot.sleep(200);
    }
  }
  return [false, "存档计数没有增加,可能没存上"];
}

/**
 * From the title screen: press Enter until the load list opens (the title menu starts on
 * Load Game when saves exist), highlight `slot`, confirm, and wait until the player moves.
 */
export async function loadGame(pilot: Pilot, slot = 3, timeout = 150): Promise<[boolean, string]> {
  const deadline = pilot.now() + timeout * 1000;
  const ui = await loadList(pilot, deadline);
  if (ui === null) return [false, "等不到读档列表"];
  if ((await moveToSlot(pilot, ui, slot)) === null) {
    return [false, `光标没能移到存档位 ${slot}`];
  }
  // "Load this data?" starts on No.
  await pilot.send("keys", { keys: ["Enter", "Left", "Enter"], gap: 600 });
  const result = await pilot.send("wait", { timeout: 60000 }, 80_000);
  if (!truthy(result.ok)) return [false, `读档后没有进入可操作状态:${show(result.pos)}`];
  const pos = record(result.pos);
  return [true, `已读取 ${slot} 号位,现在在地图 ${show(pos.map)} ${show(pos.cell)}`];
}

/** Press Enter on the title screen until the load list opens; null when time is up. */
async function loadList(pilot: Pilot, deadline: number): Promise<Reply | null> {
  for (;;) {
    const ui = record((await pilot.query("saveui")).saveui);
    if (truthy(ui.open)) return ui;
    if (pilot.now() > deadline) return null;
    const pos = record((await pilot.send("pos")).pos);
    if (pos.state === "Player") return null;
    await pilot.send("keys", { keys: ["Enter"], gap: 100 });
    await pilot.sleep(2000);
  }
}

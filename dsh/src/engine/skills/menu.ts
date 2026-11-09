/**
 * The field menu: reading it (bridge 0.4.1+), casting a spell from it, leaving it, and the
 * strongest-equipment command. Ported from ffpr_agent/skills/menu.py.
 */

import type { Pilot, Reply } from "../pilot.ts";
import { isRecord, list, num, records, record, text, truthy } from "../values.ts";
import { pick, steer } from "./cursor.ts";
import { statuses } from "./gambit.ts";

export const ICON = /^<[^>]+>/; // 「<IC_ITEM>眼药」 → 「眼药」

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

function iconName(value: unknown): string {
  return (text(value) ?? "").replace(ICON, "");
}

/** How many of an item the bag holds, and what it does hold (names without icon tags). */
async function bagCount(pilot: Pilot, item: string): Promise<[number, string[]]> {
  const rows = records(record((await pilot.query("items")).items).normal);
  const names = rows.map((row) => iconName(row.name));
  const at = pick(names, item);
  return [at === null ? 0 : (num(rows[at]?.count) ?? 0), names];
}

export async function menuState(pilot: Pilot): Promise<Reply> {
  return record((await pilot.query("menu")).menu);
}

/**
 * Polls the field menu until `ok(menu)` holds or the time is up; returns the last read.
 * Time comes from the pilot so the fake clock in tests moves it.
 */
export async function waitMenu(
  pilot: Pilot,
  ok: (menu: Reply) => boolean,
  timeout = 3.0,
): Promise<Reply> {
  const deadline = pilot.now() + timeout * 1000;
  for (;;) {
    const menu = await menuState(pilot);
    if (ok(menu) || pilot.now() > deadline) return menu;
    await pilot.sleep(200);
  }
}

export async function partyState(pilot: Pilot): Promise<Reply[]> {
  return records(record((await pilot.query("sample")).sample).party);
}

interface ItemListState {
  readonly rows: Reply[];
  readonly names: string[];
  readonly selected: string;
  readonly selectedIndex: number | null;
  readonly listCursor: number | null;
  readonly focus: number | null;
}

/**
 * The item window's list as the bridge reads it. `rows` is the whole list and `listCursor` is
 * the item's index in it (11-10: the field list is a two-column grid, and Down/Up move two
 * entries at a time). `selected` names the highlighted item and is the reliable position.
 */
async function itemListState(pilot: Pilot): Promise<ItemListState> {
  const item = record((await menuState(pilot)).item);
  const rows = records(item.rows);
  const names = rows.map((row) => iconName(row.name));
  const selected = iconName(item.selected);
  const focus = rows.findIndex((row) => truthy(row.focus));
  return {
    rows,
    names,
    selected,
    selectedIndex: selected === "" ? null : pick(names, selected),
    listCursor: num(item.listCursor) ?? null,
    focus: focus < 0 ? null : focus,
  };
}

/** The cursor and names any grid list exposes, whichever window the bridge reads. */
export interface GridListState {
  readonly names: readonly string[];
  readonly selected: string;
  readonly selectedIndex: number | null;
  readonly listCursor: number | null;
}

/**
 * Move a menu list's cursor onto `targetIndex`. 11-10: the field item list is a two-column
 * grid, so Down/Up jump two rows (wrapping at the bottom) and Right/Left move one cell; pressing
 * Down only reached the left column and the right column was never reached (the eye drops
 * failure after battle). Read the position again after every key and pick the next key from the
 * new difference, so a wrap cannot leave the loop pressing in the old direction.
 *
 * The column count is inferred from the first Down/Up (default 2), for lists that lay out
 * differently. Stuck when both `selected` and `listCursor` stay put three reads in a row.
 */
export async function steerGridList<S extends GridListState>(
  read: () => Promise<S>,
  targetIndex: number,
  targetName: string,
  press: (key: string) => Promise<void>,
  tries = 120,
  initial?: S,
): Promise<{ ok: boolean; state: S }> {
  let state = initial ?? (await read());
  let columns = 2;
  let stuck = 0;
  for (let i = 0; i < tries; i++) {
    const at = state.selectedIndex ?? state.listCursor;
    if ((targetName !== "" && state.selected === targetName) || at === targetIndex) {
      return { ok: true, state };
    }
    if (at === null) return { ok: false, state };
    const difference = targetIndex - at;
    const vertical = Math.abs(difference) >= columns;
    const key = vertical ? (difference > 0 ? "Down" : "Up") : difference > 0 ? "Right" : "Left";
    await press(key);
    const after = await read();
    const position = after.selectedIndex ?? after.listCursor;
    if (vertical) {
      // A wrap (bottom to top) has the wrong sign for the key and is not a column count.
      const step = position === null ? null : key === "Down" ? position - at : at - position;
      if (step !== null && step > 0 && step < state.names.length) columns = step;
    }
    if ((targetName !== "" && after.selected === targetName) || position === targetIndex) {
      return { ok: true, state: after };
    }
    stuck =
      after.selected === state.selected && after.listCursor === state.listCursor ? stuck + 1 : 0;
    if (stuck >= 3) return { ok: false, state: after };
    state = after;
  }
  return { ok: false, state };
}

async function steerItemList(
  pilot: Pilot,
  target: number,
  targetName: string,
  press: (key: string) => Promise<void>,
  tries = 120,
): Promise<{ ok: boolean; state: ItemListState }> {
  return await steerGridList(
    async () => await itemListState(pilot),
    target,
    targetName,
    press,
    tries,
  );
}

function keyRuns(keys: readonly string[]): string {
  const runs: string[] = [];
  let key = "";
  let count = 0;
  for (const next of keys) {
    if (next === key) {
      count += 1;
      continue;
    }
    if (key !== "") runs.push(count === 1 ? key : `${key}×${count}`);
    key = next;
    count = 1;
  }
  if (key !== "") runs.push(count === 1 ? key : `${key}×${count}`);
  return runs.join("→");
}

/**
 * Write the failed item-cursor read to the activity log. The bridge's item rows have no focus
 * column today, so the state says that instead of guessing; `selected` and the rows around it
 * still show where the game's cursor actually was (task 77).
 */
function reportItemFailure(
  report: ((message: string) => void) | undefined,
  target: string,
  targetIndex: number,
  state: ItemListState,
  pressed: readonly string[],
): void {
  const selectedAt = state.selectedIndex;
  const focus = state.focus === null ? "无" : `第 ${state.focus} 行`;
  report?.(
    `use_item 定位失败:目标「${target}」第 ${targetIndex} 行;` +
      `选中「${state.selected || "读不到"}」${selectedAt === null ? "" : `第 ${selectedAt} 行`};` +
      `listCursor=${state.listCursor ?? "读不到"};focus=${focus};键=${keyRuns(pressed)}`,
  );
  const parts = state.rows.map((row, index) => {
    const mark = index === state.focus ? "*" : "";
    return `${index}${mark}:${iconName(row.name) || "?"}×${num(row.count) ?? "?"}`;
  });
  let chunk = "";
  let number = 0;
  for (const part of parts) {
    if (chunk !== "" && `${chunk},${part}`.length > 140) {
      number += 1;
      report?.(`道具行 ${number}:${chunk}`);
      chunk = part;
    } else {
      chunk = chunk === "" ? part : `${chunk},${part}`;
    }
  }
  if (chunk !== "") {
    number += 1;
    report?.(`道具行 ${number}:${chunk}`);
  }
}

/**
 * Cast a spell from the field menu: Magic → caster → the list holding `spell` → target
 * (the caster when not given). Each step is checked against the menu the bridge (0.4.1+)
 * reads, and the result against HP and MP. Leaves the menu afterwards, whatever happened.
 */
export async function cast(
  pilot: Pilot,
  caster: string,
  spell: string,
  target?: string | null,
): Promise<[boolean, string]> {
  const pos = record((await pilot.send("pos")).pos);
  if (pos.state !== "Player") {
    return [false, `现在不能打开菜单(状态 ${show(pos.state)})`];
  }
  const party = await partyState(pilot);
  const names = party.map((member) => text(member.name));
  const who = pick(names, caster);
  if (who === null) {
    return [false, `队伍里没有「${caster}」,有:${names.filter(Boolean).join("、")}`];
  }
  const whom = pick(names, target ?? caster);
  if (whom === null) return [false, `队伍里没有「${show(target)}」`];
  try {
    return await castFromMenu(pilot, party, who, whom, spell);
  } finally {
    await leaveMenu(pilot);
  }
}

/**
 * Use an item from the field menu on a party member: Item → Use → the list holding it → target.
 * Each step is checked against the item window the bridge (0.4.1+) reads, and the result against
 * the bag, HP and statuses. Leaves the menu afterwards, whatever happened.
 */
export async function useItem(
  pilot: Pilot,
  item: string,
  target: string,
  report?: (message: string) => void,
): Promise<[boolean, string]> {
  const pos = record((await pilot.send("pos")).pos);
  if (pos.state !== "Player") {
    return [false, `现在不能打开菜单(状态 ${show(pos.state)})`];
  }
  const party = await partyState(pilot);
  const names = party.map((member) => text(member.name));
  const whom = pick(names, target);
  if (whom === null) {
    return [false, `队伍里没有「${target}」,有:${names.filter(Boolean).join("、")}`];
  }
  const [beforeCount, held] = await bagCount(pilot, item);
  if (beforeCount <= 0) {
    return [false, `包里没有「${item}」,有:${held.filter(Boolean).join("、") || "(空)"}`];
  }
  try {
    return await useFromMenu(pilot, party, whom, item, beforeCount, report);
  } finally {
    await leaveMenu(pilot);
  }
}

async function useFromMenu(
  pilot: Pilot,
  party: Reply[],
  whom: number,
  item: string,
  beforeCount: number,
  report?: (message: string) => void,
): Promise<[boolean, string]> {
  const pressed: string[] = [];
  const press = async (key: string, gap = 120): Promise<void> => {
    pressed.push(key);
    await pilot.send("keys", { keys: [key], gap });
  };
  const cursor =
    (...path: string[]) =>
    async (): Promise<number | null> => {
      let node: unknown = await menuState(pilot);
      for (const key of path) node = isRecord(node) ? node[key] : undefined;
      return num(node) ?? null;
    };

  const patient = party[whom] ?? {};
  const name = show(patient.name);
  const beforeStatuses = statuses(patient);
  const beforeHp = num(patient.hp) ?? 0;

  await press("Tab", 100);
  let menu = await waitMenu(pilot, (m) => truthy(m.open) && truthy(m.commands));
  const ids = records(menu.commands).map((command) => text(command.id));
  if (!ids.includes("Item")) {
    return [false, `菜单没有打开或没有「道具」:${show(menu)}`];
  }
  if (!(await steer(cursor("cursor"), press, ids.indexOf("Item")))) {
    return [false, "光标没能移到「道具」"];
  }
  await press("Enter");
  menu = await waitMenu(pilot, (m) => truthy(m.item) || m.state === "Item");
  let window = record(menu.item);
  if (!truthy(window)) return [false, `道具窗口没有打开:${show(menu)}`];
  if (window.state === "CommandSelect") {
    // 使用 / 整理 / 贵重物品: Use is the first command.
    if (!(await steer(cursor("item", "commandCursor"), press, 0))) {
      return [false, "光标没能移到「使用」"];
    }
    await press("Enter");
    menu = await waitMenu(
      pilot,
      (m) => record(m.item).state === "UseSelect" && records(record(m.item).rows).length > 0,
    );
    window = record(menu.item);
  }
  const rows = records(window.rows);
  if (window.state !== "UseSelect" || rows.length === 0) {
    return [false, `道具列表没有打开:${show(window)}`];
  }
  const itemNames = rows.map((row) => iconName(row.name));
  const found = pick(itemNames, item);
  if (found === null || (num(rows[found]?.count) ?? 0) <= 0) {
    return [false, `包里没有「${item}」,有:${itemNames.filter(Boolean).join("、")}`];
  }
  const steered = await steerItemList(pilot, found, itemNames[found] ?? item, press);
  if (!steered.ok) {
    reportItemFailure(report, itemNames[found] ?? item, found, steered.state, pressed);
    return [false, `光标没能移到「${show(itemNames[found])}」`];
  }
  await press("Enter");
  menu = await waitMenu(pilot, (m) => records(record(m.item).targets).length > 0);
  const use = record(menu.item);
  const targets = records(use.targets);
  if (targets.length === 0) return [false, `没有出现选择对象:${show(use)}`];
  if (use.targetMode !== "All") {
    const row = pick(
      targets.map((entry) => text(entry.name)),
      name,
    );
    if (row === null) {
      const can = targets
        .map((entry) => text(entry.name))
        .filter(Boolean)
        .join("、");
      return [false, `「${item}」不能对 ${name} 用(能选:${can})`];
    }
    if (!(await steer(cursor("item", "targetCursor"), press, row))) {
      return [false, `没能选中 ${name}`];
    }
  }
  await press("Enter");
  await pilot.sleep(1500); // the effect animation
  const afterParty = await partyState(pilot);
  const after = afterParty[whom] ?? {};
  const afterStatuses = statuses(after);
  const cured = beforeStatuses.filter(
    (status) => !afterStatuses.some((left) => left.includes(status) || status.includes(left)),
  );
  const afterHp = num(after.hp) ?? beforeHp;
  const [afterCount] = await bagCount(pilot, item);
  const used = show(itemNames[found]);
  if (cured.length > 0) return [true, `给 ${name} 用了「${used}」:${cured.join("、")} 治好了`];
  if (afterHp > beforeHp) return [true, `给 ${name} 用了「${used}」:HP ${beforeHp}→${afterHp}`];
  if (afterCount < beforeCount) return [true, `给 ${name} 用了「${used}」`];
  return [false, `「${used}」的数量没有减少(${beforeCount}),可能没用出去`];
}

/**
 * True only with explicit data. The bridge's `usable: false` cannot tell MP from scene, and an
 * unknown field is not evidence, so the caller says "cause unreadable" instead (11-09).
 */
function battleOnly(entry: Reply): boolean {
  return entry.battleOnly === true || entry.usableInField === false;
}

async function castFromMenu(
  pilot: Pilot,
  party: Reply[],
  who: number,
  whom: number,
  spell: string,
): Promise<[boolean, string]> {
  const press = async (key: string): Promise<void> => {
    await pilot.send("keys", { keys: [key], gap: 120 });
  };
  const cursor =
    (...path: string[]) =>
    async (): Promise<number | null> => {
      let node: unknown = await menuState(pilot);
      for (const key of path) node = isRecord(node) ? node[key] : undefined;
      return num(node) ?? null;
    };

  const caster = party[who] ?? {};
  const patient = party[whom] ?? {};
  await pilot.send("keys", { keys: ["Tab"], gap: 100 });
  let menu = await waitMenu(pilot, (m) => truthy(m.open) && truthy(m.commands));
  const ids = records(menu.commands).map((command) => text(command.id));
  if (!ids.includes("Magic")) {
    return [false, `菜单没有打开或没有「魔法」:${show(menu)}`];
  }
  if (!(await steer(cursor("cursor"), press, ids.indexOf("Magic")))) {
    return [false, "光标没能移到「魔法」"];
  }
  await press("Enter");
  // partyCursor is there on the top menu too; the state tells the party list has opened.
  menu = await waitMenu(pilot, (m) => truthy(m.magic) || m.state === "Magic");
  if (!truthy(menu.magic)) {
    // The game first asks whose magic.
    if (!(await steer(cursor("partyCursor"), press, who))) {
      return [false, `没能选中 ${show(caster.name)}:${show(menu)}`];
    }
    await press("Enter");
    menu = await waitMenu(pilot, (m) => truthy(m.magic));
  }
  const magic = record(menu.magic);
  if (!truthy(magic)) return [false, `魔法窗口没有打开:${show(menu)}`];
  if (
    magic.character !== null &&
    magic.character !== undefined &&
    magic.character !== caster.name
  ) {
    return [false, `打开的是 ${show(magic.character)} 的魔法`];
  }

  const inList = (m: Reply): boolean => record(m.magic).state === "MagicList";

  // Try each magic command (White, Black, ...) until a list holds the spell.
  let found: number | null = null;
  const seen: string[] = [];
  const commands = records(magic.commands);
  if (!commands.some((command) => truthy(command.enabled))) {
    // Spells are bought in magic shops; a new party knows none.
    return [false, `${show(caster.name)} 还没有学会任何魔法(魔法要在魔法店买)`];
  }
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    if (!inList(menu)) {
      if (command?.enabled === false) continue;
      if (!(await steer(cursor("magic", "commandCursor"), press, i))) continue;
      await press("Enter");
      menu = await waitMenu(pilot, inList);
    }
    const entries = records(record(menu.magic).abilities);
    seen.push(
      ...entries
        .map((entry) => text(entry.name))
        .filter((name): name is string => name !== undefined),
    );
    found = pick(
      entries.map((entry) => text(entry.name)),
      spell,
    );
    if (found !== null) break;
    if (inList(menu)) {
      await press("Backspace");
      menu = await waitMenu(pilot, (m) => !inList(m));
    }
  }
  if (found === null) {
    const known = seen.join("、") || "(一个也没读到)";
    return [false, `${show(caster.name)} 的魔法里没有「${spell}」,有:${known}`];
  }
  const entry = records(record(menu.magic).abilities)[found] ?? {};
  const spellName = iconName(entry.name) || show(entry.name);
  const cost = num(entry.mp);
  const casterMp = num(caster.mp);
  if (entry.usable === false) {
    // 11-09: at MP 0 the menu greys out a field spell too. `usable: false` only says "grey";
    // the old code guessed "battle only" and the model thought it could not heal on the map.
    if (cost !== undefined && casterMp !== undefined && casterMp < cost) {
      return [false, `${show(caster.name)} MP ${casterMp},不够放「${spellName}」(要 ${cost})`];
    }
    if (battleOnly(entry)) {
      return [false, `现在用不了「${spellName}」:这个魔法在地图上不能用(只能在战斗里用)`];
    }
    return [false, `菜单里「${spellName}」是灰的,原因读不到(可能是 MP 不够或这里不能用)`];
  }
  if (cost !== undefined && casterMp !== undefined && casterMp < cost) {
    return [false, `${show(caster.name)} MP ${casterMp},不够放「${spellName}」(要 ${cost})`];
  }
  // The list is a grid of every slot of the magic type, three a row, unlearned ones blank,
  // and the cursor moves over all of them; `abilities` holds the learned ones only (10-20:
  // 解毒 is at 2, behind an unlearned 侦测). contentIds (bridge 0.6.5+) gives each slot's
  // spell, so the cursor's goal is the slot of this spell. abilityIndex does not follow
  // the cursor.
  const slots = list(record(menu.magic).contentIds);
  const goal = slots.length > 0 && slots.includes(entry.id) ? slots.indexOf(entry.id) : found;
  if (!(await steer(cursor("magic", "abilityCursor"), press, goal))) {
    return [false, `光标没能移到「${show(entry.name)}」`];
  }
  await press("Enter");
  menu = await waitMenu(pilot, (m) => Boolean(record(m.magic).targets));
  const targets = records(record(menu.magic).targets);
  if (targets.length === 0) return [false, `没有出现选择对象:${show(menu.magic)}`];
  if (record(menu.magic).targetMode !== "All") {
    const row = pick(
      targets.map((target) => text(target.name)),
      show(patient.name),
    );
    if (row === null || !(await steer(cursor("magic", "targetCursor"), press, row))) {
      return [false, `没能选中 ${show(patient.name)}`];
    }
  }
  await press("Enter");
  await pilot.sleep(1500); // the effect animation
  const after = await partyState(pilot);
  const hp: [unknown, unknown] = [patient.hp, whom < after.length ? after[whom]?.hp : undefined];
  const mp: [unknown, unknown] = [caster.mp, who < after.length ? after[who]?.mp : undefined];
  if (
    mp[1] !== null &&
    mp[1] !== undefined &&
    mp[0] !== null &&
    mp[0] !== undefined &&
    Number(mp[1]) < Number(mp[0])
  ) {
    return [
      true,
      `${show(caster.name)} 用了「${show(entry.name)}」:` +
        `${show(patient.name)} HP ${show(hp[0])}→${show(hp[1])},MP ${show(mp[0])}→${show(mp[1])}`,
    ];
  }
  return [false, `MP 没有减少(${show(mp[0])}),可能没用出去`];
}

/**
 * Change one member's job from the field menu: Job → member → the job's grid cell → 是.
 * A job change takes off every piece of equipment, so the strongest equipment is put back on
 * afterwards. Leaves the menu whatever happened.
 */
export async function changeJob(
  pilot: Pilot,
  member: string,
  job: string,
): Promise<[boolean, string]> {
  const pos = record((await pilot.send("pos")).pos);
  if (pos.state !== "Player") {
    return [false, `现在不能打开菜单(状态 ${show(pos.state)})`];
  }
  const party = await partyState(pilot);
  const names = party.map((entry) => text(entry.name));
  const who = pick(names, member);
  if (who === null) {
    return [false, `队伍里没有「${member}」,有:${names.filter(Boolean).join("、")}`];
  }
  const person = party[who] ?? {};
  const name = show(person.name);
  const current = text(person.jobName);
  if (current === job) {
    return [false, `${name} 已经是「${job}」了`];
  }
  let changed: string;
  try {
    const [ok, detail] = await changeJobFromMenu(pilot, who, name, job);
    if (!ok) return [false, detail];
    changed = detail;
  } finally {
    await leaveMenu(pilot);
  }
  const [equipped, equipDetail] = await optimizeEquipment(pilot);
  if (!equipped) {
    return [true, `${name} 换成了${changed},但重新装备最强失败:${equipDetail}`];
  }
  return [true, `${name} 换成了${changed},已重新装备最强`];
}

async function changeJobFromMenu(
  pilot: Pilot,
  who: number,
  name: string,
  job: string,
): Promise<[boolean, string]> {
  const press = async (key: string): Promise<void> => {
    await pilot.send("keys", { keys: [key], gap: 120 });
  };
  const cursor =
    (...path: string[]) =>
    async (): Promise<number | null> => {
      let node: unknown = await menuState(pilot);
      for (const key of path) node = isRecord(node) ? node[key] : undefined;
      return num(node) ?? null;
    };

  await pilot.send("keys", { keys: ["Tab"], gap: 100 });
  let menu = await waitMenu(pilot, (m) => truthy(m.open) && truthy(m.commands));
  const ids = records(menu.commands).map((command) => text(command.id));
  const at = ids.indexOf("Job");
  if (at < 0) return [false, `菜单没有打开或没有「职业」:${show(menu)}`];
  if (!(await steer(cursor("cursor"), press, at))) {
    return [false, "光标没能移到「职业」"];
  }
  await press("Enter");
  // The game may ask whose job first, or open the window for the member already chosen.
  menu = await waitMenu(pilot, (m) => truthy(m.job) || m.state === "Job");
  if (!truthy(menu.job)) {
    if (!(await steer(cursor("partyCursor"), press, who))) {
      return [false, `没能选中 ${name}:${show(menu)}`];
    }
    await press("Enter");
  }
  // The cells are filled after the window appears; wait for names before picking one.
  menu = await waitMenu(pilot, (m) => records(record(m.job).jobs).length > 0);
  let window = record(menu.job);
  if (!truthy(window)) return [false, `职业窗口没有打开:${show(menu)}`];
  const opened = text(window.character);
  if (opened !== undefined && opened !== name) {
    return [false, `打开的是 ${opened} 的职业窗口`];
  }

  const cells = records(window.jobs);
  const jobNames = cells.map((cell) => text(cell.name));
  const found = pick(jobNames, job);
  if (found === null) {
    return [false, `没有「${job}」这个职业,有:${jobNames.filter(Boolean).join("、")}`];
  }
  const cell = cells[found] ?? {};
  const target = show(cell.name);
  if (cell.enabled === false) return [false, `${target} 还没解锁`];
  if (!(await moveJobGrid(pilot, window, cell, press))) {
    return [false, `光标没能移到「${target}」`];
  }
  await press("Enter");
  menu = await waitMenu(pilot, (m) => truthy(record(record(m.job).popup).open));
  window = record(menu.job);
  const popup = record(window.popup);
  if (!truthy(popup.open)) return [false, `没有出现确认弹窗:${show(window)}`];

  // 是 is the first command in FF5; match by text in case the order changes.
  const commands = records(popup.commands);
  const yes = pick(
    commands.map((command) => text(command.name)),
    "是",
  );
  if (!(await steer(cursor("job", "popup", "cursor"), press, yes ?? 0))) {
    return [false, "弹窗光标没能移到「是」"];
  }
  await press("Enter");
  // The changing animation runs for a moment; the sample is what the menu reads afterwards.
  const deadline = pilot.now() + 3000;
  let now: string | undefined;
  for (;;) {
    const after = await partyState(pilot);
    const person = after[who];
    now = text(person?.jobName);
    const wantedId = num(cell.id);
    const nowId = num(person?.job);
    // The id is the sure check; names are a fallback for an older bridge or a fake.
    const changed =
      wantedId !== undefined && nowId !== undefined ? nowId === wantedId : now === target;
    if (changed) return [true, target];
    if (pilot.now() > deadline) break;
    await pilot.sleep(200);
  }
  return [false, `确认后职业没有变成「${target}」(现在是 ${show(now)})`];
}

/** Walk the job grid row by row, then column by column, until the cursor is on `cell`. */
async function moveJobGrid(
  pilot: Pilot,
  window: Reply,
  cell: Reply,
  press: (key: string) => Promise<void>,
): Promise<boolean> {
  const start = record(window.gridCursor);
  let row = num(start.row);
  let col = num(start.col);
  const goalRow = num(cell.row);
  const goalCol = num(cell.col);
  if (row === undefined || col === undefined || goalRow === undefined || goalCol === undefined) {
    return false;
  }
  for (let i = 0; i < 60; i++) {
    if (row === goalRow && col === goalCol) return true;
    const key = row < goalRow ? "Down" : row > goalRow ? "Up" : col < goalCol ? "Right" : "Left";
    await press(key);
    const next = record(record((await menuState(pilot)).job).gridCursor);
    row = num(next.row);
    col = num(next.col);
    if (row === undefined || col === undefined) return false;
  }
  return false;
}

export async function leaveMenu(pilot: Pilot): Promise<string> {
  const result = await pilot.send("leave", {}, 30_000);
  if (truthy(result.ok)) {
    return `已回到地图(按了 ${show(result.presses)} 次返回)`;
  }
  return `没能退出:${show(result.error)}(状态 ${show(record(result.pos).state)})`;
}

/** The equipment commands: Equip, Strongest, Remove everything (EquipmentCommandId). */
export const STRONGEST = 1;

/**
 * 「最强装备」for every member: menu → Equipment → member → Strongest. Reports what
 * changed, read from the equipment slots before and after. Leaves the menu afterwards.
 */
export async function optimizeEquipment(pilot: Pilot): Promise<[boolean, string]> {
  const pos = record((await pilot.send("pos")).pos);
  if (pos.state !== "Player") {
    return [false, `现在不能打开菜单(状态 ${show(pos.state)})`];
  }
  try {
    return await optimizeFromMenu(pilot);
  } finally {
    await leaveMenu(pilot);
  }
}

async function optimizeFromMenu(pilot: Pilot): Promise<[boolean, string]> {
  const press = async (key: string): Promise<void> => {
    await pilot.send("keys", { keys: [key], gap: 120 });
  };
  const equipment = async (): Promise<Reply> => record((await menuState(pilot)).equipment);
  const readCursor = (path: string) => async (): Promise<number | null> =>
    num((await menuState(pilot))[path]) ?? null;

  const party = await partyState(pilot);
  await pilot.send("keys", { keys: ["Tab"], gap: 100 });
  const menu = await waitMenu(pilot, (m) => truthy(m.open) && truthy(m.commands));
  const ids = records(menu.commands).map((command) => text(command.id));
  if (!ids.includes("Equipment")) {
    return [false, `菜单没有打开或没有「装备」:${show(menu)}`];
  }
  if (!(await steer(readCursor("cursor"), press, ids.indexOf("Equipment")))) {
    return [false, "光标没能移到「装备」"];
  }
  await press("Enter");
  await waitMenu(pilot, (m) => m.state === "Equipment" || truthy(m.equipment));
  const changes: string[] = [];
  for (let i = 0; i < party.length; i++) {
    const member = party[i] ?? {};
    if (!(await steer(readCursor("partyCursor"), press, i))) {
      return [false, `没能选中 ${show(member.name)}`];
    }
    await press("Enter");
    const opened = await waitMenu(pilot, (m) => record(m.equipment).state === "Command");
    const before = records(record(opened.equipment).slots).map((slot) => slot.item);
    if (
      !(await steer(async () => num((await equipment()).commandCursor) ?? null, press, STRONGEST))
    ) {
      return [false, `${show(member.name)}:光标没能移到「最强装备」`];
    }
    await press("Enter");
    await pilot.sleep(600);
    const after = records((await equipment()).slots).map((slot) => slot.item);
    const changed: string[] = [];
    for (let k = 0; k < Math.min(before.length, after.length); k++) {
      const a = before[k];
      const b = after[k];
      if (a !== b) changed.push(`${show(a || "空")}→${show(b || "空")}`);
    }
    changes.push(`${show(member.name)}:${changed.length > 0 ? changed.join("、") : "没有更好的"}`);
    await press("Backspace"); // back to choosing a member
    await waitMenu(pilot, (m) => record(m.equipment).state !== "Command");
  }
  return [true, "最强装备:" + changes.join(";")];
}

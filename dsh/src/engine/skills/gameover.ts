/**
 * Task 91: the game-over prompts FF5 opens after a wipe or the escape countdown running out.
 * The user's 11-10 rule: never load the automatic save; go back to the title and load slot 20.
 * Every key is checked against the bridge's reading first (prompt + cursor, then the title's
 * commands, then the save list's highlighted slot), so a wrong cursor stops the flow instead of
 * pressing blindly. An older bridge without the `gameover` field does nothing at all.
 */

import type { Pilot, Reply } from "../pilot.ts";
import { parsePositionReply } from "../position.ts";
import { list, num, records, record, text, truthy } from "../values.ts";
import { highlightedSlot, moveToSlot, saveUi } from "./save.ts";

export interface GameoverInfo {
  readonly open: boolean;
  /** "continue" (要从最新的保存数据开始吗) or "to-title" (返回标题画面), null when unread. */
  readonly prompt: "continue" | "to-title" | null;
  /** 0 is 是, 1 is 否; null when the bridge cannot read it. */
  readonly cursor: number | null;
  readonly autosave: unknown;
}

export interface GameoverResult {
  readonly ok: boolean;
  readonly text: string;
}

const STORY_TIMEOUT_MS = 120_000;
const KEY_GAP_MS = 250;

function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value).map(([key, item]) => `'${key}': ${show(item)}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** Narrow the bridge's `gameover` object; an absent or malformed field means "old bridge". */
export function parseGameoverInfo(value: unknown): GameoverInfo | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const raw = record(value);
  const prompt = text(raw.prompt);
  return {
    open: raw.open === true,
    prompt: prompt === "continue" || prompt === "to-title" ? prompt : null,
    cursor: num(raw.cursor) ?? null,
    autosave: raw.autosave,
  };
}

/** Read `sample.gameover`; null on an older bridge (no field) or a failed read. */
export async function readGameover(pilot: Pilot): Promise<GameoverInfo | null> {
  try {
    const sample = record((await pilot.query("sample")).sample);
    if (!("gameover" in sample)) return null;
    return parseGameoverInfo(sample.gameover);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  }
}

/** The line a failure reports: what the popup actually says now. */
function describe(state: GameoverInfo | null): string {
  if (state === null) return "读不到 gameover";
  if (!state.open) return "弹窗已经关了";
  const prompt =
    state.prompt === "continue"
      ? "要从最新的保存数据开始吗"
      : state.prompt === "to-title"
        ? "返回标题画面"
        : "prompt 读不到";
  return `${prompt}，光标 ${state.cursor === null ? "读不到" : String(state.cursor)}`;
}

async function press(pilot: Pilot, keys: readonly string[], gap = KEY_GAP_MS): Promise<boolean> {
  const reply = await pilot.send("keys", { keys: [...keys], gap, via: "game" }, 10_000);
  return truthy(reply.ok);
}

/**
 * Move the game-over cursor to `target`, reading the popup before every key and after it. A
 * changed prompt or a cursor that does not land where asked is a stop, never a blind Enter.
 */
async function moveCursor(
  pilot: Pilot,
  before: GameoverInfo,
  target: number,
): Promise<{ ok: true; state: GameoverInfo } | { ok: false; text: string }> {
  let state = before;
  for (let tries = 0; tries < 6; tries++) {
    if (state.cursor === target) return { ok: true, state };
    if (state.cursor === null) {
      return { ok: false, text: `读不到光标:${describe(state)};没有按键` };
    }
    // 11-10 real device: the two popups lay 是/否 out side by side; Right moved 0→1, Left 1→0.
    const key = target > state.cursor ? "Right" : "Left";
    if (!(await press(pilot, [key]))) {
      return { ok: false, text: `按 ${key} 失败:${describe(state)}` };
    }
    await pilot.sleep(300);
    const after = await readGameover(pilot);
    if (!after?.open) {
      return { ok: false, text: `按键后弹窗变了:${describe(after)}` };
    }
    if (after.prompt !== state.prompt) {
      return { ok: false, text: `按键后换成了另一个框:${describe(after)}` };
    }
    state = after;
  }
  return { ok: false, text: `光标没能到第 ${target} 项:${describe(state)}` };
}

/** Wait for the title menu, pressing Enter only while both title and game-over are closed. */
async function waitTitle(
  pilot: Pilot,
  deadline: number,
): Promise<{ ok: true; title: Reply } | { ok: false; text: string }> {
  for (;;) {
    const gameover = await readGameover(pilot);
    if (gameover === null) return { ok: false, text: "读不到 gameover，不按任何键" };
    if (gameover.open) return { ok: false, text: `标题前又出现了弹窗:${describe(gameover)}` };
    let title: Reply;
    try {
      title = record((await pilot.query("title")).title);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return { ok: false, text: `读不到标题画面:${String(error)}` };
    }
    if (truthy(title.open)) return { ok: true, title };
    if (title.open !== false) return { ok: false, text: `标题状态读不到:${show(title)}` };
    if (pilot.now() >= deadline) return { ok: false, text: "等不到标题画面" };
    if (!(await press(pilot, ["Enter"], 500))) {
      return { ok: false, text: "按 Enter 过片头失败" };
    }
    await pilot.sleep(1_000);
  }
}

/** After a confirmed popup, wait until that same prompt is gone instead of pressing again. */
async function waitAfterConfirm(
  pilot: Pilot,
  before: "continue" | "to-title",
): Promise<{ ok: true; state: GameoverInfo } | { ok: false; text: string }> {
  const deadline = pilot.now() + 5_000;
  for (;;) {
    const next = await readGameover(pilot);
    if (next === null) return { ok: false, text: "读不到 gameover" };
    if (!next.open || next.prompt !== before) return { ok: true, state: next };
    if (pilot.now() >= deadline) {
      return { ok: false, text: `按键后还是同一个框:${describe(next)}` };
    }
    await pilot.sleep(300);
  }
}

/** Move the title cursor onto LoadGame, checking every command list and cursor reading. */
async function moveToLoadGame(
  pilot: Pilot,
  title: Reply,
): Promise<{ ok: true; title: Reply } | { ok: false; text: string }> {
  const targetOf = (current: Reply): number => {
    const commands = records(current.commands);
    return commands.findIndex(
      (command) =>
        (text(command.id) ?? "").toLowerCase() === "loadgame" ||
        (text(command.name) ?? "").includes("读取") ||
        (text(command.name) ?? "").toLowerCase().includes("load"),
    );
  };
  const signature = (current: Reply): string =>
    records(current.commands)
      .map((command) => `${text(command.id) ?? ""}:${text(command.name) ?? ""}`)
      .join("|");
  const target = targetOf(title);
  if (target < 0) return { ok: false, text: `标题里没有 LoadGame:${show(title.commands)}` };
  const command = records(title.commands)[target];
  if (command?.defaultColor === false) {
    return { ok: false, text: "标题的 LoadGame 是灰的，不能读档" };
  }
  const wanted = signature(title);
  let state = title;
  for (let tries = 0; tries < 12; tries++) {
    const cursor = num(state.cursor) ?? null;
    if (cursor === target) return { ok: true, title: state };
    if (cursor === null) return { ok: false, text: `读不到标题光标:${show(state)}` };
    const key = target > cursor ? "Down" : "Up";
    if (!(await press(pilot, [key]))) {
      return { ok: false, text: `按 ${key} 移动标题光标失败:${show(state)}` };
    }
    await pilot.sleep(250);
    let after: Reply;
    try {
      after = record((await pilot.query("title")).title);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return { ok: false, text: `按键后读不到标题:${String(error)}` };
    }
    if (!truthy(after.open)) return { ok: false, text: `按键后标题关了:${show(after)}` };
    if (signature(after) !== wanted) {
      return { ok: false, text: `标题的命令变了:${show(after.commands)}` };
    }
    state = after;
  }
  return { ok: false, text: `光标没能移到 LoadGame:${show(state)}` };
}

/**
 * The whole recovery: continue popup → 否, return-to-title popup → 是, title → LoadGame,
 * save list → slot 20, confirm 是, wait for Player. Returns null when there is nothing to do
 * (not open, or an older bridge with no `gameover` field).
 */
export async function recoverFromGameover(pilot: Pilot, slot = 20): Promise<GameoverResult | null> {
  let state = await readGameover(pilot);
  if (state === null) return null;
  if (!state.open) return null;

  for (let guard = 0; guard < 4; guard++) {
    const prompt = state.prompt;
    if (prompt === "continue") {
      const moved = await moveCursor(pilot, state, 1);
      if (!moved.ok) return { ok: false, text: `游戏结束处理停下:${moved.text}` };
      if (!(await press(pilot, ["Enter"]))) {
        return { ok: false, text: `游戏结束处理停下:确认「否」失败:${describe(moved.state)}` };
      }
    } else if (prompt === "to-title") {
      const moved = await moveCursor(pilot, state, 0);
      if (!moved.ok) return { ok: false, text: `游戏结束处理停下:${moved.text}` };
      if (!(await press(pilot, ["Enter"]))) {
        return { ok: false, text: `游戏结束处理停下:确认「是」失败:${describe(moved.state)}` };
      }
    } else {
      return { ok: false, text: `游戏结束处理停下:${describe(state)};没有按键` };
    }
    const confirmed = await waitAfterConfirm(pilot, prompt);
    if (!confirmed.ok) return { ok: false, text: `游戏结束处理停下:${confirmed.text}` };
    if (!confirmed.state.open) break;
    state = confirmed.state;
    if (guard === 3) return { ok: false, text: `游戏结束处理停下:弹窗还在:${describe(state)}` };
  }

  const deadline = pilot.now() + STORY_TIMEOUT_MS;
  const titled = await waitTitle(pilot, deadline);
  if (!titled.ok) return { ok: false, text: `游戏结束处理停下:${titled.text}` };
  const picked = await moveToLoadGame(pilot, titled.title);
  if (!picked.ok) return { ok: false, text: `游戏结束处理停下:${picked.text}` };
  if (!(await press(pilot, ["Enter"]))) {
    return { ok: false, text: "游戏结束处理停下:打开读档列表失败" };
  }

  const ui = await saveUi(
    pilot,
    (candidate) => truthy(candidate.open) && list(candidate.slots).length > 0,
    10,
  );
  if (!truthy(ui.open)) return { ok: false, text: "游戏结束处理停下:读档列表没有打开" };
  const slots = list(ui.slots);
  if (!slots.includes(slot)) {
    return { ok: false, text: `游戏结束处理停下:读档列表里没有 ${slot} 号位(${slots.join("、")})` };
  }
  if ((await moveToSlot(pilot, ui, slot)) === null) {
    return { ok: false, text: `游戏结束处理停下:光标没能移到 ${slot} 号位` };
  }
  const checked = record((await pilot.query("saveui")).saveui);
  if (highlightedSlot(checked) !== slot) {
    return {
      ok: false,
      text: `游戏结束处理停下:光标不在 ${slot} 号位(${show(highlightedSlot(checked))})`,
    };
  }
  if (!(await press(pilot, ["Enter"]))) {
    return { ok: false, text: `游戏结束处理停下:确认 ${slot} 号位失败` };
  }
  await pilot.sleep(500);
  // The "load this data?" prompt starts on No; Left then Enter is the reference flow in
  // .deps/tmp/load-slot.py and skills/save.ts's loadGame.
  if (!(await press(pilot, ["Left"]))) {
    return { ok: false, text: "游戏结束处理停下:把读档确认移到「是」失败" };
  }
  await pilot.sleep(300);
  if (!(await press(pilot, ["Enter"], 600))) {
    return { ok: false, text: "游戏结束处理停下:确认读档失败" };
  }

  const loadingDeadline = pilot.now() + STORY_TIMEOUT_MS;
  let last = "读不到位置";
  while (pilot.now() < loadingDeadline) {
    try {
      const pos = parsePositionReply(await pilot.send("pos"));
      last = `状态 ${pos.state ?? "读不到"}`;
      if (pos.state === "Player") {
        const where = pos.cell === null ? "未知格子" : `(${pos.cell[0]},${pos.cell[1]})`;
        return {
          ok: true,
          text:
            `游戏结束了(倒计时到点/全灭),已回标题读 ${slot} 号位第 ${pos.saves ?? "?"} 次存档，` +
            `现在在地图 ${pos.map ?? "?"} ${where}`,
        };
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      last = String(error);
    }
    await pilot.sleep(500);
  }
  return { ok: false, text: `游戏结束处理停下:读档后没有回到地图(${last})` };
}

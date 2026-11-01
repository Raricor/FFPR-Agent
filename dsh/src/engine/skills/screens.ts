/**
 * Screens the old story loop could not get past (task 22): the first-visit FieldHelp overlay,
 * the naming box (`TextEnter`), and the `advance_story` paging loop with its stuck guard. The
 * five newly started games also get a free-form `press` for menus no tool understands.
 *
 * The bridge 0.10.0 additions are in `pos.state`, the `textinput` query and the Pad keys plus
 * TextEnter; an older bridge simply has no focused text field, and is skipped.
 */

import type { Pilot, Reply } from "../pilot.ts";
import { isRecord, list, record, text, truthy } from "../values.ts";
import type { Json } from "../values.ts";

/** Keys `press` accepts: the gamepad's buttons as bridge 0.10.0 names them. */
export const PRESS_KEYS: readonly string[] = [
  "Enter",
  "Backspace",
  "Up",
  "Down",
  "Left",
  "Right",
  "Tab",
  "PadStart",
  "PadWest",
];

export const FIELD_HELP_STUCK = "关不掉操作提示:按了 3 次 PadStart 还在 FieldHelp,先手动关掉再试";

export type FieldHelpResult = "absent" | "closed" | "stuck";

function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  return JSON.stringify(value);
}

async function position(pilot: Pilot): Promise<Reply> {
  return record((await pilot.send("pos")).pos);
}

/**
 * Close the first-visit operation hints with PadStart. Confirm and cancel do not close it
 * (10-28, FF3); three presses that leave `state` at FieldHelp mean it is not that overlay, so
 * the caller stops rather than pressing on.
 */
export async function dismissFieldHelp(pilot: Pilot): Promise<FieldHelpResult> {
  let pressed = 0;
  for (;;) {
    const state = text((await position(pilot)).state) ?? "";
    if (state !== "FieldHelp") return pressed === 0 ? "absent" : "closed";
    if (pressed >= 3) return "stuck";
    const result = await pilot.send("keys", { keys: ["PadStart"], gap: 250, via: "game" }, 10_000);
    if (!truthy(result.ok)) throw new Error(`按 PadStart 关操作提示失败:${show(result.error)}`);
    pressed += 1;
    await pilot.sleep(400);
  }
}

export interface StoryOutcome {
  readonly pages: number;
  readonly notes: string[];
  /** free, choice, battle, state:X, timeout, stuck or fieldhelp. */
  readonly stop: string;
  /** The screen that stopped the loop, for the tool result. */
  readonly detail: string;
}

export interface StoryOptions {
  readonly pageMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_PAGE_MS = 3000;
const DEFAULT_TIMEOUT_MS = 600_000;
/** Presses with an unchanged screen before advance_story gives up (task 22). */
const STUCK_PRESSES = 8;
/**
 * A cutscene (`Event`) has no dialog to page and must not be pressed through; wait this long
 * for it to change on its own before reporting that it is stuck.
 */
const EVENT_STUCK_MS = 60_000;
const EVENT_POLL_MS = 1000;

/**
 * Page through dialog at reading speed until the player is free, a choice or battle appears, or
 * a shop/menu opens. Naming boxes are confirmed with their default name; choices are never
 * answered. Eight Enter presses that leave state, map, dialog text and choices alone mean the
 * screen is not a dialog, so it stops instead of pressing for ten minutes (10-28).
 */
export async function advanceStory(
  pilot: Pilot,
  options: StoryOptions = {},
): Promise<StoryOutcome> {
  const pageMs = options.pageMs ?? DEFAULT_PAGE_MS;
  const deadline = pilot.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const notes: string[] = [];
  let pages = 0;
  let previous: string | null = null;
  let unchanged = 0;
  let eventKey: string | null = null;
  let eventSince = 0;
  for (;;) {
    if (pilot.now() >= deadline) {
      return { pages, notes, stop: "timeout", detail: "等了太久,画面还没结束" };
    }
    const named = await nameFocusedField(pilot);
    if (named !== null) {
      notes.push(named);
      await pilot.sleep(400);
      continue;
    }
    const pos = await position(pilot);
    const state = text(pos.state) ?? "";
    if (state === "FieldHelp") {
      const help = await dismissFieldHelp(pilot);
      if (help === "stuck") {
        return { pages, notes, stop: "fieldhelp", detail: await screenDetail(pilot, pos) };
      }
      if (help === "closed") notes.push("关掉了操作提示");
      continue;
    }
    const sample = record((await pilot.query("sample")).sample);
    const choice = choiceSummary(sample);
    const dialog = dialogSummary(sample);
    const detail = describeScreen(pos, choice, dialog);
    if (choice.open) return { pages, notes, stop: "choice", detail };
    if (truthy(pos.battle) || truthy(record(sample.battle).active)) {
      return { pages, notes, stop: "battle", detail };
    }
    if (state === "Shop" || state === "Menu" || state === "ChangeName") {
      return { pages, notes, stop: `state:${state}`, detail };
    }
    if (state === "Player" && !dialog.open) return { pages, notes, stop: "free", detail };
    if (state === "Event" && !dialog.open) {
      // A cutscene advances by itself: wait for it instead of pressing Enter through it.
      const key = screenKey(pos, choice, dialog);
      if (key !== eventKey) {
        eventKey = key;
        eventSince = pilot.now();
      }
      if (pilot.now() - eventSince >= EVENT_STUCK_MS) {
        return { pages, notes, stop: "stuck", detail };
      }
      await pilot.sleep(EVENT_POLL_MS);
      continue;
    }
    eventKey = null;
    await pilot.sleep(pageMs);
    const key = screenKey(pos, choice, dialog);
    if (key === previous) unchanged += 1;
    else {
      previous = key;
      unchanged = 0;
    }
    if (unchanged >= STUCK_PRESSES) return { pages, notes, stop: "stuck", detail };
    const result = await pilot.send("keys", { keys: ["Enter"], gap: 250, via: "game" }, 10_000);
    if (!truthy(result.ok)) {
      return { pages, notes, stop: `keys:${show(result.error)}`, detail };
    }
    pages += 1;
  }
}

/**
 * A focused naming box: keep its default text with TextEnter, then Enter the 是/否 prompt whose
 * cursor starts on 是. Returns the line for the tool result, or null when no box is focused.
 * FF5's story op also calls this, so a new-game naming box does not stop its paging (10-29).
 */
export async function nameFocusedField(pilot: Pilot): Promise<string | null> {
  const reply = record(await pilot.query("textinput"));
  const input = record(reply.textinput);
  if (!truthy(input.open)) return null;
  const field = list(input.fields)
    .map((item) => record(item))
    .find((item) => truthy(item.focused));
  if (field === undefined) return null;
  const name = (text(field.text) ?? "").trim() || (text(field.name) ?? "").trim() || "角色";
  const typed = await pilot.send("keys", { keys: ["TextEnter"], gap: 250, via: "game" }, 10_000);
  if (!truthy(typed.ok)) throw new Error(`按 TextEnter 确认默认名失败:${show(typed.error)}`);
  await pilot.sleep(300);
  const confirmed = await pilot.send("keys", { keys: ["Enter"], gap: 250, via: "game" }, 10_000);
  if (!truthy(confirmed.ok)) throw new Error(`确认默认名失败:${show(confirmed.error)}`);
  return `给 ${name} 起名(默认名)`;
}

interface DialogSummary {
  readonly open: boolean;
  readonly line: string;
}

interface ChoiceSummary {
  readonly open: boolean;
  readonly line: string;
}

function dialogSummary(sample: Json): DialogSummary {
  const dialog = record(sample.dialog);
  const line = list(dialog.lines).filter(truthy).map(show).join(" / ");
  const speaker = truthy(dialog.speaker) ? `【${show(dialog.speaker)}】` : "";
  return { open: truthy(dialog.open), line: `${speaker}${line}` };
}

function choiceSummary(sample: Json): ChoiceSummary {
  for (const [kind, value] of Object.entries(record(sample.choice))) {
    if (!isRecord(value) || !truthy(value.open)) continue;
    const options = truthy(value.options)
      ? value.options
      : truthy(value.labels)
        ? value.labels
        : [];
    const marked = list(options).map((option, index) =>
      index === value.cursor ? `[${show(option)}]` : show(option),
    );
    return { open: true, line: `选项(${kind}):${marked.join(" / ")}` };
  }
  return { open: false, line: "" };
}

/** What must stay the same across eight presses: state, map, dialog text and choices. */
function screenKey(pos: Json, choice: ChoiceSummary, dialog: DialogSummary): string {
  return JSON.stringify([
    pos.state ?? null,
    pos.map ?? null,
    dialog.open ? dialog.line : "",
    choice.open ? choice.line : "",
  ]);
}

function describeScreen(pos: Json, choice: ChoiceSummary, dialog: DialogSummary): string {
  const parts = [`主状态 ${show(pos.state)}`, `地图 ${show(pos.map)}`];
  if (dialog.open) parts.push(`对话 ${dialog.line}`);
  if (choice.open) parts.push(choice.line);
  return parts.join(" · ");
}

/** The screen as the tool result shows it after a stuck FieldHelp (the state may have moved). */
async function screenDetail(pilot: Pilot, pos: Reply): Promise<string> {
  const sample = record((await pilot.query("sample")).sample);
  return describeScreen(pos, choiceSummary(sample), dialogSummary(sample));
}

/** The `press` argument: 1–6 keys, all from PRESS_KEYS. */
export function pressKeys(value: unknown): string[] {
  const keys = list(value).map((key) => (typeof key === "string" ? key : ""));
  if (keys.length === 0) throw new Error("press 至少要 1 个按键");
  if (keys.length > 6) throw new Error(`press 一次最多按 6 个键,这次给了 ${keys.length} 个`);
  const invalid = keys.filter((key) => !PRESS_KEYS.includes(key));
  if (invalid.length > 0) {
    throw new Error(
      `press 不接受这些键:${invalid.map((key) => key || "?").join("、")};` +
        `可选:${PRESS_KEYS.join("、")}`,
    );
  }
  return keys;
}

/** Press the keys through the game's virtual pad and give the screen a moment to change. */
export async function pressOnScreen(pilot: Pilot, keys: readonly string[]): Promise<void> {
  const result = await pilot.send("keys", { keys: [...keys], gap: 250, via: "game" }, 30_000);
  if (!truthy(result.ok)) throw new Error(`按键没按成:${show(result.error)}`);
  await pilot.sleep(500);
}

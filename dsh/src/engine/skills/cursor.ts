/**
 * Finding menu entries by name and moving a menu cursor onto them. Ported from
 * ffpr_agent/skills/cursor.py.
 */

import type { Pilot } from "../pilot.ts";

/** Index of the entry whose name matches `wanted` (exact first, then containment). */
export function pick(names: readonly (string | null | undefined)[], wanted: string): number | null {
  for (let i = 0; i < names.length; i++) {
    if (names[i] === wanted) return i;
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name && wanted && (wanted.includes(name) || name.includes(wanted))) return i;
  }
  return null;
}

export async function moveCursor(pilot: Pilot, at: number, to: number): Promise<void> {
  if (to !== at) {
    const key = to > at ? "Down" : "Up";
    await pilot.send("keys", { keys: [`${key}*${Math.abs(to - at)}`], gap: 110 });
  }
}

/**
 * Move a menu cursor to `target` one key at a time, reading the cursor after each press.
 * Lists go Up/Down; when Down does not move the cursor (a row of commands) or jumps past
 * the target (a two-column grid), Right/Left take over. False if the cursor gets stuck.
 */
export async function steer(
  read: () => number | null | Promise<number | null>,
  press: (key: string) => void | Promise<void>,
  target: number,
  tries = 40,
): Promise<boolean> {
  let keys = ["Down", "Up"];
  for (let i = 0; i < tries; i++) {
    const at = await read();
    if (at === null) return false;
    if (at === target) return true;
    const forward = at < target;
    await press(forward ? (keys[0] ?? "Down") : (keys[1] ?? "Up"));
    const now = await read();
    const stuck = now === at;
    const overshot = now !== null && (forward ? now > target : now < target);
    if (stuck && keys[0] === "Right" && keys[1] === "Left") return false;
    if (stuck || overshot) keys = ["Right", "Left"];
  }
  return (await read()) === target;
}

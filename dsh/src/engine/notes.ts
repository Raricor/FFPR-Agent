/**
 * The player's notes kept between runs, ported from ffpr_agent/ds/game.py:load_notes. Only the
 * newest MAX_NOTES survive; a missing file is an empty list so a first run needs no setup.
 */

import { readFile } from "node:fs/promises";
import { describeError, isMissingFile } from "./errors.ts";

export const MAX_NOTES = 40;

export async function loadNotes(path: string, signal?: AbortSignal): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFile(error)) return [];
    signal?.throwIfAborted();
    throw new Error(`读不了笔记文件 ${path}:${describeError(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`读不懂笔记文件 ${path}:${describeError(error)}`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(`笔记文件 ${path} 不是 JSON 字符串数组`);
  const notes: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") throw new Error(`笔记文件 ${path} 里有不是字符串的条目`);
    notes.push(item);
  }
  return notes.slice(-MAX_NOTES);
}

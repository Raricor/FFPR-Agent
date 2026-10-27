/**
 * The notes the model reads each step. The agent preset's persona is a `complete: true` section,
 * so a prompt section would never reach the model; dsh-system-prompt keeps dynamic context even
 * then, and materializes it as a durable user snapshot only when its text changes. Format matches
 * ffpr_agent/ds/loop.py.
 */

import type { PromptContext } from "@deepseek-ai/dsh-system-prompt";

export const NOTES_CONTEXT_NAME = "ffpr:notes";

/** Registered after dsh's own runtime facts (working directory, sandbox, ...). */
export const NOTES_CONTEXT_ORDER = 1000;

export const TACTICIAN_CONTEXT_NAME = "ffpr:tactician";

/** Right after the notes, also required under the preset's complete persona. */
export const TACTICIAN_CONTEXT_ORDER = 1001;

/** "你记下的:\n1. …\n2. …", or "" for no notes. */
export function formatNotes(notes: readonly string[]): string {
  if (notes.length === 0) return "";
  const lines = notes.map((note, index) => `${index + 1}. ${note}`);
  return `你记下的:\n${lines.join("\n")}`;
}

/**
 * The notes contribution itself. `required` keeps it visible under the preset's
 * `includeRuntimeContext: false`; interpolation stays off because note text is literal.
 */
export function notesContext(text: () => string): PromptContext {
  return {
    name: NOTES_CONTEXT_NAME,
    order: NOTES_CONTEXT_ORDER,
    text,
    interpolate: false,
    required: true,
  };
}

/** The current map's tactician notes, formatted like the notes block ("" before one speaks). */
export function formatTactician(
  info: { mapId: number; walkerNotes: string; askUp: string } | null,
): string {
  if (info === null) return "";
  const lines = [`战术官(地图 ${info.mapId}):${info.walkerNotes}`];
  if (info.askUp !== "") lines.push(`战术官建议:${info.askUp}`);
  return lines.join("\n");
}

export function tacticianContext(text: () => string): PromptContext {
  return {
    name: TACTICIAN_CONTEXT_NAME,
    order: TACTICIAN_CONTEXT_ORDER,
    text,
    interpolate: false,
    required: true,
  };
}

/**
 * Per-game hooks the six player presets publish so a preset switch can mount the target's
 * tools and persona inside the same `agent/created` dispatch (task 32, 11-02 real machine).
 *
 * The registry lives on globalThis, like registry.ts: the six presets may hold different module
 * instances, and the switch runs in the old preset's instance but must call the target's mount.
 * Each plugin registers once and its disposer removes only that exact object; a newer instance
 * of the same game stays registered when an older one unloads.
 */

import type { Agent } from "@deepseek-ai/dsh-agent";

/** One player preset's per-session mount and unmount. */
export interface PresetMount {
  mount(agent: Agent): void;
  unmount(sessionId: string): void;
}

const PRESET_MOUNTS = Symbol.for("@local/ffpr-dsh/preset-mounts");
const holder = globalThis as unknown as Record<symbol, unknown>;

function table(): Map<string, PresetMount> {
  const existing = holder[PRESET_MOUNTS];
  if (existing instanceof Map) return existing as Map<string, PresetMount>;
  const created = new Map<string, PresetMount>();
  holder[PRESET_MOUNTS] = created;
  return created;
}

export function presetMountFor(game: string): PresetMount | undefined {
  return table().get(game.toLowerCase());
}

/** Register this plugin instance's hooks; the disposer is a no-op once replaced by a newer one. */
export function registerPresetMount(game: string, mount: PresetMount): () => void {
  const key = game.toLowerCase();
  const mounts = table();
  mounts.set(key, mount);
  return () => {
    if (mounts.get(key) === mount) mounts.delete(key);
  };
}

/** Tests with different fake plugin instances must not inherit each other's hooks. */
export function resetPresetMounts(): void {
  holder[PRESET_MOUNTS] = undefined;
}

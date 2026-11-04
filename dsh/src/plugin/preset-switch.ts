/**
 * One new session, one open game: before dsh releases the user's first message, switch the fresh
 * agent to the player preset of the game the laptop actually has open (task 32). The detection
 * answer comes from task 31's shared cache; this module only adds the time budget, the preset id
 * table and the logging.
 *
 * `agentPresets.select` comes from @deepseek-ai/dsh-agent-preset-registry. It rebinds a blank
 * agent's scope parent to an already-loaded preset revision; it does not wait for the current
 * `agent/created` dispatch (see README.zh.md "空白会话的切换记录" and index.js `select`).
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, SessionStartSource } from "@deepseek-ai/dsh-agent";
import type { AgentPresetRegistry } from "@deepseek-ai/dsh-agent-preset-registry";
import { describeError } from "../engine/errors.ts";
import { byKey } from "../engine/games.ts";
import type { Config } from "./config.ts";
import type { DetectionResult, RunningDetector } from "./detect.ts";
import { presetMountFor, type PresetMount } from "./preset-hooks.ts";

/** The registry methods this feature needs; tests supply a recording fake. */
export type PresetSelector = Pick<AgentPresetRegistry, "select" | "composedPreset">;

/** Only the agent/created fields used here. */
export interface CreatedAgent {
  readonly agent: Agent;
  readonly source: SessionStartSource;
  readonly signal?: AbortSignal;
}

interface PresetLog {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * The player preset that plays one title (task 21's patch). FF5 keeps the short `ffpr`; the other
 * five are `ffpr-ffN`. Kept in one function so the patch consistency test has one source.
 */
export function playerPresetId(game: string): string {
  const key = byKey(game).key;
  return key === "ff5" ? "ffpr" : `ffpr-${key}`;
}

/**
 * Handle one agent/created event. Never rejects: dsh-agent rolls back the whole session creation
 * when a serial listener throws, so every failure (including a logger failure) stays inside.
 */
export async function switchToOpenGame(
  presets: PresetSelector,
  config: Config,
  log: PresetLog,
  detect: RunningDetector,
  created: CreatedAgent,
  previous?: Pick<PresetMount, "unmount">,
): Promise<void> {
  const { agent, source, signal } = created;
  try {
    if (config.role !== "player" || source !== "startup") return;
    // Subagents inherit the player preset; they are not the user's new conversation.
    if (agent.session.header.origin === "subagent") return;

    const detection = await detectWithin(detect, signal, config.autoPresetWaitMs);
    if (detection === undefined || !detection.ok || detection.running.length !== 1) return;
    const running = detection.running[0];
    if (running === undefined) return;

    const mine = byKey(config.game).key;
    if (running === mine) return;
    const target = playerPresetId(running);
    try {
      await presets.select(agent, target);
      // 11-02: mount the target inside this event dispatch. Mounting in pre-step is too late
      // for the first step's already-assembled prompt and tool list; this path runs before the
      // first turn is released. The old preset's set is ours; the new one's is global by game.
      try {
        previous?.unmount(agent.id);
      } catch (error) {
        log.warn(`新建会话自动换预设:撤掉会话 ${agent.id} 的旧预设失败:${describeError(error)}`);
      }
      const targetMount = presetMountFor(running);
      if (targetMount === undefined) {
        log.warn(
          `新建会话自动换预设:${target} 没有登记挂载,` +
            "第一轮可能缺工具和人设,留到 pre-step 兜底",
        );
      } else {
        try {
          targetMount.mount(agent);
        } catch (error) {
          log.warn(
            `新建会话自动换预设:给会话 ${agent.id} 挂 ${target} 失败:` + describeError(error),
          );
        }
      }
      log.info(
        `新建会话自动换预设:笔记本上开着 ${label(running)},` +
          `从 ${label(mine)}(${playerPresetId(mine)}) 换到 ${target}`,
      );
    } catch (error) {
      log.warn(
        `新建会话自动换预设失败:笔记本上开着 ${label(running)},` +
          `从 ${label(mine)}(${playerPresetId(mine)}) 换到 ${target}失败:${describeError(error)}`,
      );
    }
  } catch (error) {
    try {
      log.warn(`新建会话自动换预设出错:${describeError(error)}`);
    } catch {
      // The listener must not throw: a throw makes dsh roll back agent creation (dsh-agent).
    }
  }
}

/**
 * Register the switch on this plugin's context. A missing registry only disables the feature;
 * loading the plugin and playing the preset's own game still work.
 */
export function installPresetSwitch(
  ctx: Context,
  presets: PresetSelector | undefined,
  config: Config,
  log: PresetLog,
  detect: RunningDetector,
  previous?: Pick<PresetMount, "unmount">,
): void {
  if (presets === undefined) {
    log.warn("拿不到 agentPresets 服务,新建会话自动换预设不生效");
    return;
  }
  ctx.on("agent/created", async (payload) => {
    await switchToOpenGame(presets, config, log, detect, payload, previous);
    return undefined;
  });
}

/**
 * Wait at most `waitMs` for detection. The signal tells the real detector to stop waiting (its
 * shared SSH query keeps running for other callers, task 31); the raced timer also protects
 * against a detector that ignores cancellation. A timeout is "no answer", never an error.
 */
async function detectWithin(
  detect: RunningDetector,
  signal: AbortSignal | undefined,
  waitMs: number,
): Promise<DetectionResult | undefined> {
  const ms = Number.isFinite(waitMs) ? Math.max(1, Math.trunc(waitMs)) : 1;
  const deadline = AbortSignal.timeout(ms);
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    const pending = detect(combined).catch(() => undefined);
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function label(game: string): string {
  return byKey(game).label;
}

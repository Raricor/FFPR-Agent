/**
 * Waiting for the bridge before a model step (control plan §4/§10.3). The game being closed or the
 * laptop being asleep must not lose the user's message, so a step waits instead of being rejected:
 * a successful health result is reused for 5 seconds, otherwise it checks every `everyMs` until
 * the bridge answers or the turn is cancelled. Deliberately free of dsh imports.
 */

import { describeError } from "./errors.ts";

const HEALTH_CACHE_MS = 5000;

/** Clock and sleep used by the waiter; tests inject a fake, production uses Date and setTimeout. */
export interface HealthClock {
  now(): number;
  /** Resolve after `delayMs`; reject when `signal` aborts. */
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export const SYSTEM_HEALTH_CLOCK: HealthClock = {
  now: () => Date.now(),
  sleep: (delayMs, signal) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export interface HealthWaiterOptions {
  /** Resolve when the bridge answers; a throw means it is still down. */
  check(signal: AbortSignal): Promise<void>;
  /** How long to wait between checks while the bridge is down. */
  everyMs: number;
  clock?: HealthClock;
  /** First failure of a wait is a warning, later failures are informational. */
  log?(level: "warn" | "info", message: string): void;
}

interface CachedHealth {
  readonly at: number;
  readonly failure: string | undefined;
}

export class HealthWaiter {
  private readonly options: HealthWaiterOptions;
  private readonly clock: HealthClock;
  private last: CachedHealth | undefined;

  constructor(options: HealthWaiterOptions) {
    if (!Number.isFinite(options.everyMs) || options.everyMs <= 0) {
      throw new Error(`checkEveryMs 必须是正数:${options.everyMs}`);
    }
    this.options = options;
    this.clock = options.clock ?? SYSTEM_HEALTH_CLOCK;
  }

  /** Resolve once the bridge is healthy; only the turn's cancellation ends the wait early. */
  async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let cached = this.freshCache();
    let warned = false;
    for (;;) {
      let failure: string | undefined;
      if (cached) {
        failure = cached.failure;
        cached = undefined;
        if (failure === undefined) return;
      } else {
        failure = await this.check(signal);
        if (failure === undefined) return;
      }
      this.options.log?.(warned ? "info" : "warn", `桥插件连不上,等一会儿再试:${failure}`);
      warned = true;
      await this.clock.sleep(this.options.everyMs, signal);
      signal.throwIfAborted();
    }
  }

  private async check(signal: AbortSignal): Promise<string | undefined> {
    try {
      await this.options.check(signal);
    } catch (error) {
      signal.throwIfAborted();
      const failure = describeError(error);
      this.last = { at: this.clock.now(), failure };
      return failure;
    }
    this.last = { at: this.clock.now(), failure: undefined };
    return undefined;
  }

  private freshCache(): CachedHealth | undefined {
    const last = this.last;
    if (!last) return undefined;
    if (this.clock.now() - last.at >= HEALTH_CACHE_MS) return undefined;
    return last;
  }
}

/** An abort signal's reason is normally our DOMException, but callers may pass any value. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("操作已取消", "AbortError");
}

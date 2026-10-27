import assert from "node:assert/strict";
import test from "node:test";
import { HealthWaiter, type HealthClock } from "../src/engine/gate.ts";

type LogLevel = "warn" | "info";

interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
}

interface Sleeper {
  readonly due: number;
  resolve(): void;
}

class FakeClock implements HealthClock {
  private time = 0;
  private nextId = 1;
  private readonly sleepers = new Map<number, Sleeper>();

  now(): number {
    return this.time;
  }

  sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const onAbort = (): void => {
        this.sleepers.delete(id);
        signal.removeEventListener("abort", onAbort);
        reject(abortReason(signal));
      };
      const sleeper: Sleeper = {
        due: this.time + delayMs,
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      this.sleepers.set(id, sleeper);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  get pending(): number {
    return this.sleepers.size;
  }

  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (;;) {
      const due = [...this.sleepers.entries()]
        .filter(([, sleeper]) => sleeper.due <= this.time)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!due) return;
      this.sleepers.delete(due[0]);
      due[1].resolve();
      await flush();
    }
  }
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("操作已取消", "AbortError");
}

const SIGNAL = new AbortController().signal;

void test("a down bridge is checked every checkEveryMs until it answers", async () => {
  const clock = new FakeClock();
  const logs: LogEntry[] = [];
  let checks = 0;
  let healthy = false;
  const waiter = new HealthWaiter({
    check: () => {
      checks += 1;
      if (!healthy) return Promise.reject(new Error("连不上 http://127.0.0.1:47800/v1/health"));
      return Promise.resolve();
    },
    everyMs: 1000,
    clock,
    log: (level, message) => logs.push({ level, message }),
  });
  const waiting = waiter.wait(SIGNAL);
  await flush();
  assert.equal(checks, 1);
  const first = logs[0];
  assert.ok(first);
  assert.equal(first.level, "warn");
  assert.match(first.message, /连不上 http:\/\/127\.0\.0\.1:47800/);
  await clock.advance(1000);
  assert.equal(checks, 2);
  assert.equal(logs[1]?.level, "info");
  healthy = true;
  await clock.advance(1000);
  await waiting;
  assert.equal(checks, 3);
});

void test("a healthy result is reused for five seconds", async () => {
  const clock = new FakeClock();
  let checks = 0;
  const waiter = new HealthWaiter({
    check: () => {
      checks += 1;
      return Promise.resolve();
    },
    everyMs: 60000,
    clock,
  });
  await waiter.wait(SIGNAL);
  await waiter.wait(SIGNAL);
  await clock.advance(4999);
  await waiter.wait(SIGNAL);
  assert.equal(checks, 1);
  await clock.advance(1);
  await waiter.wait(SIGNAL);
  assert.equal(checks, 2);
});

void test("aborting while waiting ends at once and checks no more", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  let checks = 0;
  const waiter = new HealthWaiter({
    check: () => {
      checks += 1;
      return Promise.reject(new Error("连不上"));
    },
    everyMs: 1000,
    clock,
  });
  const waiting = waiter.wait(controller.signal);
  await flush();
  assert.equal(checks, 1);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(checks, 1);
  assert.equal(clock.pending, 0);
  await clock.advance(5000);
  assert.equal(checks, 1);
});

void test("an abort during the health check propagates instead of waiting", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  const waiter = new HealthWaiter({
    check: (signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("操作已取消", "AbortError"));
        });
      }),
    everyMs: 1000,
    clock,
  });
  const waiting = waiter.wait(controller.signal);
  await flush();
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(clock.pending, 0);
});

void test("checkEveryMs must be positive", () => {
  assert.throws(
    () =>
      new HealthWaiter({
        check: () => Promise.resolve(),
        everyMs: 0,
      }),
    /checkEveryMs/,
  );
});

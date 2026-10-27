import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLock } from "../src/engine/lock.ts";

void test("tasks wait in arrival order and run one at a time", async () => {
  const lock = new AsyncLock();
  const order: number[] = [];
  const first = lock.run(async () => {
    order.push(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(2);
    return "first";
  });
  const second = lock.run(() => {
    order.push(3);
    return Promise.resolve("second");
  });
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, [1, 2, 3]);
});

void test("a throwing task releases the lock for the next caller", async () => {
  const lock = new AsyncLock();
  await assert.rejects(
    lock.run(() => Promise.reject(new Error("boom"))),
    /boom/,
  );
  assert.equal(await lock.run(() => Promise.resolve("after")), "after");
});

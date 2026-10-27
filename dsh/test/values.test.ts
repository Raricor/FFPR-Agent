import assert from "node:assert/strict";
import { test } from "node:test";
import {
  floorDiv,
  floorMod,
  list,
  num,
  pyRound,
  record,
  records,
  text,
  truthy,
} from "../src/engine/values.ts";

void test("truthiness follows Python for empty lists and dicts", () => {
  for (const falsy of [null, undefined, false, 0, "", [], {}]) assert.equal(truthy(falsy), false);
  for (const value of [1, "a", [0], { a: 1 }, true]) assert.equal(truthy(value), true);
});

void test("record and list fall back the way `or {}` and `or []` do", () => {
  assert.deepEqual(record(null), {});
  assert.deepEqual(record([1]), {});
  assert.deepEqual(record({ a: 1 }), { a: 1 });
  assert.deepEqual(list(undefined), []);
  assert.deepEqual(list({}), []);
  assert.deepEqual(records([{ a: 1 }, 2, null, { b: 2 }]), [{ a: 1 }, { b: 2 }]);
});

void test("text and num only accept their own type", () => {
  assert.equal(text("x"), "x");
  assert.equal(text(1), undefined);
  assert.equal(num(3), 3);
  assert.equal(num(Number.NaN), undefined);
  assert.equal(num("3"), undefined);
});

void test("round sends halves to the even neighbour like Python", () => {
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(-2.5), -2);
  assert.equal(pyRound(2.6), 3);
  assert.equal(pyRound(4.0657, 1), 4.1);
  assert.equal(pyRound(0.125, 2), 0.12);
});

void test("floor division and modulo match Python for negatives", () => {
  assert.equal(floorDiv(7, 2), 3);
  assert.equal(floorDiv(-7, 2), -4);
  assert.equal(floorMod(-7, 2), 1);
  assert.equal(floorMod(7, -2), -1);
});

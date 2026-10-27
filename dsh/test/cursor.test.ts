import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pick, steer } from "../src/engine/skills/cursor.ts";

interface PickCase {
  readonly names: (string | null)[];
  readonly wanted: string;
  readonly out: number | null;
}

interface SteerCase {
  readonly name: string;
  readonly count: number;
  readonly columns: number;
  readonly keys: string[];
  readonly target: number;
  readonly out: boolean;
  readonly pressed: string[];
  readonly at: number;
}

interface Fixture {
  readonly pick: PickCase[];
  readonly steer: SteerCase[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "cursor", "cursor.json"), "utf8"),
) as Fixture;

/** A menu cursor over `count` entries laid out in rows of `columns`. */
class FakeMenu {
  at = 0;
  pressed: string[] = [];

  readonly count: number;
  readonly columns: number;
  readonly keys: readonly string[];

  constructor(count: number, columns: number, keys: readonly string[]) {
    this.count = count;
    this.columns = columns;
    this.keys = keys;
  }

  press(key: string): void {
    this.pressed.push(key);
    if (!this.keys.includes(key)) return;
    const step = { Down: this.columns, Up: -this.columns, Right: 1, Left: -1 }[key] ?? 0;
    this.at = (this.at + step) % this.count;
  }
}

void test("pick matches exactly then by containment", () => {
  for (const item of fixture.pick) {
    assert.equal(pick(item.names, item.wanted), item.out, item.wanted);
  }
});

void test("steer walks lists rows and grids", async () => {
  for (const item of fixture.steer) {
    const menu = new FakeMenu(item.count, item.columns, item.keys);
    const read = item.name === "unreadable" ? () => null : () => menu.at;
    assert.equal(
      await steer(
        read,
        (key) => {
          menu.press(key);
        },
        item.target,
      ),
      item.out,
      item.name,
    );
    assert.deepEqual(menu.pressed, item.pressed, item.name);
    assert.equal(menu.at, item.at, item.name);
  }
});

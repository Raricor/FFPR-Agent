import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Tactics } from "../src/engine/tactics.ts";
import type { Json } from "../src/engine/values.ts";

interface TacticsFixture {
  readonly initial: Json;
  readonly initialDescribes: readonly {
    readonly mapId: string;
    readonly text: string;
    readonly has: boolean;
  }[];
  readonly current: { readonly mapId: string; readonly table: Json | null };
  readonly steps: readonly {
    readonly op: "set" | "record";
    readonly args: Json;
    readonly message?: string;
    readonly describe: string;
    readonly current: Json | null;
    readonly has?: boolean;
  }[];
  readonly final: Json;
  readonly reloaded: { readonly current: Json | null; readonly describe: string };
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "tactics", "cases.json"), "utf8"),
) as TacticsFixture;

function asObject(maps: ReadonlyMap<string, unknown>): Json {
  return Object.fromEntries(maps);
}

void test("tactics matches the real record and its set/record sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-tactics-"));
  const path = join(directory, "tactics.json");
  try {
    await writeFile(path, JSON.stringify(fixture.initial), "utf8");
    const tactics = await Tactics.load(path);
    for (const expected of fixture.initialDescribes) {
      assert.equal(tactics.describe(expected.mapId), expected.text);
      assert.equal(tactics.has(expected.mapId), expected.has);
    }
    assert.deepEqual(tactics.current(fixture.current.mapId), fixture.current.table);
    for (const step of fixture.steps) {
      if (step.op === "set") {
        await tactics.set(step.args.mapId, step.args.tables as Json[]);
      } else {
        const message = await tactics.record(
          step.args.mapId,
          String(step.args.verdict),
          String(step.args.detail),
        );
        assert.equal(message, step.message);
      }
      assert.equal(tactics.describe(String(step.args.mapId)), step.describe);
      assert.deepEqual(tactics.current(String(step.args.mapId)), step.current);
      if (step.has !== undefined) assert.equal(tactics.has(String(step.args.mapId)), step.has);
    }
    assert.deepEqual(asObject(tactics.maps), fixture.final);
    const reloaded = await Tactics.load(path);
    assert.deepEqual(reloaded.current("777"), fixture.reloaded.current);
    assert.equal(reloaded.describe("777"), fixture.reloaded.describe);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("tactics rotate after a bad battle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-tactics-"));
  const path = join(directory, "t.json");
  try {
    const a = { 巴兹: [{ do: "攻击" }] };
    const b = { 巴兹: [{ do: "防御" }] };
    const tactics = await Tactics.load(path);
    assert.equal(tactics.current(64), null);
    assert.equal(await tactics.record(64, "lost", "全员倒下"), "");
    await tactics.set(64, [a, b]);
    assert.deepEqual(tactics.current(64), a);
    assert.equal(await tactics.record(64, "ok", "全队 HP 80%"), "");
    assert.deepEqual(tactics.current(64), a);
    assert.ok((await tactics.record(64, "hard", "巴兹倒下")).includes("换策略 2"));
    assert.deepEqual(tactics.current(64), b);
    const note = await tactics.record(64, "lost", "全员倒下");
    assert.ok(note.includes("每套策略都失败过"));
    assert.deepEqual(tactics.current(64), a); // back to the first
    assert.deepEqual((await Tactics.load(path)).current(64), a); // kept across runs
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

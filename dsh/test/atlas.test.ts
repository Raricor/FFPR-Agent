import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import type { Json } from "../src/engine/values.ts";

interface DescribeCase {
  readonly around: unknown;
  readonly limit: number;
  readonly text: string;
}

interface Step {
  readonly op: "visit" | "link";
  readonly args: Json;
  readonly describe: DescribeCase;
}

interface AtlasFixture {
  readonly initial: Json;
  readonly initialDescribes: readonly DescribeCase[];
  readonly steps: readonly Step[];
  readonly final: Json;
  readonly reloadedDescribes: readonly DescribeCase[];
  readonly saved: Json;
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "atlas", "cases.json"), "utf8"),
) as AtlasFixture;

function asObject(maps: ReadonlyMap<string, Json>): Json {
  return Object.fromEntries(maps);
}

void test("atlas matches the real map record and its visit/link sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-"));
  const path = join(directory, "atlas.json");
  try {
    await writeFile(path, JSON.stringify(fixture.initial), "utf8");
    const atlas = await Atlas.load(path);
    for (const expected of fixture.initialDescribes) {
      assert.equal(atlas.describe(expected.around, expected.limit), expected.text);
    }
    for (const step of fixture.steps) {
      if (step.op === "visit") {
        await atlas.visit(
          step.args.map_id,
          String(step.args.name),
          step.args.exits as Json[],
          step.args.chests as Json[],
        );
      } else {
        await atlas.link(
          step.args.map_id,
          step.args.start as number[],
          step.args.end as number[],
          String(step.args.how),
        );
      }
      assert.equal(atlas.describe(step.describe.around, step.describe.limit), step.describe.text);
    }
    assert.deepEqual(asObject(atlas.maps), fixture.final);
    const reloaded = await Atlas.load(path);
    for (const expected of fixture.reloadedDescribes) {
      assert.equal(reloaded.describe(expected.around, expected.limit), expected.text);
    }
    assert.deepEqual(asObject(reloaded.maps), fixture.final);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("atlas marks exits visited or not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-"));
  const path = join(directory, "atlas.json");
  try {
    const atlas = await Atlas.load(path);
    const exits = [
      { cell: [22, 15], to: 212, name: "沈没船1" },
      { cell: [47, 10], to: 1 },
    ];
    await atlas.visit(211, "船舶墓场", exits, [{ cell: [13, 54], name: "フレイル" }]);
    await atlas.visit(212, "沈没船1", [{ cell: [3, 3], to: 213, name: "沈没船2" }], []);
    const again = await Atlas.load(path); // kept across runs
    const text = again.describe(212);
    assert.ok(
      text
        .split("\n")[0]
        ?.startsWith("地图 212 沈没船1(你在这里):出口 (3, 3)→地图 213 沈没船2(没去过)"),
    );
    assert.ok(text.includes("→地图 212 沈没船1(去过)"));
    assert.ok(text.includes("(世界地图)") && text.includes("フレイル"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("atlas keeps jump links across visits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-"));
  const path = join(directory, "atlas.json");
  try {
    const atlas = await Atlas.load(path);
    await atlas.visit(211, "船舶墓场", [], []);
    await atlas.link(211, [17, 34], [13, 51], "调查后跳");
    await atlas.link(211, [17, 34], [13, 51], "调查后跳"); // once only
    await atlas.visit(211, "船舶墓场", [{ cell: [22, 15], to: 212 }], []); // a later look keeps it
    assert.deepEqual(atlas.maps.get("211")?.links, [
      { from: [17, 34], to: [13, 51], how: "调查后跳" },
    ]);
    assert.equal(atlas.links(211), "在 (17, 34) 调查后跳 到 (13, 51)");
    assert.ok(atlas.describe(211).includes("走法 在 (17, 34) 调查后跳 到 (13, 51)"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("atlas ignores a missing file and rejects a non-object one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-"));
  try {
    const atlas = await Atlas.load(join(directory, "absent.json"));
    assert.equal(atlas.describe(), "还没有记录任何地图");
    const path = join(directory, "bad.json");
    await writeFile(path, "[]", "utf8");
    await assert.rejects(Atlas.load(path), /不是 JSON 对象/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultProgressFiles,
  inScoutWindow,
  restoreSnapshot,
  ScoutWindows,
  scoutWindows,
  takeSnapshot,
} from "../src/engine/scout/snapshot.ts";
import { scoutSaveGuard } from "../src/engine/scout/save-guard.ts";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ffpr-scout-"));
}

async function body(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

void test("default progress files leave the map structure out", () => {
  const names = defaultProgressFiles("ff5", "/tmp/ds").map((path) => path.slice("/tmp/ds/".length));
  assert.deepEqual(names, [
    "atlas-save-ff5.json",
    "bestiary-save-ff5.json",
    "backlog-ff5.jsonl",
    "incidents-ff5.jsonl",
    "incidents-state-ff5.json",
    "notes-ff5.json",
    "stage-ff5.json",
    "route-ff5.json",
    "drake.json",
  ]);
  assert.ok(!names.includes("atlas-ff5.json"));
  assert.ok(!names.some((name) => name.startsWith("collision-")));
});

void test("restore puts every progress file back and removes those created by the scout", async () => {
  const ds = await tempDir();
  try {
    const atlasSave = join(ds, "atlas-save-ff5.json");
    const bestiary = join(ds, "bestiary-save-ff5.json");
    const notes = join(ds, "notes-ff5.json");
    const structure = join(ds, "atlas-ff5.json");
    const collision = join(ds, "collision-ff5", "10.json");
    await writeFile(atlasSave, '{"live":{"saves":4,"maps":[10]}}\n', "utf8");
    await writeFile(bestiary, '{"snapshots":{"4":{"numbers":[1,2]}}}\n', "utf8");
    await writeFile(structure, '{"10":{"name":"测试洞窟"}}\n', "utf8");
    await mkdir(join(ds, "collision-ff5"));
    await writeFile(collision, '{"layers":[]}\n', "utf8");
    const old = new Date("2026-11-10T01:02:03.000Z");
    await utimes(atlasSave, old, old);

    const snapshot = await takeSnapshot(
      ds,
      ["atlas-save-ff5.json", "bestiary-save-ff5.json", "notes-ff5.json"],
      new Date("2026-11-10T02:00:00.000Z"),
    );
    assert.equal(snapshot.dir, join(ds, "scout", "2026-11-10T02-00-00-000Z"));
    assert.equal(snapshot.files.length, 3);
    assert.equal(
      snapshot.files.find((file) => file.path.endsWith("notes-ff5.json"))?.exists,
      false,
    );
    const manifest = JSON.parse(await body(join(snapshot.dir, "manifest.json"))) as {
      files: { path: string; size: number | null; mtime: string | null }[];
    };
    assert.equal(manifest.files.length, 3);
    assert.equal(
      manifest.files.find((file) => file.path.endsWith("atlas-save-ff5.json"))?.size,
      33,
    );
    assert.equal(
      manifest.files.find((file) => file.path.endsWith("atlas-save-ff5.json"))?.mtime,
      old.toISOString(),
    );

    // A scout writes over one file, creates one that was absent, and learns map structure.
    await writeFile(atlasSave, '{"live":{"saves":9,"maps":[10,11]}}\n', "utf8");
    await writeFile(bestiary, '{"snapshots":{"9":{"numbers":[9]}}}\n', "utf8");
    await writeFile(notes, '{"scout":true}\n', "utf8");
    await writeFile(structure, '{"10":{"name":"测试洞窟"},"11":{"name":"宝箱房"}}\n', "utf8");
    await writeFile(collision, '{"layers":[{"name":"GroundCollision","rows":["000"]}]}\n', "utf8");

    const report = await restoreSnapshot(snapshot.dir);
    assert.deepEqual(report.restored, [atlasSave, bestiary]);
    assert.deepEqual(report.removed, [notes]);
    assert.equal(await body(atlasSave), '{"live":{"saves":4,"maps":[10]}}\n');
    assert.equal(await body(bestiary), '{"snapshots":{"4":{"numbers":[1,2]}}}\n');
    await assert.rejects(stat(notes), { code: "ENOENT" });
    // Map structure is not in the manifest and survives the restore.
    assert.equal(await body(structure), '{"10":{"name":"测试洞窟"},"11":{"name":"宝箱房"}}\n');
    assert.equal(await body(collision), '{"layers":[{"name":"GroundCollision","rows":["000"]}]}\n');
    assert.equal((await stat(atlasSave)).mtime.toISOString(), old.toISOString());
  } finally {
    await rm(ds, { recursive: true, force: true });
  }
});

void test("restore does not leave a tracked file that was absent before the scout", async () => {
  const ds = await tempDir();
  try {
    await writeFile(join(ds, "atlas-save-ff5.json"), "{}\n", "utf8");
    const snapshot = await takeSnapshot(ds, ["atlas-save-ff5.json", "stage-ff5.json"]);
    await writeFile(join(ds, "stage-ff5.json"), '{"plan":true}\n', "utf8");
    await restoreSnapshot(snapshot.dir);
    await assert.rejects(stat(join(ds, "stage-ff5.json")), { code: "ENOENT" });
    assert.equal(await body(join(ds, "atlas-save-ff5.json")), "{}\n");
  } finally {
    await rm(ds, { recursive: true, force: true });
  }
});

void test("scout windows include both boundaries and persist across reloads", async () => {
  const ds = await tempDir();
  try {
    const path = join(ds, "scout-windows-ff5.json");
    const windows = await ScoutWindows.load("ff5", path);
    await windows.begin("2026-11-10T10:00:00.000Z");
    await windows.end("2026-11-10T10:05:00.000Z");
    await windows.begin("2026-11-10T11:00:00.000Z");

    assert.equal(windows.inScoutWindow("2026-11-10T09:59:59.999Z"), false);
    assert.equal(windows.inScoutWindow("2026-11-10T10:00:00.000Z"), true);
    assert.equal(windows.inScoutWindow("2026-11-10T10:05:00.000Z"), true);
    assert.equal(windows.inScoutWindow("2026-11-10T10:05:00.001Z"), false);
    assert.equal(windows.inScoutWindow("2026-11-10T11:30:00.000Z"), true);
    assert.equal(windows.inScoutWindow("不是时间"), false);

    const reloaded = await scoutWindows("ff5", ds);
    assert.equal(reloaded.windows.length, 2);
    assert.equal(reloaded.inScoutWindow(new Date("2026-11-10T10:02:00.000Z")), true);
    // Plain interval lists work in either argument order.
    assert.equal(
      inScoutWindow(reloaded.windows, new Date("2026-11-10T10:02:00.000Z").valueOf()),
      true,
    );
    assert.equal(
      inScoutWindow(new Date("2026-11-10T10:02:00.000Z").valueOf(), reloaded.windows),
      true,
    );
  } finally {
    await rm(ds, { recursive: true, force: true });
  }
});

void test("the save guard refuses while the scout is active or inside its window", () => {
  assert.match(scoutSaveGuard({ active: true }) ?? "", /侦察/u);
  assert.match(scoutSaveGuard({ scouting: true }) ?? "", /侦察/u);
  assert.match(scoutSaveGuard({ scout: { active: true } }) ?? "", /侦察/u);
  assert.match(
    scoutSaveGuard({
      windows: [{ start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T10:05:00.000Z" }],
      at: "2026-11-10T10:02:00.000Z",
    }) ?? "",
    /侦察/u,
  );
  assert.equal(scoutSaveGuard({ active: false }, "2026-11-10T10:06:00.000Z"), null);
  assert.equal(scoutSaveGuard({ windows: [] }), null);
});

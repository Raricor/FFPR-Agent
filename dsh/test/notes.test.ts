import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadNotes, MAX_NOTES } from "../src/engine/notes.ts";

interface NotesFixture {
  readonly maxNotes: number;
  readonly cases: readonly {
    readonly name: string;
    readonly text: string;
    readonly expected: string[];
  }[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "notes.json"), "utf8"),
) as NotesFixture;

void test("MAX_NOTES matches the Python fixture", () => {
  assert.equal(MAX_NOTES, fixture.maxNotes);
});

for (const item of fixture.cases) {
  void test(`loadNotes matches Python: ${item.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ffpr-notes-"));
    try {
      const path = join(directory, "notes.json");
      await writeFile(path, item.text, "utf8");
      assert.deepEqual(await loadNotes(path), item.expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

void test("loadNotes returns an empty list when the file is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-notes-"));
  try {
    assert.deepEqual(await loadNotes(join(directory, "absent.json")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("loadNotes rejects a file that is not a JSON array of strings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-notes-"));
  try {
    const path = join(directory, "notes.json");
    await writeFile(path, '{"note":"not an array"}', "utf8");
    await assert.rejects(loadNotes(path), /不是 JSON 字符串数组/);
    await writeFile(path, '["ok", 3]', "utf8");
    await assert.rejects(loadNotes(path), /不是字符串/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

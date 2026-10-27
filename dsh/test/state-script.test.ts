import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Laptop } from "../src/engine/laptop.ts";
import { parseState, stateScript } from "../src/engine/state-script.ts";
import { parseTail, TAIL_BYTES } from "../src/engine/view.ts";

interface StateFixture {
  readonly state_script: string;
  readonly tail_bytes: number;
  readonly file: string;
  readonly cursor_seq: number;
  readonly input: string;
  readonly seeded: {
    readonly sample: Record<string, unknown> | null;
    readonly events: Record<string, unknown>[];
    readonly cursor: string;
  };
  readonly empty_cursor: {
    readonly input: string;
    readonly sample: Record<string, unknown> | null;
    readonly events: Record<string, unknown>[];
    readonly cursor: Record<string, unknown>;
  };
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "state-script.json"), "utf8"),
) as StateFixture;

const LAPTOP: Laptop = {
  host: "192.168.8.230",
  user: "ffpr",
  key: "/home/dev/.ssh/ffpr_laptop_ed25519",
  root: "C:/ffpr",
  desktopUser: "MIFEITECH\\yangwt",
};

void test("stateScript matches the Python script for FF5", () => {
  assert.equal(TAIL_BYTES, fixture.tail_bytes);
  assert.equal(stateScript(LAPTOP, "FF5"), fixture.state_script);
});

void test("parseState returns the newest sample and the events since a seeded cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-state-"));
  try {
    const cursor = join(directory, "state-cursor.json");
    await writeFile(cursor, JSON.stringify({ file: fixture.file, seq: fixture.cursor_seq }));
    const [sample, events] = await parseState(fixture.input, cursor);
    assert.deepEqual(sample, fixture.seeded.sample);
    assert.deepEqual(events, fixture.seeded.events);
    assert.deepEqual(JSON.parse(await readFile(cursor, "utf8")), JSON.parse(fixture.seeded.cursor));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a cursor from another probe file starts the events from zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-state-"));
  try {
    const cursor = join(directory, "state-cursor.json");
    const [sample, events] = await parseState(fixture.empty_cursor.input, cursor);
    assert.deepEqual(sample, fixture.empty_cursor.sample);
    assert.deepEqual(events, fixture.empty_cursor.events);
    assert.deepEqual(JSON.parse(await readFile(cursor, "utf8")), fixture.empty_cursor.cursor);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("parseTail skips a cut-off first line and damaged records", () => {
  const records = parseTail(
    'partial,{"seq":9}\n{"seq":1,"type":"hello"}\nnot json\n{"seq":2,"type":"sample"}\n',
  );
  assert.deepEqual(records, [
    { seq: 1, type: "hello" },
    { seq: 2, type: "sample" },
  ]);
});

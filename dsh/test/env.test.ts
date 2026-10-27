import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnvFile, readEnvFile } from "../src/engine/env.ts";

interface EnvFixture {
  readonly cases: readonly {
    readonly name: string;
    readonly text: string;
    readonly expected: Record<string, string>;
  }[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "env.json"), "utf8"),
) as EnvFixture;

for (const item of fixture.cases) {
  void test(`parseEnvFile matches Python: ${item.name}`, () => {
    assert.deepEqual(parseEnvFile(item.text), item.expected);
  });
}

void test("readEnvFile returns an empty map when the file is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-env-"));
  try {
    assert.deepEqual(await readEnvFile(join(directory, "absent.env")), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("readEnvFile strips a UTF-8 BOM like Python's utf-8-sig", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-env-"));
  try {
    const path = join(directory, "secrets.env");
    await writeFile(path, "\uFEFFBRIDGE_TOKEN=x\n", "utf8");
    assert.deepEqual(await readEnvFile(path), { BRIDGE_TOKEN: "x" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

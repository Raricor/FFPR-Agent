import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnvFile } from "../src/engine/env.ts";
import { MissingSecret, Secrets, store } from "../src/engine/secrets.ts";

interface SecretsFixture {
  readonly parse_env_file: readonly {
    readonly name: string;
    readonly text: string;
    readonly expected: Record<string, string>;
  }[];
  readonly env_wins: { readonly a: string; readonly b: string; readonly has_c: boolean };
  readonly missing: { readonly name: string; readonly path: string; readonly text: string };
  readonly warning: readonly {
    readonly mentions_file: boolean;
    readonly mentions_chmod: boolean;
  }[];
  readonly store: { readonly text: string; readonly mode: number };
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "secrets.json"), "utf8"),
) as SecretsFixture;

for (const item of fixture.parse_env_file) {
  void test(`parseEnvFile matches Python: ${item.name}`, () => {
    assert.deepEqual(parseEnvFile(item.text), item.expected);
  });
}

void test("the environment wins over the file, and a missing secret names the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-secrets-"));
  try {
    const path = join(directory, "secrets.env");
    await writeFile(path, "A=from_file\nB=only_file\n", "utf8");
    await chmod(path, 0o600);
    const secrets = await Secrets.load(path, { A: "from_env" });
    assert.equal(secrets.get("A"), fixture.env_wins.a);
    assert.equal(secrets.get("B"), fixture.env_wins.b);
    assert.equal(secrets.has("C"), fixture.env_wins.has_c);
    assert.throws(
      () => secrets.get("C"),
      (error: unknown) => {
        assert.ok(error instanceof MissingSecret);
        assert.equal(error.secretName, fixture.missing.name);
        assert.equal(error.path, path);
        assert.equal(error.path.replace(directory, "<tmp>"), fixture.missing.path);
        assert.equal(error.message, `缺少 C:请写进 ${path},或者设置同名环境变量`);
        assert.equal(error.message.replace(directory, "<tmp>"), fixture.missing.text);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a UTF-8 BOM does not become part of the first key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-secrets-"));
  try {
    const path = join(directory, "secrets.env");
    await writeFile(path, "\uFEFFBRIDGE_TOKEN=value\n", "utf8");
    await chmod(path, 0o600);
    assert.equal((await Secrets.load(path, {})).get("BRIDGE_TOKEN"), "value");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a world-readable secrets file warns with a chmod suggestion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-secrets-"));
  try {
    const path = join(directory, "secrets.env");
    await writeFile(path, "KEY=value\n", "utf8");
    await chmod(path, 0o644);
    const warnings: string[] = [];
    await Secrets.load(path, {}, { warn: (message) => warnings.push(message) });
    assert.equal(warnings.length, fixture.warning.length);
    assert.equal(warnings[0]?.includes(path), fixture.warning[0]?.mentions_file);
    assert.equal(warnings[0]?.includes("chmod 600"), fixture.warning[0]?.mentions_chmod);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("store replaces a value, keeps the comments, and makes the file private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-secrets-"));
  try {
    const path = join(directory, "secrets.env");
    await writeFile(path, "# 注释\nDEEPSEEK_API_KEY=sk-one\nBRIDGE_TOKEN=old\n", "utf8");
    await store(path, "BRIDGE_TOKEN", "new-token");
    await store(path, "STEAM_ID64", "7656");
    assert.equal(await readFile(path, "utf8"), fixture.store.text);
    assert.equal((await stat(path)).mode & 0o777, fixture.store.mode);
    const secrets = await Secrets.load(path, {});
    assert.equal(secrets.get("BRIDGE_TOKEN"), "new-token");
    assert.equal(secrets.get("DEEPSEEK_API_KEY"), "sk-one");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("store creates a missing file with the same private mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-secrets-"));
  try {
    const path = join(directory, "nested", "secrets.env");
    await store(path, "BRIDGE_TOKEN", "token");
    assert.equal(await readFile(path, "utf8"), "BRIDGE_TOKEN=token\n");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

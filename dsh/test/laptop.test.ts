import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CalledProcessError,
  ConfigError,
  PS_PRELUDE,
  decodeClixml,
  deployedScript,
  encodePs,
  load,
  psQuote,
  reasonOf,
  runInSession,
  runPs,
  scp,
  secureRootScript,
  sessionRequest,
  ssh,
  type Laptop,
} from "../src/engine/laptop.ts";

interface LaptopFixture {
  readonly ps_quote: readonly { readonly text: string; readonly expected: string }[];
  readonly encode_ps: readonly { readonly script: string; readonly expected: string }[];
  readonly prelude: string;
  readonly decode_clixml: readonly { readonly input: string; readonly expected: string }[];
  readonly session_request: readonly {
    readonly file: string;
    readonly args: readonly string[];
    readonly cwd: string | null;
    readonly wait: boolean;
    readonly keys: readonly string[];
    readonly id_length: number;
  }[];
  readonly secure_root_script: string;
  readonly deployed_script: string;
  readonly target: string;
  readonly ssh: readonly string[];
  readonly scp: readonly string[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "laptop.json"), "utf8"),
) as LaptopFixture;

const LAPTOP: Laptop = {
  host: "192.168.8.230",
  user: "ffpr",
  key: "/home/dev/.ssh/ffpr_laptop_ed25519",
  root: "C:/ffpr",
  desktopUser: "MIFEITECH\\yangwt",
  bridgeUrl: "http://192.168.8.230:47800",
  devboxAddress: "192.168.8.229",
};

const FAKE_SSH = join(import.meta.dirname, "fake-ssh.mjs");

void test("psQuote doubles single quotes and encodePs is UTF-16LE base64", () => {
  for (const item of fixture.ps_quote) assert.equal(psQuote(item.text), item.expected);
  for (const item of fixture.encode_ps) assert.equal(encodePs(item.script), item.expected);
  assert.equal(PS_PRELUDE, fixture.prelude);
});

void test("decodeClixml recovers errors and warnings", () => {
  for (const item of fixture.decode_clixml) {
    assert.equal(decodeClixml(item.input), item.expected);
  }
});

void test("sessionRequest has the Python shape and a 12-hex id", () => {
  for (const item of fixture.session_request) {
    const request = sessionRequest(item.file, item.args, item.cwd, item.wait);
    assert.deepEqual(Object.keys(request).sort(), item.keys);
    assert.equal(request.id.length, item.id_length);
    assert.match(request.id, /^[0-9a-f]{12}$/);
  }
});

void test("secure_root_script matches Python and needs the desktop user", () => {
  assert.equal(secureRootScript(LAPTOP), fixture.secure_root_script);
  assert.throws(
    () => secureRootScript({ ...LAPTOP, desktopUser: undefined }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /LAPTOP_DESKTOP_USER/);
      return true;
    },
  );
});

void test("deployedScript, ssh and scp use the dedicated key and reuse a connection", () => {
  assert.equal(deployedScript(LAPTOP, "FfprCommon.psm1"), fixture.deployed_script);
  assert.equal(`${LAPTOP.user}@${LAPTOP.host}`, fixture.target);
  assert.deepEqual(ssh(LAPTOP), fixture.ssh);
  assert.deepEqual(scp(LAPTOP), fixture.scp);
});

void test("Laptop.load reports a missing file and missing fields like Python", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-laptop-"));
  try {
    const path = join(directory, "laptop.env");
    await assert.rejects(load(path), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /laptop\.env\.example/);
      return true;
    });
    await writeFile(path, "LAPTOP_HOST=10.0.0.2\n", "utf8");
    await assert.rejects(load(path), /LAPTOP_USER/);
    await writeFile(path, "LAPTOP_HOST=10.0.0.2\nLAPTOP_USER=me\n", "utf8");
    const laptop = await load(path);
    assert.equal(`${laptop.user}@${laptop.host}`, "me@10.0.0.2");
    assert.equal(laptop.root, "C:/ffpr");
    assert.equal(laptop.sshCommand, "ssh");
    assert.equal(laptop.key, join(homedir(), ".ssh", "ffpr_laptop_ed25519"));
    assert.ok(ssh(laptop).includes("BatchMode=yes"));
    assert.ok(ssh(laptop).includes("IdentitiesOnly=yes"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("runPs sends an EncodedCommand over the configured ssh and returns stdout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-ssh-"));
  try {
    const log = await useFakeSsh(directory, [{ stdout: "你好\n" }]);
    const laptop = { ...LAPTOP, sshCommand: FAKE_SSH };
    const script = "Write-Host '你好'";
    const result = await runPs(laptop, script, { capture: true });
    assert.equal(result.stdout, "你好\n");
    const [call] = await readSshLog(log);
    assert.ok(call);
    assert.ok(call.args.includes("IdentitiesOnly=yes"));
    assert.ok(call.args.includes("BatchMode=yes"));
    const index = call.args.indexOf("-EncodedCommand");
    assert.ok(index >= 0);
    const encoded = call.args[index + 1];
    assert.ok(encoded);
    assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), PS_PRELUDE + script);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("runPs raises CalledProcessError by default and can skip the check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-ssh-"));
  try {
    await useFakeSsh(directory, [
      { stdout: "", stderr: "", code: 3 },
      { stdout: "", stderr: "", code: 3 },
    ]);
    const laptop = { ...LAPTOP, sshCommand: FAKE_SSH };
    await assert.rejects(runPs(laptop, "throw"), (error: unknown) => {
      assert.ok(error instanceof CalledProcessError);
      assert.equal(error.returnCode, 3);
      return true;
    });
    const result = await runPs(laptop, "throw", { check: false });
    assert.equal(result.returnCode, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("runInSession returns the status the scheduled task wrote", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-ssh-"));
  try {
    const log = await useFakeSsh(directory, [
      { stdout: "" },
      { stdout: '{"state":"done","ok":true}' },
    ]);
    const laptop = { ...LAPTOP, sshCommand: FAKE_SSH };
    const request = sessionRequest("powershell.exe", ["-NoProfile"], null, false);
    const status = await runInSession(laptop, request, 5);
    assert.equal(status.state, "done");
    assert.equal((await readSshLog(log)).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function useFakeSsh(
  directory: string,
  responses: readonly { stdout?: string; stderr?: string; code?: number }[],
): Promise<string> {
  const config = join(directory, "fake-ssh.json");
  const log = join(directory, "ssh.log");
  await writeFile(config, JSON.stringify({ responses }), "utf8");
  await writeFile(log, "", "utf8");
  await chmod(config, 0o600);
  process.env.FAKE_SSH_CONFIG = config;
  process.env.FAKE_SSH_LOG = log;
  return log;
}

async function readSshLog(path: string): Promise<{ args: string[]; stdin: string }[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; stdin: string });
}

void test("a failed command reports PowerShell's reason, not its encoded command line", () => {
  // Real stderr from wait-title.ps1 (10-27), after decodeClixml.
  const stderr = [
    "120 秒内没有看到桥插件 0.7.3 到达标题画面",
    "所在位置 C:\\ffpr\\deploy\\laptop\\wait-title.ps1:43 字符: 20",
    '+ ... f (-not $found) { throw "$TimeoutSeconds 秒内没有看到桥插件 $Version 到达标题画面" }',
    "+                       ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
    "    + CategoryInfo          : OperationStopped: (120 秒内…:String) [], RuntimeException",
    "    + FullyQualifiedErrorId : 120 秒内没有看到桥插件 0.7.3 到达标题画面",
    "",
  ].join("\r\n");
  assert.equal(reasonOf(stderr), "120 秒内没有看到桥插件 0.7.3 到达标题画面");
  const error = new CalledProcessError(1, ["ssh", "-EncodedCommand", "WwBD"], "", stderr);
  assert.equal(error.message, "命令退出码 1:120 秒内没有看到桥插件 0.7.3 到达标题画面");
  assert.ok(!error.message.includes("EncodedCommand"));
  assert.equal(new CalledProcessError(255, ["ssh", "x"], "", "").message, "命令退出码 255:ssh");
});

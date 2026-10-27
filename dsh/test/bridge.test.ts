import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeLink, LinkError } from "../src/engine/bridge.ts";
import { FakeBridge } from "./fake-bridge.ts";

const SIGNAL = AbortSignal.timeout(15000);

async function makeLink(server: FakeBridge, token = server.token): Promise<BridgeLink> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-bridge-"));
  const secretsFile = join(directory, "secrets.env");
  await writeFile(secretsFile, `BRIDGE_TOKEN=${token}\n`, "utf8");
  const link = await BridgeLink.load({
    secretsFile,
    laptopEnv: join(directory, "laptop.env"),
    url: server.url,
  });
  assert.ok(link);
  return link;
}

void test("health succeeds with the right Bearer token", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    assert.deepEqual(await link.health(SIGNAL), { ok: true });
    assert.equal(server.healthCalls, 1);
  } finally {
    link.close();
    await server.stop();
  }
});

void test("health reports a non-200 status and never leaks the token", async () => {
  const server = new FakeBridge("right-token");
  await server.start();
  const link = await makeLink(server, "wrong-token");
  try {
    await assert.rejects(link.health(SIGNAL), (error: unknown) => {
      assert.ok(error instanceof LinkError);
      assert.equal(error.message, "/v1/health 返回 401");
      assert.ok(!error.message.includes("wrong-token"));
      return true;
    });
  } finally {
    link.close();
    await server.stop();
  }
});

void test("health is not blocked behind a query that holds the lock", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    server.setReplyDelay(400);
    const query = link.query("pos", {}, SIGNAL);
    while (server.queries.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    assert.deepEqual(await link.health(SIGNAL), { ok: true });
    assert.ok(Date.now() - started < 200);
    await query;
  } finally {
    link.close();
    await server.stop();
  }
});

void test("health wraps a refused connection in a Chinese LinkError", async () => {
  const server = new FakeBridge();
  await server.start();
  const url = server.url;
  await server.stop();
  const directory = await mkdtemp(join(tmpdir(), "ffpr-bridge-"));
  try {
    const secretsFile = join(directory, "secrets.env");
    await writeFile(secretsFile, "BRIDGE_TOKEN=x\n", "utf8");
    const link = await BridgeLink.load({
      secretsFile,
      laptopEnv: join(directory, "laptop.env"),
      url,
    });
    assert.ok(link);
    await assert.rejects(link.health(SIGNAL), (error: unknown) => {
      assert.ok(error instanceof LinkError);
      assert.match(error.message, /^连不上 http:\/\/127\.0\.0\.1:/);
      return true;
    });
    link.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("query returns the reply for its id and skips a reply to another request", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    const pos = { map: 238, state: "Field", cell: [12, 7], dir: "Down" };
    server.setReplyFactory((request) => ({
      type: "reply",
      re: request.id,
      op: request.op,
      ok: true,
      pos,
    }));
    server.setExtraWrongReply(true);
    assert.deepEqual(await link.query("pos", {}, SIGNAL), {
      type: "reply",
      re: 1,
      op: "pos",
      ok: true,
      pos,
    });
  } finally {
    link.close();
    await server.stop();
  }
});

void test("query reconnects once after the socket drops", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    server.setReplyFactory((request) => ({ type: "reply", re: request.id, ok: true }));
    server.dropNextQueries(1);
    assert.deepEqual(await link.query("pos", {}, SIGNAL), { type: "reply", re: 2, ok: true });
    assert.equal(server.queries.length, 2);
  } finally {
    link.close();
    await server.stop();
  }
});

void test("two concurrent queries are serialized by the bridge lock", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    server.setReplyDelay(40);
    await Promise.all([link.query("first", {}, SIGNAL), link.query("second", {}, SIGNAL)]);
    assert.equal(server.queries.length, 2);
    const first = server.queries[0];
    const second = server.queries[1];
    assert.ok(first && second);
    assert.ok(first.repliedAt !== undefined);
    assert.ok(second.receivedAt >= first.repliedAt);
  } finally {
    link.close();
    await server.stop();
  }
});

void test("query fails with a Chinese LinkError after the one reconnect", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    server.dropNextQueries(2);
    await assert.rejects(link.query("pos", {}, SIGNAL), (error: unknown) => {
      assert.ok(error instanceof LinkError);
      assert.match(error.message, /^\/v1\/query pos 失败:/);
      assert.ok(!error.message.includes(server.token));
      return true;
    });
    assert.equal(server.queries.length, 2);
  } finally {
    link.close();
    await server.stop();
  }
});

void test("the fake bridge can stop and restart on the same address", async () => {
  const server = new FakeBridge();
  await server.start();
  const url = server.url;
  await server.stop();
  await server.start();
  try {
    assert.equal(server.url, url);
    const link = await makeLink(server);
    try {
      assert.deepEqual(await link.health(SIGNAL), { ok: true });
    } finally {
      link.close();
    }
  } finally {
    await server.stop();
  }
});

void test("load returns undefined without BRIDGE_TOKEN", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-bridge-"));
  try {
    const secretsFile = join(directory, "secrets.env");
    const laptopEnv = join(directory, "laptop.env");
    await writeFile(secretsFile, "# no token\n", "utf8");
    await writeFile(laptopEnv, "LAPTOP_HOST=192.0.2.10\n", "utf8");
    assert.equal(await BridgeLink.load({ secretsFile, laptopEnv }), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("load prefers the explicit URL, then BRIDGE_URL, then LAPTOP_HOST", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-bridge-"));
  try {
    const secretsFile = join(directory, "secrets.env");
    const laptopEnv = join(directory, "laptop.env");
    await writeFile(secretsFile, "BRIDGE_TOKEN=x\n", "utf8");
    await writeFile(
      laptopEnv,
      "LAPTOP_HOST=192.0.2.10\nBRIDGE_URL=http://192.0.2.11:47800\n",
      "utf8",
    );
    const explicit = await BridgeLink.load({
      secretsFile,
      laptopEnv,
      url: "http://127.0.0.1:9999/",
    });
    assert.ok(explicit);
    assert.equal(explicit.url, "http://127.0.0.1:9999");
    const configured = await BridgeLink.load({ secretsFile, laptopEnv });
    assert.ok(configured);
    assert.equal(configured.url, "http://192.0.2.11:47800");
    await writeFile(laptopEnv, "LAPTOP_HOST=192.0.2.10\n", "utf8");
    const fallback = await BridgeLink.load({ secretsFile, laptopEnv });
    assert.ok(fallback);
    assert.equal(fallback.url, "http://192.0.2.10:47800");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("load refuses to guess an address when laptop.env has no host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-bridge-"));
  try {
    const secretsFile = join(directory, "secrets.env");
    const laptopEnv = join(directory, "laptop.env");
    await writeFile(secretsFile, "BRIDGE_TOKEN=x\n", "utf8");
    await writeFile(laptopEnv, "# empty\n", "utf8");
    await assert.rejects(BridgeLink.load({ secretsFile, laptopEnv }), /LAPTOP_HOST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("command sends its fields on /v1/command and returns the bridge's reply", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    server.setCommandReplyFactory((request) => ({
      type: "reply",
      re: request.id,
      op: request.op,
      ok: true,
      sent: 2,
    }));
    assert.deepEqual(await link.command("keys", { keys: ["Enter"], gap: 80 }, SIGNAL), {
      type: "reply",
      re: 1,
      op: "keys",
      ok: true,
      sent: 2,
    });
    assert.equal(server.commands.length, 1);
    assert.equal(server.queries.length, 0);
    assert.deepEqual(server.commands[0]?.request, {
      id: 1,
      op: "keys",
      keys: ["Enter"],
      gap: 80,
    });
  } finally {
    link.close();
    await server.stop();
  }
});

void test("command shares the query lock and keeps its own socket", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    server.setReplyDelay(40);
    server.setCommandReplyFactory((request) => ({ type: "reply", re: request.id, ok: true }));
    await Promise.all([
      link.command("keys", { keys: ["Enter"] }, SIGNAL),
      link.query("pos", {}, SIGNAL),
    ]);
    const command = server.commands[0];
    const query = server.queries[0];
    assert.ok(command && query);
    assert.ok(command.repliedAt !== undefined);
    assert.ok(query.receivedAt >= command.repliedAt);
  } finally {
    link.close();
    await server.stop();
  }
});

void test("command fails with a Chinese LinkError after the one reconnect", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    server.dropNextCommands(2);
    await assert.rejects(link.command("keys", { keys: ["Enter"] }, SIGNAL), (error: unknown) => {
      assert.ok(error instanceof LinkError);
      assert.match(error.message, /^\/v1\/command keys 失败:/);
      return true;
    });
    assert.equal(server.commands.length, 2);
  } finally {
    link.close();
    await server.stop();
  }
});

void test("stream yields the hello record and every later record", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    server.setStreamRecords([
      { seq: 1, type: "sample", scene: { name: "Field" } },
      { seq: 2, type: "sysmsg", text: "消息" },
    ]);
    const stream = link.stream(SIGNAL);
    const first = await stream.next();
    assert.equal(first.done, false);
    assert.deepEqual(first.value, { type: "hello" });
    const second = await stream.next();
    assert.deepEqual(second.value, { seq: 1, type: "sample", scene: { name: "Field" } });
    const third = await stream.next();
    assert.deepEqual(third.value, { seq: 2, type: "sysmsg", text: "消息" });
    await stream.return(undefined);
    await waitFor(() => server.activeStreams === 0);
  } finally {
    link.close();
    await server.stop();
  }
});

void test("stream closes its socket when the signal aborts", async () => {
  const server = new FakeBridge();
  await server.start();
  const link = await makeLink(server);
  try {
    const controller = new AbortController();
    const stream = link.stream(controller.signal);
    assert.deepEqual((await stream.next()).value, { type: "hello" });
    const pending = stream.next();
    setTimeout(() => {
      controller.abort();
    }, 20);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    });
    await waitFor(() => server.activeStreams === 0);
  } finally {
    link.close();
    await server.stop();
  }
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

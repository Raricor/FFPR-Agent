// Live check through the ffpr profile's web app: create a session with the FF5 player preset,
// send one prompt, wait for the turn to end, and print the session's events.
//
//   node scripts/ask.mjs "我在哪？"                 new session, one prompt
//   node scripts/ask.mjs --session <id> "继续"      another prompt in that session
//   node scripts/ask.mjs --show <id>                print a session's events only
//   node scripts/ask.mjs --brief <id>               tool calls, results and replies, one line each
//   node scripts/ask.mjs --command "/ach"           new session, run one slash command, print it
//
// It talks to the web API the way a browser does (dsh-client-connection): GET /connect with the
// startup token from ~/.dsh/logs/web-ffpr.log for an API cookie, then unary POST /api/<endpoint>
// with {type: "client-request", rpcId, method, payload: {args}}. Session logs are append-only
// JSONL in one zstd frame per append (dsh-session-persistence-jsonl), read straight from disk.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const PORT = Number(process.env.FFPR_DSH_PORT || 3081);
const WEB_LOG = join(homedir(), ".dsh", "logs", "web-ffpr.log");
const SESSIONS = join(homedir(), ".dsh", "sessions");
const CWD = "/root/data/mediaflow/FFPR-Agent";
const CLIP = 600; // characters of each event shown
// Play runs take hours; quick checks a few minutes. FFPR_ASK_MINUTES sets how long to wait.
const TURN_TIMEOUT_MS = Number(process.env.FFPR_ASK_MINUTES || 15) * 60 * 1000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const base = `http://127.0.0.1:${PORT}`;

async function connect() {
  const token = /token=([^\s&]+)/.exec(readFileSync(WEB_LOG, "utf8"))?.[1];
  if (!token) throw new Error(`no startup token in ${WEB_LOG}: is the ffpr web app running?`);
  const response = await fetch(`${base}/connect?token=${token}&interactions=none`, {
    redirect: "manual",
  });
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0])
    .join("; ");
  if (!cookie) throw new Error(`/connect failed: HTTP ${response.status}`);
  return cookie;
}

async function call(cookie, endpoint, args) {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: base },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method: endpoint,
      payload: { args },
    }),
  });
  const body = await response.json();
  if (!body.result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(body.result?.error)}`);
  return body.result.value;
}

/**
 * Every event of a session, decoding each zstd frame (a magic number inside a frame fails). A
 * new session has no log until its first event, so a missing one reads as no events yet.
 */
function events(sessionId) {
  const log = readdirSync(SESSIONS)
    .map((group) => join(SESSIONS, group, sessionId, "session.v4.jsonl.zstd"))
    .find((path) => existsSync(path));
  if (!log) return [];
  const bytes = readFileSync(log);
  const starts = [];
  for (let i = bytes.indexOf(ZSTD_MAGIC); i >= 0; i = bytes.indexOf(ZSTD_MAGIC, i + 1)) {
    starts.push(i);
  }
  let text = "";
  for (let k = 0; k < starts.length; k += 1) {
    try {
      text += zstdDecompressSync(bytes.subarray(starts[k], starts[k + 1] ?? bytes.length));
    } catch {
      // Not a frame start: the magic bytes occurred inside compressed data.
    }
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function show(sessionId, fromSeq = 0) {
  for (const event of events(sessionId)) {
    if ((event.seq ?? -1) < fromSeq) continue;
    const body = JSON.stringify(event.data ?? event).replace(/\\n/g, " ⏎ ");
    console.log(`${event.seq ?? "-"} ${event.type}: ${body.slice(0, CLIP)}`);
  }
}

/** One line per tool call (with the start of its result) and per thing the model said. */
function brief(sessionId, fromSeq = 0) {
  const clip = (text, n) => text.replace(/\n/g, " ⏎ ").slice(0, n);
  for (const event of events(sessionId)) {
    if ((event.seq ?? -1) < fromSeq) continue;
    const data = event.data ?? {};
    if (event.type === "tool/call") {
      console.log(`[${data.turn}.${data.step}] → ${data.name} ${data.arguments}`);
    } else if (event.type === "tool/result") {
      const text = (data.message?.content ?? []).map((part) => part.text ?? "").join("");
      console.log(`      ${clip(text, 240)}`);
    } else if (event.type === "assistant/message") {
      for (const part of data.message?.content ?? []) {
        if (part.type === "text" && part.text)
          console.log(`[${data.turn}.${data.step}] 说:${clip(part.text, 300)}`);
      }
    } else if (event.type === "turn/end") {
      console.log(`== 第 ${data.turn} 轮结束:${JSON.stringify(data.reason)}`);
    }
  }
}

async function waitForTurnEnd(sessionId, afterSeq) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ended = events(sessionId).some((e) => e.type === "turn/end" && e.seq > afterSeq);
    if (ended) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`no turn/end within ${TURN_TIMEOUT_MS / 60000} minutes`);
}

const argv = process.argv.slice(2);
if (argv[0] === "--show") {
  show(argv[1]);
} else if (argv[0] === "--brief") {
  brief(argv[1]);
} else if (argv[0] === "--command") {
  // Slash commands answer in the call itself (dsh-commands' `commands/execute` remote).
  const cookie = await connect();
  const { sessionId } = await call(cookie, "session/create", {
    request: { cwd: CWD, agentPreset: "ffpr" },
  });
  const execution = await call(cookie, "commands/execute", {
    agentId: sessionId,
    line: argv[1],
    submittedAttachments: [],
  });
  console.log(`session ${sessionId}`);
  console.log(
    execution ? `[${execution.result.kind}]\n${execution.result.text ?? ""}` : "没有这个命令",
  );
} else {
  let sessionId = argv[0] === "--session" ? argv[1] : undefined;
  const prompt = argv.at(-1);
  if (!prompt || prompt.startsWith("--"))
    throw new Error("usage: ask.mjs [--session <id>] <prompt>");
  const cookie = await connect();
  sessionId ??= (
    await call(cookie, "session/create", { request: { cwd: CWD, agentPreset: "ffpr" } })
  ).sessionId;
  const before = Math.max(-1, ...events(sessionId).map((e) => e.seq ?? -1));
  await call(cookie, "session/prompt", {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }],
    },
  });
  console.log(`session ${sessionId}`);
  await waitForTurnEnd(sessionId, before);
  show(sessionId, before + 1);
}

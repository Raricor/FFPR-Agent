// Task 155: operator control of the chapter executor after the model's handoff.
//
//   node scripts/chapter-resume.mjs                 continue the chapter from its progress file
//   node scripts/chapter-resume.mjs --abandon       stop this chapter and give planning back to AI
//   node scripts/chapter-resume.mjs --game ff6      another game (default ff5)
//
// It talks to the web app the same way ask.mjs does: GET /connect with the startup token from
// ~/.dsh/logs/web-ffpr.log for the API cookie, then POST the exact route. The connection service
// checks the cookie; there is no second token in this script.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.FFPR_DSH_PORT || 3081);
const WEB_LOG = join(homedir(), ".dsh", "logs", "web-ffpr.log");
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

function usage() {
  console.log("usage: chapter-resume.mjs [--game ff5] [--abandon]");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }
  let game = "ff5";
  let abandon = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--abandon") abandon = true;
    else if (arg === "--game") {
      game = argv[index + 1] ?? "";
      index += 1;
      if (!/^ff[1-6]$/iu.test(game)) throw new Error(`--game 要写 ff1–ff6，收到 ${game}`);
    } else {
      usage();
      throw new Error(`不认识的参数:${arg}`);
    }
  }
  const action = abandon ? "abandon" : "resume";
  const cookie = await connect();
  const response = await fetch(
    `${base}/api/ffpr/chapter/resume?game=${encodeURIComponent(game.toLowerCase())}&action=${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ action }),
    },
  );
  const body = await response.json();
  if (body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
  console.log(body.text ?? `已${abandon ? "放弃" : "续跑"}第 ${body.chapter ?? "?"} 章`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) await main();

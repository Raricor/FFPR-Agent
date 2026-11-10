#!/usr/bin/env node
// Stand-in for ssh in tests: records argv and stdin, then replays scripted stdout/stderr/exit
// code from FAKE_SSH_CONFIG. The script never runs on a real laptop.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// Optional start/done markers let a test wait for every child it launched, including one killed
// by an aborted call, before deleting the directory the wrapper lives in.
const trackPath = process.env.FAKE_SSH_TRACK;
const track = (marker) => {
  if (!trackPath) return;
  try {
    appendFileSync(trackPath, `${marker}\n`, "utf8");
  } catch {
    // The test may already be gone; a missing marker only makes its wait time out.
  }
};
if (trackPath) {
  track("start");
  process.on("exit", () => track("done"));
  // The pilot kills the ssh child when a call is cancelled; exit normally so 'exit' runs.
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
}

const configPath = process.env.FAKE_SSH_CONFIG;
if (!configPath) {
  process.stderr.write("FAKE_SSH_CONFIG is not set\n");
  process.exit(90);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
const counterPath = `${configPath}.count`;
const count = readCount();
writeFileSync(counterPath, String(count + 1));

const logPath = process.env.FAKE_SSH_LOG;
if (logPath) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ args: process.argv.slice(2), stdin: readStdin() })}\n`,
    "utf8",
  );
}

const responses = Array.isArray(config.responses) ? config.responses : [];
const response = responses[count] ?? config.default ?? {};
// A delayed answer lets a test keep one command in flight while another runs (concurrency).
if (typeof response.delayMs === "number" && response.delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, response.delayMs));
}
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(typeof response.code === "number" ? response.code : 0);

function readCount() {
  try {
    return Number(readFileSync(counterPath, "utf8"));
  } catch {
    return 0;
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

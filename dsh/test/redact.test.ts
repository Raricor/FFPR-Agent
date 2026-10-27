import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MASK, Redactor, redactingLogger, type LogSink } from "../src/engine/redact.ts";

interface RedactFixture {
  readonly mask: string;
  readonly redact: readonly { readonly text: string; readonly expected: string }[];
  readonly filter: {
    readonly format: string;
    readonly args: readonly string[];
    readonly expected: string;
  };
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "redact.json"), "utf8"),
) as RedactFixture;

function makeRedactor(): Redactor {
  const redactor = new Redactor();
  redactor.add("SECRETKEY123456");
  redactor.add("abc");
  return redactor;
}

void test("the redactor masks long values only", () => {
  assert.equal(MASK, fixture.mask);
  const redactor = makeRedactor();
  for (const item of fixture.redact) assert.equal(redactor.redact(item.text), item.expected);
});

void test("a redacting logger rewrites a formatted message like the Python filter", () => {
  const lines: string[] = [];
  const logger: LogSink = {
    error: (format) => lines.push(String(format)),
    info: (format) => lines.push(String(format)),
    warn: (format) => lines.push(String(format)),
    debug: (format) => lines.push(String(format)),
  };
  redactingLogger(logger, makeRedactor()).info(fixture.filter.format, ...fixture.filter.args);
  assert.deepEqual(lines, [fixture.filter.expected]);
});

void test("a redacting logger masks a key that appears in an extra argument", () => {
  const lines: string[] = [];
  const logger: LogSink = {
    error: (format) => lines.push(String(format)),
    info: (format) => lines.push(String(format)),
    warn: (format) => lines.push(String(format)),
    debug: (format) => lines.push(String(format)),
  };
  redactingLogger(logger, makeRedactor()).warn("GET %s", "k=SECRETKEY123456");
  assert.deepEqual(lines, ["GET k=***"]);
});

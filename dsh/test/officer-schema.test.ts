import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import test from "node:test";
import { STAGE_OFFICER_OUTPUT_SCHEMA } from "../src/plugin/stage-officer.ts";
import { TACTICIAN_OUTPUT_SCHEMA } from "../src/plugin/tactician.ts";

// 11-10: dsh rejected the stage officer's output schema at call time ("kind.const requires type
// or oneOf"), so plan_stage never produced a plan on the real device; check both with dsh's own
// validator so a schema the runtime refuses fails here first.
void test("the stage officer's output schema is one dsh's structured output accepts", () => {
  assertSupportedJsonSchema(STAGE_OFFICER_OUTPUT_SCHEMA);
});

void test("the tactician's output schema is one dsh's structured output accepts", () => {
  assertSupportedJsonSchema(TACTICIAN_OUTPUT_SCHEMA);
});

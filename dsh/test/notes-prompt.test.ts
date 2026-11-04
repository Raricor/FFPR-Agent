import assert from "node:assert/strict";
import test from "node:test";
import {
  formatNotes,
  formatTactician,
  NOTES_CONTEXT_NAME,
  NOTES_CONTEXT_ORDER,
  notesContext,
  TACTICIAN_CONTEXT_NAME,
  TACTICIAN_CONTEXT_ORDER,
  tacticianContext,
} from "../src/plugin/notes-prompt.ts";

void test("no notes contribute no prompt text", () => {
  assert.equal(formatNotes([]), "");
});

void test("notes are numbered exactly as the Python loop prints them", () => {
  assert.equal(
    formatNotes(["旅店在镇子北边", "北山有宝箱"]),
    "你记下的:\n1. 旅店在镇子北边\n2. 北山有宝箱",
  );
});

void test("the notes context is required and keeps text literal", () => {
  const context = notesContext(() => "你记下的:\n1. 用 {{小心}}");
  assert.equal(context.name, NOTES_CONTEXT_NAME);
  assert.equal(context.order, NOTES_CONTEXT_ORDER);
  assert.equal(context.required, true);
  assert.equal(context.interpolate, false);
  assert.equal(typeof context.text, "function");
  if (typeof context.text !== "function") return;
  assert.equal(context.text({}), "你记下的:\n1. 用 {{小心}}");
});

void test("the tactician's notes and advice read like the notes block", () => {
  assert.equal(formatTactician(null), "");
  assert.equal(
    formatTactician({ mapId: 260, walkerNotes: "先开左边的开关", askUp: "缺眼药" }),
    "战术官(地图 260):先开左边的开关\n战术官建议:缺眼药",
  );
  assert.equal(
    formatTactician({ mapId: 260, walkerNotes: "直接走", askUp: "" }),
    "战术官(地图 260):直接走",
  );
  const context = tacticianContext(() => "战术官(地图 1):走");
  assert.equal(context.name, TACTICIAN_CONTEXT_NAME);
  assert.equal(context.order, TACTICIAN_CONTEXT_ORDER);
  assert.equal(context.required, true);
  assert.equal(context.interpolate, false);
});

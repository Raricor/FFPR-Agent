import assert from "node:assert/strict";
import test from "node:test";
import { cleanIconTags, cleanName } from "../src/engine/icons.ts";

void test("icon tags are removed from names and sentences, everywhere they appear", () => {
  assert.equal(
    cleanIconTags("蕾娜 用了「<IC_WMGC>治疗」,又买了「<IC_BMGC>冰冻」×1 和「<IC_BAG>眼药」×4"),
    "蕾娜 用了「治疗」,又买了「冰冻」×1 和「眼药」×4",
  );
  assert.equal(cleanName("  <IC_ITEM>眼药 "), "眼药");
  assert.equal(cleanName(undefined), "");
});

void test("cleaning icon tags does not eat an ordinary < comparison", () => {
  const rule = "self.hp < 50 and self.mp > 3";
  assert.equal(cleanIconTags(rule), rule);
});

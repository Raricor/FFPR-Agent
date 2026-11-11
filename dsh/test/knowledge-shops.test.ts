import assert from "node:assert/strict";
import test from "node:test";
import { shopsOnMap } from "../src/engine/knowledge/shops.ts";
import type { Knowledge } from "../src/engine/knowledge/types.ts";

function knowledge(overrides: Record<string, unknown> = {}): Knowledge {
  return {
    game: "ff5",
    maps: [{ id: 30, name: "图尔村", areaName: "图尔村" }],
    mapFiles: [
      {
        id: 30,
        name: "图尔村",
        title: { ja: "魔法店", en: "Magic Shop", zhc: "魔法店" },
        npcs: [{ cell: [2, 3], name: "店员", shopId: 38 }],
      },
    ],
    shops: [
      {
        id: 38,
        mapId: 11,
        areaName: "图尔村",
        kind: "武器",
        products: [
          { itemId: 392, name: "火炎", price: 150, aliases: ["Fire"] },
          { itemId: 393, name: "治疗", price: 180, aliases: ["Cure"] },
        ],
      },
      {
        id: 99,
        mapId: 30,
        areaName: "图尔村",
        kind: "武器",
        products: [{ itemId: 1, name: "秘银剑", price: 3000 }],
      },
    ],
    contentItems: [],
    items: [],
    magic: [],
    ...overrides,
  } as unknown as Knowledge;
}

void test("shopsOnMap follows the clerk's shop id, not the export's wrong map", () => {
  const shops = shopsOnMap(knowledge(), 30);
  assert.equal(shops.length, 1);
  const shop = shops[0];
  assert.ok(shop !== undefined);
  assert.equal(shop.kind, "魔法");
  assert.deepEqual(
    shop.products.map((product) => product.name),
    ["火炎", "治疗"],
  );
  assert.deepEqual(shop.products[0]?.aliases, ["Fire"]);
  assert.equal(
    shops.some((shop) => shop.products.some((product) => product.name === "秘银剑")),
    false,
  );
});

void test("without map files the export's map id is the only fallback", () => {
  const shops = shopsOnMap(knowledge({ mapFiles: [] }), 30);
  assert.deepEqual(
    shops.flatMap((shop) => shop.products.map((product) => product.name)),
    ["秘银剑"],
  );
});

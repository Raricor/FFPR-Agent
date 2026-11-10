import assert from "node:assert/strict";
import test from "node:test";
import { purchaseList, type ShopHere } from "../src/engine/stage/purchase.ts";
import type { StageFacts, StagePlan } from "../src/engine/stage/types.ts";

function plan(supplies: StagePlan["supplies"], threats: readonly string[] = []): StagePlan {
  return {
    threats,
    supplies,
    spells: [],
    gear: [],
    jobs: [],
    minLevel: null,
    route: [],
    turnBack: [],
    notes: "",
  };
}

function bag(...items: readonly (readonly [string, number])[]): StageFacts["bag"] {
  return items.map(([name, count]) => ({ name, count }));
}

function shop(...products: readonly (readonly [string, number])[]): ShopHere {
  return {
    area: "卡纳克",
    kind: "道具店",
    products: products.map(([name, price]) => ({ name, price })),
  };
}

void test("buys the missing amount up to buyTo", () => {
  const result = purchaseList(
    plan([{ item: "恢复药", min: 2, buyTo: 5 }]),
    bag(["恢复药", 2]),
    1000,
    [shop(["恢复药", 100])],
  );
  assert.deepEqual(result, {
    buy: [{ item: "恢复药", count: 3, price: 100 }],
    skipped: [],
  });
});

void test("money runs out in priority order: revive, dangerous-status cure, then the rest", () => {
  const result = purchaseList(
    plan(
      [
        { item: "恢复药", min: 2, buyTo: 2 },
        { item: "解毒药", min: 2, buyTo: 2 },
        { item: "不死鸟之尾", min: 1, buyTo: 1 },
      ],
      ["毒"],
    ),
    bag(),
    400,
    [shop(["恢复药", 100], ["解毒药", 50], ["不死鸟之尾", 300])],
  );
  assert.deepEqual(
    result.buy.map((purchase) => purchase.item),
    ["不死鸟之尾", "解毒药"],
  );
  assert.deepEqual(
    result.buy.map((purchase) => purchase.count),
    [1, 2],
  );
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0] ?? "", /恢复药/u);
  assert.match(result.skipped[0] ?? "", /钱不够/u);
});

void test("a partial purchase buys what the purse covers and says what is missing", () => {
  const result = purchaseList(plan([{ item: "解毒药", min: 1, buyTo: 3 }]), bag(), 120, [
    shop(["解毒药", 50]),
  ]);
  assert.deepEqual(result.buy, [{ item: "解毒药", count: 2, price: 50 }]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0] ?? "", /只买到 2 个/u);
  assert.match(result.skipped[0] ?? "", /还差 1 个/u);
});

void test("an item the shop does not sell is skipped", () => {
  const result = purchaseList(plan([{ item: "眼药", min: 1, buyTo: 2 }]), bag(), 1000, [
    shop(["恢复药", 100]),
  ]);
  assert.deepEqual(result.buy, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0] ?? "", /眼药/u);
  assert.match(result.skipped[0] ?? "", /本店不卖/u);
});

void test("a shop with no usable price cannot be bought from", () => {
  const result = purchaseList(plan([{ item: "眼药", min: 1, buyTo: 2 }]), bag(), 1000, [
    { area: "卡纳克", kind: "道具店", products: [{ name: "眼药", price: null }] },
  ]);
  assert.deepEqual(result.buy, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0] ?? "", /价格未知/u);
});

void test("an item already at buyTo is not bought again", () => {
  const result = purchaseList(
    plan([{ item: "恢复药", min: 1, buyTo: 3 }]),
    bag(["恢复药", 3]),
    1000,
    [shop(["恢复药", 100])],
  );
  assert.deepEqual(result, { buy: [], skipped: [] });
});

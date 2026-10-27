import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KeyEvents } from "../src/engine/events.ts";
import { Game, shopSelling } from "../src/engine/game.ts";
import { Guide } from "../src/engine/guide/kb.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import { loadNotes } from "../src/engine/notes.ts";
import { TOOLS } from "../src/engine/prompt.ts";
import type { Json } from "../src/engine/values.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

async function temporaryGame(notesFile?: string): Promise<Game> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-game-"));
  return await Game.create({
    laptop: LAPTOP,
    notesFile,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
  });
}

void test("notes persist and can be forgotten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-notes-"));
  const path = join(directory, "notes.json");
  try {
    const game = await temporaryGame(path);
    const pilot = new FakePilot();
    assert.equal(await game.run("remember", { note: "旅店在 (43,42)" }, pilot), "已记下(第 1 条)");
    assert.equal(
      await game.run("remember", { note: "宝箱 (9,6) 是陷阱" }, pilot),
      "已记下(第 2 条)",
    );
    const again = await temporaryGame(path);
    assert.deepEqual(again.notes, ["旅店在 (43,42)", "宝箱 (9,6) 是陷阱"]);

    assert.equal(await game.run("forget", { index: 2 }, pilot), "已删除:宝箱 (9,6) 是陷阱");
    assert.deepEqual(await loadNotes(path), ["旅店在 (43,42)"]);
    assert.equal(await game.run("forget", { index: 5 }, pilot), "没有第 5 条笔记");

    // The file is the same JSON array the Python player reads and writes.
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), ["旅店在 (43,42)"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("every tool has a handler", async () => {
  const game = await temporaryGame();
  const handled = new Set(game.handledTools());
  // Tools run in engine/game.ts, except `done`, which ends the turn in dsh itself.
  for (const tool of TOOLS) {
    if (tool.function.name === "done") continue;
    assert.ok(handled.has(tool.function.name), `${tool.function.name} 没有处理函数`);
  }
});

void test("a conveyor ride is kept in the atlas as a way", async () => {
  const game = await temporaryGame();
  assert.ok(game.moveState.link);
  await game.moveState.link(260, [13, 23], [9, 30], "传送带");
  assert.match(game.atlas.describe(260), /走法 在 \(13, 23\) 传送带 到 \(9, 30\)/);
});

void test("new gear is put on and reported", async () => {
  const game = await temporaryGame();
  const bags: Record<string, number>[] = [
    { 恢复药: 3, 宽刃剑: 1 },
    { 恢复药: 2, 宽刃剑: 1 }, // a potion used: nothing new to wear
    { 恢复药: 2, 宽刃剑: 1, 秘银头盔: 1 }, // a chest gave a helmet
    { 恢复药: 2, 宽刃剑: 1 }, // after 最强装备 it is worn, out of the bag
  ];
  const pilot = new FakePilot();
  pilot.onQuery(
    "items",
    bags.map((bag) => ({
      items: {
        normal: Object.entries(bag).map(([name, count]) => ({
          name,
          count,
          type: name === "恢复药" ? "Item" : "Armor",
        })),
      },
    })),
  );
  pilot.on("pos", { pos: { state: "Player" } });
  const worn: number[] = [];
  game.optimizeEquipment = () => {
    worn.push(1);
    return Promise.resolve([true, "巴兹:无→秘银头盔"]);
  };

  assert.equal(await game.checkGear(pilot), ""); // first look
  assert.equal(await game.checkGear(pilot), "");
  assert.equal(
    await game.checkGear(pilot),
    "得到新装备「秘银头盔」,已检查最强装备:巴兹:无→秘银头盔",
  );
  assert.deepEqual(worn, [1]);
  assert.deepEqual(game.gear, { 宽刃剑: 1 });
});

function record(seq: number, second: number, type: string, body: Json = {}): Json {
  const minute = Math.floor(second / 60);
  const rest = second % 60;
  return {
    seq,
    t: `2026-10-20T12:${String(minute).padStart(2, "0")}:${String(rest).padStart(2, "0")}Z`,
    type,
    ...body,
  };
}

function sample(seq: number, second: number, names: readonly string[]): Json {
  return record(seq, second, "sample", {
    user: { mapId: 30, areaText: "图尔村", gil: 100 },
    party: names.map((name) => ({ name, lv: 7, hp: 50 })),
    battle: { active: false },
  });
}

function at(minute: number): Date {
  return new Date(`2026-10-20T20:${String(minute).padStart(2, "0")}:00+08:00`);
}

void test("the opening carries the window and a tool result carries the news", async () => {
  let clock = 1000;
  const events = new KeyEvents(
    () => at(30),
    () => clock,
  );
  events.feed(record(1, 0, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.5.2" }));
  events.feed(sample(2, 1500, ["巴兹", "蕾娜", "加拉夫", "法利斯"]));
  events.feed(sample(3, 1501, ["巴兹", "蕾娜", "加拉夫"]));

  const game = await Game.create({
    laptop: LAPTOP,
    events,
    atlasFile: join(tmpdir(), "ffpr-game-no-atlas.json"),
    tacticsFile: join(tmpdir(), "ffpr-game-no-tactics.json"),
    elementsFile: join(tmpdir(), `ffpr-game-elements-${process.pid}.json`),
  });
  game.settle = () => Promise.resolve("");
  const pilot = new FakePilot();
  pilot.onQuery("items", { items: { normal: [], important: [] } });
  pilot.on("pos", { pos: { state: "Field", map: 30, cell: [1, 2] } });
  pilot.on("entities", { entities: { entities: [] } });
  pilot.onQuery("sample", {
    sample: { user: { mapId: 30, areaText: "图尔村" }, party: [] },
  });

  const { openingMessage } = await import("../src/plugin/player.ts");
  const opening = openingMessage(await game.observe(pilot), game.window(1));
  assert.match(opening, /最近几小时的重要事件:/);
  assert.match(opening, /20:25 队伍 法利斯 离队\(队伍 3 人\)/);

  events.feed(
    record(4, 1502, "dialog.play", {
      ids: ["E0003_00_001_a_01"],
      speaker: "巴兹",
      lines: ["法利斯去哪了？"],
    }),
  );
  clock += 1000;
  const result = await game.run("inventory", {}, pilot);
  assert.match(result, /新的重要事件:/);
  assert.match(result, /法利斯去哪了/);
});

void test("the simple tools answer through the pilot, one after another", async () => {
  const events = new KeyEvents(
    () => at(30),
    () => 1000,
  );
  events.feed(record(1, 0, "hello", { product: "FF5", gameVersion: "1.2.0", plugin: "0.7.2" }));
  events.feed(sample(2, 60, ["巴兹", "蕾娜"]));
  const game = await Game.create({
    laptop: LAPTOP,
    events,
    atlasFile: join(tmpdir(), `ffpr-game-atlas-${process.pid}.json`),
    tacticsFile: join(tmpdir(), `ffpr-game-tactics-${process.pid}.json`),
    elementsFile: join(tmpdir(), `ffpr-game-elements-${process.pid}.json`),
  });
  game.settle = () => Promise.resolve("");
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { state: "Field", map: 30, cell: [2, 2] } });
  pilot.on("entities", (fields) => {
    if (fields.kind === "GotoMap") {
      return {
        entities: {
          total: 1,
          entities: [{ kind: "GotoMap", cell: [3, 4], toMap: 2, name: "出口", active: true }],
        },
      };
    }
    if (fields.kind === "Event") {
      return {
        entities: {
          total: 5,
          entities: [
            { kind: "Event", cell: [5, 6], name: "ワールドマップ" },
            { kind: "Event", cell: [13, 23], name: "流される①" },
            { kind: "Event", cell: [13, 25], name: "流される①" },
            { kind: "Event", cell: [11, 9], name: "流される②" },
            { kind: "Event", cell: [12, 9], name: "流される②" },
          ],
        },
      };
    }
    if (fields.kind === "Npc") {
      return {
        entities: {
          total: 2,
          entities: [
            { kind: "Npc", cell: [3, 7], name: "老人（紫）", active: true },
            { kind: "Npc", cell: [10, 13], name: "帽子を被った男性（緑）", active: true },
          ],
        },
      };
    }
    if (fields.kind === "RelayInteraction") {
      return { entities: { total: 1, entities: [{ kind: "RelayInteraction", cell: [3, 8] }] } };
    }
    return { entities: { total: 0, entities: [] } };
  });
  pilot.on("cells", {
    cells: {
      origin: [0, 0],
      center: [2, 2],
      attr: [
        [3, 3, 3],
        [3, 3, 3],
        [3, 3, 3],
      ],
    },
  });
  pilot.on("keys", { ok: true });
  pilot.on("story", { pages: 3, stop: "choice" });
  pilot.on("leave", { ok: true, presses: 1 });
  pilot.onQuery("items", { items: { normal: [], important: [] } });
  pilot.onQuery("shop", { shop: { open: false } });
  pilot.onQuery("sample", {
    sample: {
      user: { mapId: 30, areaText: "图尔村" },
      party: [],
      choice: { c: { open: true, cursor: 0 } },
      field: { moveState: "Walking" },
    },
  });

  assert.match(await game.run("terrain", { radius: 8 }, pilot), /地形图/);
  assert.match(await game.run("entrances", {}, pilot), /通往地图 2/);
  await game.atlas.link(30, [13, 23], [9, 30], "传送带");
  const looked = await game.run("look_around", {}, pilot);
  assert.match(looked, /出口 @ \[5, 6\] 通往世界地图/);
  assert.match(looked, /Event @ \[13, 23\]、\[13, 25\] 流される① 传送带，踩上去会被带走/);
  assert.match(looked, /Event @ \[11, 9\]、\[12, 9\] 流される② 传送带，踩上去会被带走/);
  assert.match(looked, /走法 在 \(13, 23\) 传送带 到 \(9, 30\)/);
  // The old man has a counter (RelayInteraction) in front of him; the other NPC does not.
  assert.match(looked, /老人（紫）[^\n]*在柜台后，多半是店员/);
  assert.doesNotMatch(looked, /帽子を被った男性（緑）[^\n]*在柜台后/);
  assert.match(await game.run("advance_story", {}, pilot), /翻了 3 页,停下原因:choice/);
  assert.match(await game.run("choose", { index: 1 }, pilot), /^已选择/);
  assert.match(await game.run("leave_menu", {}, pilot), /已回到地图/);
  assert.match(await game.run("save_game", {}, pilot), /现在不能打开菜单/);
  assert.match(await game.run("land", {}, pilot), /^现在没有在飞/);
  assert.match(await game.run("board", {}, pilot), /不知道飞龙停在哪/);
  assert.match(
    await game.run("cast", { caster: "巴兹", spell: "治疗" }, pilot),
    /现在不能打开菜单/,
  );
  assert.match(
    await game.run("use_item", { item: "眼药", target: "巴兹" }, pilot),
    /现在不能打开菜单/,
  );
  assert.match(await game.run("optimize_equipment", {}, pilot), /现在不能打开菜单/);
  assert.match(await game.run("buy", { product: "恢复药" }, pilot), /^商店没有打开/);
  assert.match(await game.run("sell", { item: "恢复药" }, pilot), /^商店没有打开/);
  assert.match(await game.run("shop_gear", {}, pilot), /^商店没有打开/);
  assert.match(await game.run("fight", { plan: {} }, pilot), /规则表没有通过检查/);
  assert.match(await game.run("set_tactics", { tables: [] }, pilot), /策略没有通过检查/);
  assert.ok((await game.run("guide", { query: "图尔村" }, pilot)).length > 0);
  assert.match(await game.run("atlas", {}, pilot), /地图 30/);
  assert.match(await game.run("inventory", {}, pilot), /^道具:无\n贵重物品:无/);
});

void test("the ailment hint appears once per group and again on a new map", async () => {
  const game = await temporaryGame();
  game.mapId = 252;
  const pilot = new FakePilot();
  let party: Json[] = [
    { name: "巴兹", hp: 100, maxHp: 100, status: ["Blind"] },
    { name: "蕾娜", hp: 100, maxHp: 100, status: ["Blind"] },
    { name: "加拉夫", hp: 100, maxHp: 100 },
  ];
  let bag: Json[] = [];
  pilot.onQuery("sample", () => ({
    sample: { party, user: { areaText: "火力船" } },
  }));
  pilot.onQuery("items", () => ({ items: { normal: bag, important: [] } }));

  assert.match(await game.ailmentHint(pilot), /巴兹、蕾娜 黑暗:包里没有眼药,没人会治/);
  assert.equal(await game.ailmentHint(pilot), "");

  game.mapId = 253;
  assert.match(await game.ailmentHint(pilot), /巴兹、蕾娜 黑暗/);
  assert.equal(await game.ailmentHint(pilot), "");

  party = party.map((member) => ({ ...member, status: [] }));
  assert.equal(await game.ailmentHint(pilot), "");

  party = party.map((member) => ({
    ...member,
    status: member.name === "蕾娜" ? ["Blind"] : [],
  }));
  assert.match(await game.ailmentHint(pilot), /蕾娜 黑暗/);

  bag = [{ name: "<IC_ITEM>眼药", count: 1 }];
  assert.equal(await game.ailmentHint(pilot), "");
});

void test("the guide's English item names find the Chinese cure item", () => {
  const guide = new Guide(
    [
      {
        title: "Carwen",
        text: "",
        shops: [
          {
            where: "Carwen - Pub",
            kind: "道具",
            goods: [{ name: "Eye Drops", cost: 20, note: "Cures an ally of darkness." }],
          },
        ],
      },
    ],
    new Map(),
  );
  assert.equal(shopSelling(guide, "卡文镇", "眼药"), "Carwen - Pub");
  assert.equal(shopSelling(guide, "卡文镇", "解毒药"), "");
});

void test("a bridge with game buttons is ready unfocused and never pulls the game to the front", async () => {
  const game = await temporaryGame();
  const pilot = new FakePilot().on("status", { ok: true, focused: false, gameButtons: true });
  assert.equal(await game.ready(pilot), null);
  assert.equal(
    pilot.calls.some((call) => call.kind === "send" && call.op === "focus"),
    false,
  );
});

void test("without game buttons an unfocused game is still focused first", async () => {
  const game = await temporaryGame();
  const pilot = new FakePilot()
    .on("status", [
      { ok: true, focused: false },
      { ok: true, focused: true },
    ])
    .on("focus", { ok: true });
  assert.equal(await game.ready(pilot), null);
  assert.ok(pilot.calls.some((call) => call.kind === "send" && call.op === "focus"));
});

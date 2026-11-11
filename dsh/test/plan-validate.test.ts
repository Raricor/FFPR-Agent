import assert from "node:assert/strict";
import test from "node:test";
import type {
  SegmentFactsBlueMagic,
  SegmentFactsData,
  SegmentFactsMonster,
} from "../src/engine/plan/facts.ts";
import type { SegmentPlan, SegmentReport } from "../src/engine/plan/types.ts";
import {
  parseTurnBackCondition,
  saveStationProblem,
  validatePlan,
  type PlanRevision,
} from "../src/engine/plan/validate.ts";
import type { Knowledge } from "../src/engine/knowledge/index.ts";

function monster(bookId: number, name: string, maps: readonly number[]): SegmentFactsMonster {
  return {
    name,
    guideName: null,
    bookId,
    level: 1,
    hp: 20,
    mp: 0,
    weak: [],
    absorb: [],
    nullify: [],
    statusImmune: [],
    statusMoves: [],
    blueMagic: [],
    maps,
    chance: 0.5,
    missable: false,
    missableUntil: null,
    registered: false,
    boss: false,
    note: "",
  };
}

function blueMagic(
  options: { canLearn?: boolean; teacherMaps?: readonly number[] } = {},
): SegmentFactsBlueMagic {
  return {
    name: "Aero",
    learned: false,
    canLearn: options.canLearn ?? true,
    maps: options.teacherMaps ?? [11],
    teachers: [{ monster: "风形魔", bookId: 10, maps: options.teacherMaps ?? [11] }],
    timing: "now",
    when: "现在",
    window: "试验迷宫",
    note: "",
  };
}

function facts(overrides: Partial<SegmentFactsData> = {}): SegmentFactsData {
  return {
    game: "ff5",
    section: "试验迷宫",
    areaName: "试验迷宫",
    goal: "走完试验迷宫",
    maps: [
      {
        mapId: 10,
        name: "试验迷宫 １层",
        areaName: "试验迷宫",
        reasons: [],
        exits: [],
      },
      {
        mapId: 11,
        name: "试验迷宫 ２层",
        areaName: "试验迷宫",
        reasons: [],
        exits: [],
      },
      {
        mapId: 12,
        name: "试验迷宫 ３层",
        areaName: "试验迷宫",
        reasons: [],
        exits: [],
      },
    ],
    passThrough: [],
    revisitMaps: [],
    stations: [],
    chests: [],
    monsters: [monster(8, "黑哥布林", [10, 11]), monster(10, "风形魔", [11])],
    bosses: [],
    shops: [
      {
        area: "试验镇",
        kind: "道具店",
        products: [{ name: "恢复药", price: 10 }],
      },
    ],
    party: [
      {
        name: "巴兹",
        job: "青魔导士",
        level: 5,
        hp: 100,
        maxHp: 100,
        mp: 20,
        maxMp: 20,
        status: [],
        spells: [],
      },
    ],
    bag: [{ name: "恢复药", count: 2 }],
    gil: 100,
    bestiaryMissing: [],
    blueMagic: [blueMagic()],
    blueMagicMissing: [],
    notes: [],
    ...overrides,
  };
}

function table(): Record<string, unknown> {
  return { 巴兹: [{ do: "攻击" }] };
}

function plan(overrides: Partial<SegmentPlan> = {}): SegmentPlan {
  return {
    version: 1,
    section: "试验迷宫",
    goal: "走完试验迷宫",
    prep: {
      jobs: [{ member: "巴兹", job: "青魔导士" }],
      equip: "keep",
      buy: [{ item: "恢复药", count: 2 }],
      rows: [{ member: "巴兹", row: "back" }],
    },
    stations: [
      { to: "10:1,2", do: "open" },
      { to: "10:5,5", do: "heal", optional: true },
      { to: "11:3,4", do: "grind", until: { bestiary: [8], minutes: 5 } },
      { to: "12", do: "boss" },
    ],
    battle: [{ maps: [10], tables: [table()] }],
    bosses: [
      {
        name: "Wing Raptor",
        map: 12,
        healFirst: true,
        saveFirst: true,
        tables: [table()],
      },
    ],
    turnBack: [{ when: "party.lowest_hp_pct < 30", then: "heal-and-continue" }],
    ...overrides,
  };
}

void test("the base plan passes all checks", () => {
  const validation = validatePlan(plan(), facts());
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.ok, true);
});

void test("structure: version, section, goal and enum fields are required", () => {
  const badVersion = validatePlan({ ...plan(), version: 2 }, facts());
  assert.match(badVersion.problems.join("\n"), /version/u);
  const badSection = validatePlan({ ...plan(), section: "别处" }, facts());
  assert.match(badSection.problems.join("\n"), /section/u);
  const badGoal = validatePlan({ ...plan(), goal: " " }, facts());
  assert.match(badGoal.problems.join("\n"), /goal/u);
  const badAction = validatePlan(
    plan({ stations: [{ to: "10", do: "fly" as unknown as "move" }] }),
    facts(),
  );
  assert.match(badAction.problems.join("\n"), /do 不认识/u);
  const notObject = validatePlan("计划", facts());
  assert.equal(notObject.ok, false);
});

void test("stations: target spelling, map membership, choose/until placement", () => {
  const named = validatePlan(plan({ stations: [{ to: "试验迷宫", do: "move" }] }), facts());
  assert.match(named.problems.join("\n"), /地图号:x,y/u);
  const outside = validatePlan(plan({ stations: [{ to: "99:1,1", do: "move" }] }), facts());
  assert.match(outside.problems.join("\n"), /地图 99 不属于这一节/u);
  const choose = validatePlan(plan({ stations: [{ to: "10", do: "move", choose: 1 }] }), facts());
  assert.match(choose.problems.join("\n"), /只有 do 是 choose 才能写 choose/u);
  const missingChoose = validatePlan(plan({ stations: [{ to: "10", do: "choose" }] }), facts());
  assert.match(missingChoose.problems.join("\n"), /选项序号/u);
  const until = validatePlan(
    plan({ stations: [{ to: "10", do: "open", until: { minutes: 5 } }] }),
    facts(),
  );
  assert.match(until.problems.join("\n"), /只有 do 是 grind 才能写 until/u);
});

void test("open, talk, switch and choose need a real cell, other actions do not", () => {
  for (const action of ["open", "talk", "switch", "choose"] as const) {
    const validation = validatePlan(
      plan({
        stations: [
          {
            to: "10",
            do: action,
            ...(action === "choose" ? { choose: 0 } : {}),
          },
        ],
      }),
      facts(),
    );
    assert.match(
      validation.problems.join("\n"),
      new RegExp(`第 1 站 do=${action} 要写格子\\(图:x,y\\)`, "u"),
    );
  }
  for (const action of ["move", "story", "grind", "boss", "heal", "save", "buy"] as const) {
    const validation = validatePlan(
      plan({
        stations: [
          {
            to: "10",
            do: action,
            ...(action === "grind" ? { until: { minutes: 5 } } : {}),
            ...(action === "buy" ? { items: [{ item: "恢复药", count: 1 }] } : {}),
          },
        ],
      }),
      facts(),
    );
    assert.doesNotMatch(validation.problems.join("\n"), /要写格子/u);
  }
});

void test("buy stations need items and a nearby shop that sells them", () => {
  const good = validatePlan(
    plan({
      stations: [{ to: "10:4,4", do: "buy", items: [{ item: "恢复药", count: 2 }] }],
    }),
    facts(),
  );
  assert.deepEqual(good.problems, []);

  const missing = validatePlan(plan({ stations: [{ to: "10:4,4", do: "buy" }] }), facts());
  assert.match(missing.problems.join("\n"), /do 是 buy 就要写 items/u);

  const notSold = validatePlan(
    plan({
      stations: [{ to: "10:4,4", do: "buy", items: [{ item: "圣灵药", count: 1 }] }],
    }),
    facts(),
  );
  assert.match(notSold.problems.join("\n"), /没有卖「圣灵药」/u);

  const misplaced = validatePlan(
    plan({
      stations: [{ to: "10:4,4", do: "move", items: [{ item: "恢复药", count: 1 }] }],
    }),
    facts(),
  );
  assert.match(misplaced.problems.join("\n"), /只有 do 是 buy 才能写 items/u);
});

void test("a magic buy accepts English or Chinese names only when the shop sells it", () => {
  const magicFacts = facts({
    shops: [
      {
        area: "图尔村",
        kind: "魔法店",
        products: [
          { name: "火炎", price: 150, itemId: 392, aliases: ["Fire"] },
          { name: "治疗", price: 180, itemId: 393, aliases: ["Cure"] },
        ],
      },
    ],
  });
  for (const item of ["Fire", "火炎", "Cure", "治疗"]) {
    const validation = validatePlan(
      plan({ prep: { ...plan().prep, buy: [{ item, count: 1 }] } }),
      magicFacts,
    );
    assert.deepEqual(validation.problems, [], `${item} should be sold`);
  }
  const missing = validatePlan(
    plan({ prep: { ...plan().prep, buy: [{ item: "Blizzard", count: 1 }] } }),
    magicFacts,
  );
  assert.match(missing.problems.join("\n"), /没有卖「Blizzard」/u);
});

void test("stations may stand on the current map and cross towns on the way", () => {
  const routeFacts = facts({
    passThrough: [{ mapId: 30, name: "图尔村", from: [] }],
    currentMapId: 204,
  });
  const ok = validatePlan(
    plan({
      stations: [
        { to: "204", do: "save", optional: true },
        { to: "30", do: "move" },
        { to: "10:1,2", do: "open" },
      ],
    }),
    routeFacts,
  );
  assert.deepEqual(ok.problems, []);
  const unrelated = validatePlan(plan({ stations: [{ to: "99", do: "move" }] }), routeFacts);
  assert.match(unrelated.problems.join("\n"), /地图 99 不属于这一节/u);
});

void test("grind: bestiary must be met here; blue magic needs a teacher and a Blue Mage", () => {
  const wrongMonster = validatePlan(
    plan({ stations: [{ to: "11", do: "grind", until: { bestiary: [999] } }] }),
    facts(),
  );
  assert.match(wrongMonster.problems.join("\n"), /没有记录/u);
  const wrongMap = validatePlan(
    plan({ stations: [{ to: "11", do: "grind", until: { bestiary: [10] } }] }),
    facts({
      monsters: [monster(8, "黑哥布林", [10]), monster(10, "风形魔", [99])],
    }),
  );
  assert.match(wrongMap.problems.join("\n"), /不在这节地图出现/u);
  const noTeacher = validatePlan(
    plan({
      stations: [{ to: "11", do: "grind", until: { blueMagic: ["Aero"] } }],
    }),
    facts({ blueMagic: [blueMagic({ teacherMaps: [] })] }),
  );
  assert.match(noTeacher.problems.join("\n"), /没有会教/u);
  const noBlueMage = validatePlan(
    plan({
      stations: [{ to: "11", do: "grind", until: { blueMagic: ["Aero"] } }],
    }),
    facts({ blueMagic: [blueMagic({ canLearn: false })] }),
  );
  assert.match(noBlueMage.problems.join("\n"), /没有青魔导士/u);
  const empty = validatePlan(plan({ stations: [{ to: "11", do: "grind", until: {} }] }), facts());
  assert.match(empty.problems.join("\n"), /至少要写/u);
});

void test("prep: members, jobs, items and nearby shops are checked", () => {
  const badJob = validatePlan(
    plan({
      prep: {
        jobs: [{ member: "巴兹", job: "时空骑士" }],
        equip: "keep",
        buy: [],
        rows: [],
      },
    }),
    facts(),
  );
  assert.match(badJob.problems.join("\n"), /不知道职业/u);
  const badMember = validatePlan(
    plan({
      prep: {
        jobs: [{ member: "蕾娜", job: "白魔法师" }],
        equip: "keep",
        buy: [],
        rows: [],
      },
    }),
    facts(),
  );
  assert.match(badMember.problems.join("\n"), /队伍里没有/u);
  const badItem = validatePlan(
    plan({
      prep: {
        jobs: [],
        equip: "keep",
        buy: [{ item: "圣灵药", count: 1 }],
        rows: [],
      },
    }),
    facts(),
  );
  assert.match(badItem.problems.join("\n"), /没有卖/u);
  const badEquip = validatePlan(
    plan({
      prep: { jobs: [], equip: "best" as unknown as "keep", buy: [], rows: [] },
    }),
    facts(),
  );
  assert.match(badEquip.problems.join("\n"), /optimize 或 keep/u);
});

void test("a buy the nearby shops sell says which shop code will visit", () => {
  const validation = validatePlan(plan(), facts());
  assert.deepEqual(validation.problems, []);
  assert.ok(
    (validation.notes ?? []).some((note) =>
      note.includes("代码会去「试验镇道具店」买「恢复药」×2"),
    ),
    (validation.notes ?? []).join("\n"),
  );
});

void test("battle and boss tables go through the existing rule checks", () => {
  const badBattle = validatePlan(
    plan({
      battle: [
        {
          maps: [10],
          tables: [{ 巴兹: [{ if: "unknown.thing < 1", do: "攻击" }] }],
        },
      ],
    }),
    facts(),
  );
  assert.match(badBattle.problems.join("\n"), /第 1 套/u);
  const badBoss = validatePlan(
    plan({
      bosses: [
        {
          name: "Wing Raptor",
          map: 12,
          healFirst: true,
          saveFirst: false,
          tables: [{ 巴兹: [{ if: "ally.dead >= 1", do: "道具:不死鸟之尾" }] }],
        },
      ],
    }),
    facts(),
  );
  assert.match(badBoss.problems.join("\n"), /最后一条要不带条件|缺少 do/u);
  const badBossMap = validatePlan(
    plan({
      bosses: [
        {
          name: "Wing Raptor",
          map: 99,
          healFirst: true,
          saveFirst: false,
          tables: [table()],
        },
      ],
    }),
    facts(),
  );
  assert.match(badBossMap.problems.join("\n"), /地图 99 不属于/u);
});

void test("turnBack conditions parse the four supported forms and reject others", () => {
  for (const when of [
    "party.lowest_hp_pct < 30",
    "party.dead >= 1",
    "item.不死鸟之尾 < 2",
    "party.mp_pct < 20",
  ]) {
    const parsed = parseTurnBackCondition(when);
    assert.equal(parsed.ok, true, when);
  }
  assert.equal(parseTurnBackCondition("party.hp < 30").ok, false);
  assert.equal(parseTurnBackCondition("party.lowest_hp_pct < 101").ok, false);
  assert.equal(parseTurnBackCondition("party.dead >= 1.5").ok, false);

  const bad = validatePlan(
    plan({ turnBack: [{ when: "party.hp < 30", then: "replan" }] }),
    facts(),
  );
  assert.match(bad.problems.join("\n"), /看不懂/u);
  const badThen = validatePlan(
    plan({
      turnBack: [
        {
          when: "party.lowest_hp_pct < 30",
          then: "continue" as unknown as "replan",
        },
      ],
    }),
    facts(),
  );
  assert.match(badThen.problems.join("\n"), /then 只能是/u);
});

void test("a heal/save station without optional is fixed automatically", () => {
  const validation = validatePlan(
    plan({
      stations: [
        { to: "10:5,5", do: "heal" },
        { to: "11:6,6", do: "save" },
      ],
    }),
    facts(),
  );
  assert.equal(validation.ok, true);
  assert.ok(validation.fixed !== undefined);
  assert.deepEqual(
    validation.fixed.stations.map((station) => station.optional),
    [true, true],
  );
});

function previousRun(
  planOverrides: Partial<SegmentPlan> = {},
  reportOverrides: Partial<SegmentReport> = {},
): PlanRevision {
  return {
    plan: plan(planOverrides),
    report: {
      section: "试验迷宫",
      status: "exception",
      done: {
        stations: 0,
        chestsOpened: 0,
        battles: 0,
        bestiaryNew: [],
        blueMagicNew: [],
        bossesWon: [],
      },
      remaining: [0],
      party: "巴兹 HP 100/100",
      minutes: 3,
      modelCalls: 0,
      ...reportOverrides,
    },
  };
}

void test("an exception revision must keep the undone station or drop it with a reason", () => {
  const missing = validatePlan(
    plan({ stations: [{ to: "10:5,5", do: "heal", optional: true }] }),
    facts(),
    previousRun(),
  );
  assert.match(missing.problems.join("\n"), /还没做的站要留着/u);
  assert.match(missing.problems.join("\n"), /第 1 站 open 10:1,2/u);

  const moved = validatePlan(
    plan({ stations: [{ to: "10:9,9", do: "open" }] }),
    facts(),
    previousRun(),
  );
  assert.deepEqual(moved.problems, []);

  const dropped = validatePlan(
    plan({
      stations: [],
      dropped: [{ to: "10:1,2", do: "open", why: "宝箱开过了" }],
    }),
    facts(),
    previousRun(),
  );
  assert.deepEqual(dropped.problems, []);
});

void test("a save station in a dungeon with no known save point is rejected at submit", () => {
  const maze = validatePlan(plan({ stations: [{ to: "10", do: "save" }] }), facts());
  assert.equal(
    maze.problems.some((problem) => problem.includes("这里存不了档")),
    false,
  );
  assert.match(maze.warnings?.join("\n") ?? "", /没有存档点数据，降为提醒/u);

  const noSaveData = {
    maps: [{ id: 10, name: "试验迷宫 １层" }],
    savePoints: [],
    mapFiles: [{ id: 10, name: "试验迷宫 １层", savePoints: [] }],
  } as unknown as Knowledge;
  assert.match(
    saveStationProblem({ to: "10", do: "save" }, noSaveData) ?? "",
    /图 10 试验迷宫 １层 不是世界地图，也查不到存档点，这里存不了档/u,
  );

  assert.equal(saveStationProblem({ to: "1", do: "save" }, undefined), null);

  const knowledge = {
    maps: [{ id: 10, name: "试验迷宫 １层" }],
    savePoints: [{ mapId: 10, cell: [5, 5] }],
    mapFiles: [],
  } as unknown as Knowledge;
  assert.equal(saveStationProblem({ to: "10:5,5", do: "save" }, knowledge), null);
  assert.equal(saveStationProblem({ to: "10:6,6", do: "save" }, knowledge), null);
});

void test("a revision does not check a new section, a done report or a missing previous run", () => {
  const noPrevious = validatePlan(plan({ stations: [] }), facts());
  assert.deepEqual(noPrevious.problems, []);
  const otherSection = validatePlan(
    plan({ stations: [] }),
    facts(),
    previousRun({}, { section: "别处" }),
  );
  assert.deepEqual(otherSection.problems, []);
  const done = validatePlan(plan({ stations: [] }), facts(), previousRun({}, { status: "done" }));
  assert.deepEqual(done.problems, []);
});

void test("dropped entries are checked for shape even without a previous run", () => {
  const notArray = validatePlan(
    plan({ stations: [], dropped: "10:1,2" as unknown as [] }),
    facts(),
  );
  assert.match(notArray.problems.join("\n"), /dropped 要写成数组/u);
  const badAction = validatePlan(
    plan({
      stations: [],
      dropped: [{ to: "10:1,2", do: "fly" as unknown as "open", why: "不去了" }],
    }),
    facts(),
  );
  assert.match(badAction.problems.join("\n"), /do 不认识/u);
  const emptyWhy = validatePlan(
    plan({ stations: [], dropped: [{ to: "10:1,2", do: "open", why: " " }] }),
    facts(),
  );
  assert.match(emptyWhy.problems.join("\n"), /why 要写清楚/u);
});

function bossFacts(
  triggers: readonly {
    readonly map: number;
    readonly cell: [number, number];
  }[],
  defeated?: boolean | null,
) {
  return facts({
    bosses: [
      {
        name: "Wing Raptor",
        knowledgeName: "巨翼猛禽",
        guideName: null,
        bookId: 20,
        maps: [12],
        triggers,
        ...(defeated === undefined ? {} : { defeated }),
        hp: 250,
        mp: 10,
        level: 5,
        weak: [],
        absorb: [],
        nullify: [],
        statusImmune: [],
        guideNote: "",
        note: "",
      },
    ],
  });
}

void test("a boss station that writes only its map must add the single trigger cell", () => {
  const one = validatePlan(
    plan({ stations: [{ to: "12", do: "boss" }] }),
    bossFacts([{ map: 12, cell: [7, 8] }]),
  );
  assert.match(one.problems.join("\n"), /首领站「12」要写坐标/u);
  assert.match(one.problems.join("\n"), /巨翼猛禽的触发点是 12:7,8/u);

  const written = validatePlan(
    plan({ stations: [{ to: "12:7,8", do: "boss" }] }),
    bossFacts([{ map: 12, cell: [7, 8] }]),
  );
  assert.deepEqual(written.problems, []);

  const multiple = validatePlan(
    plan({ stations: [{ to: "12", do: "boss" }] }),
    bossFacts([
      { map: 12, cell: [7, 8] },
      { map: 12, cell: [9, 10] },
    ]),
  );
  assert.deepEqual(multiple.problems, []);

  const none = validatePlan(plan({ stations: [{ to: "12", do: "boss" }] }), bossFacts([]));
  assert.deepEqual(none.problems, []);
});

function chestFacts(opened: boolean | null = false) {
  return facts({
    chests: [
      {
        item: "帐篷",
        where: null,
        mapId: 10,
        mapName: "试验迷宫 １层",
        cell: [6, 6],
        opened,
        note: "",
      },
    ],
  });
}

void test("every plan must cover the section's unopened chests or drop them", () => {
  const missing = validatePlan(plan({ stations: [] }), chestFacts());
  assert.match(missing.problems.join("\n"), /还有 1 个宝箱没写进计划/u);
  assert.match(missing.problems.join("\n"), /10:6,6 帐篷/u);

  const covered = validatePlan(plan({ stations: [{ to: "10:6,6", do: "open" }] }), chestFacts());
  assert.deepEqual(covered.problems, []);

  const otherCell = validatePlan(plan({ stations: [{ to: "10:7,6", do: "open" }] }), chestFacts());
  assert.match(otherCell.problems.join("\n"), /10:6,6 帐篷/u);

  const dropped = validatePlan(
    plan({
      stations: [],
      dropped: [{ to: "10:6,6", do: "open", why: "已经拿过了" }],
    }),
    chestFacts(),
  );
  assert.deepEqual(dropped.problems, []);

  const alreadyOpen = validatePlan(plan({ stations: [] }), chestFacts(true));
  assert.deepEqual(alreadyOpen.problems, []);
});

void test("every plan must cover an undefeated boss or drop it", () => {
  const missing = validatePlan(plan({ stations: [] }), bossFacts([]));
  assert.match(missing.problems.join("\n"), /还有 1 个首领没写进计划/u);
  assert.match(missing.problems.join("\n"), /Wing Raptor\(12\)/u);

  const covered = validatePlan(plan({ stations: [{ to: "12", do: "boss" }] }), bossFacts([]));
  assert.deepEqual(covered.problems, []);

  const wrongMap = validatePlan(plan({ stations: [{ to: "10", do: "boss" }] }), bossFacts([]));
  assert.match(wrongMap.problems.join("\n"), /Wing Raptor\(12\)/u);

  const dropped = validatePlan(
    plan({
      stations: [],
      dropped: [{ to: "12", do: "boss", why: "这节先不打" }],
    }),
    bossFacts([]),
  );
  assert.deepEqual(dropped.problems, []);

  const beaten = validatePlan(plan({ stations: [] }), bossFacts([], true));
  assert.deepEqual(beaten.problems, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChapterFallback,
  ChapterFactsData,
  ChapterPlan,
} from "../src/engine/plan/chapter-types.ts";
import { chapterFactsText } from "../src/engine/plan/chapter-facts.ts";
import { storyTriggerWarning, validateChapterPlan } from "../src/engine/plan/chapter-validate.ts";
import type { Knowledge } from "../src/engine/knowledge/index.ts";
import type { PlanStation, SegmentPlan } from "../src/engine/plan/types.ts";
import {
  testBlueMagic,
  testBoss,
  testChapterFacts,
  testChapterPlan,
  testSegmentFacts,
  testSegmentPlan,
  testStation,
} from "./chapter-fixture.ts";

function replaceStations(
  plan: ChapterPlan,
  segment: number,
  change: (stations: readonly PlanStation[]) => readonly PlanStation[],
): ChapterPlan {
  return {
    ...plan,
    segments: plan.segments.map((entry, index) =>
      index === segment ? { ...entry, stations: change(entry.stations) } : entry,
    ),
  };
}

function without(plan: ChapterPlan, segment: number, to: string): ChapterPlan {
  return replaceStations(plan, segment, (stations) =>
    stations.filter((station) => station.to !== to),
  );
}

function replaceGrind(plan: ChapterPlan, until: NonNullable<PlanStation["until"]>): ChapterPlan {
  return replaceStations(plan, 0, (stations) =>
    stations.map((station) => (station.do === "grind" ? { ...station, until } : station)),
  );
}

function firstSegment(plan: ChapterPlan): SegmentPlan {
  const first = plan.segments[0];
  if (first === undefined) throw new Error("fixture needs a first segment");
  return first;
}

function secondPlan(plan: ChapterPlan): SegmentPlan {
  const second = plan.segments[1];
  if (second === undefined) throw new Error("fixture needs a second segment");
  return second;
}

function firstProblems(plan: unknown, facts: ChapterFactsData = testChapterFacts()): string {
  return validateChapterPlan(plan, facts).problems.join("\n");
}

function noBlueMageFacts(): ChapterFactsData {
  const facts = testChapterFacts();
  return {
    ...facts,
    sections: facts.sections.map((section) =>
      section.title !== "第一迷宫"
        ? {
            ...section,
            facts: {
              ...section.facts,
              party: section.facts.party.map((member) => ({
                ...member,
                job: "战士",
              })),
            },
          }
        : {
            ...section,
            facts: {
              ...section.facts,
              party: section.facts.party.map((member) => ({
                ...member,
                job: "战士",
              })),
              blueMagic: [testBlueMagic({ name: "水泡", canLearn: false })],
              blueMagicMissing: [testBlueMagic({ name: "水泡", canLearn: false })],
            },
          },
    ),
  };
}

void test("the base two-section chapter plan passes", () => {
  const facts = testChapterFacts();
  const validation = validateChapterPlan(testChapterPlan(), facts);
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.warnings, []);
});

void test("a missing chest or hidden item is rejected, and skipped accepts it", () => {
  const facts = testChapterFacts();
  const missingChest = without(testChapterPlan(), 0, "10:1,1");
  assert.match(firstProblems(missingChest, facts), /宝箱/u);
  assert.match(firstProblems(missingChest, facts), /恢复药/u);

  const skippedChest = {
    ...missingChest,
    skipped: [
      {
        kind: "chest" as const,
        name: "恢复药",
        where: "10:1,1",
        why: "宝箱拿过了",
      },
    ],
  };
  assert.equal(validateChapterPlan(skippedChest, facts).ok, true);

  const missingHidden = without(testChapterPlan(), 0, "10:2,2");
  assert.match(firstProblems(missingHidden, facts), /隐藏道具/u);
  const skippedHidden = {
    ...missingHidden,
    skipped: [
      {
        kind: "hidden" as const,
        name: "隐形草",
        where: "10:2,2",
        why: "这个格子进不去",
      },
    ],
  };
  assert.equal(validateChapterPlan(skippedHidden, facts).ok, true);
});

void test("a boss listed in a segment's bosses table is covered by that segment's boss station", () => {
  const base = testChapterFacts();
  const first = base.sections[0];
  assert.ok(first !== undefined);
  const boss = testBoss({ name: "Magissa", maps: [227] });
  const facts: ChapterFactsData = {
    ...base,
    sections: [
      {
        ...first,
        facts: {
          ...first.facts,
          maps: [
            ...first.facts.maps,
            {
              mapId: 227,
              name: "北山",
              areaName: "北山",
              reasons: [],
              exits: [],
            },
          ],
          bosses: [boss],
        },
      },
      ...base.sections.slice(1),
    ],
  };
  const plan = testChapterPlan();
  const firstPlan = plan.segments[0];
  assert.ok(firstPlan !== undefined);
  const table = { 巴兹: [{ do: "攻击" }] };
  const withBossTable: ChapterPlan = {
    ...plan,
    segments: [
      {
        ...firstPlan,
        bosses: [
          {
            name: "Magissa",
            map: 227,
            healFirst: true,
            saveFirst: false,
            tables: [table],
          },
        ],
      },
      ...plan.segments.slice(1),
    ],
  };
  assert.deepEqual(validateChapterPlan(withBossTable, facts).problems, []);
  assert.match(firstProblems(plan, facts), /首领/u);
  assert.match(firstProblems(plan, facts), /Magissa/u);
});

void test("the chapter text marks a boss already defeated in this save", () => {
  const base = testChapterFacts();
  const first = base.sections[0];
  assert.ok(first !== undefined);
  const facts: ChapterFactsData = {
    ...base,
    sections: [
      {
        ...first,
        facts: {
          ...first.facts,
          bosses: [testBoss({ name: "Karlabos", maps: [210], defeated: true })],
        },
      },
      ...base.sections.slice(1),
    ],
  };
  assert.match(chapterFactsText(facts), /Karlabos.*已打倒/u);
});

function bossTriggerFacts(cells: readonly [number, number][]): ChapterFactsData {
  const base = testChapterFacts();
  return {
    ...base,
    sections: base.sections.map((section) =>
      section.title !== "第一迷宫"
        ? section
        : {
            ...section,
            facts: {
              ...section.facts,
              bosses: [
                {
                  ...testBoss({ name: "哥布林王", maps: [10] }),
                  triggers: cells.map((cell) => ({ map: 10, cell })),
                },
              ],
            },
          },
    ),
  };
}

function bossWithoutCell(plan: ChapterPlan): ChapterPlan {
  return replaceStations(plan, 0, (stations) =>
    stations.map((station) => (station.do === "boss" ? { ...station, to: "10" } : station)),
  );
}

void test("a boss station with no cell is rejected only when the facts have no trigger", () => {
  const empty = validateChapterPlan(bossWithoutCell(testChapterPlan()), bossTriggerFacts([]));
  assert.match(empty.problems.join("\n"), /没写坐标/u);
  assert.match(empty.problems.join("\n"), /找不到「哥布林王」的触发点/u);

  const two = validateChapterPlan(
    bossWithoutCell(testChapterPlan()),
    bossTriggerFacts([
      [5, 5],
      [6, 6],
    ]),
  );
  assert.equal(two.ok, true);

  const one = validateChapterPlan(bossWithoutCell(testChapterPlan()), bossTriggerFacts([[5, 5]]));
  assert.match(one.problems.join("\n"), /要写坐标/u);
  assert.doesNotMatch(one.problems.join("\n"), /找不到/u);
});

void test("a missing boss is rejected, and skipped accepts it", () => {
  const facts = testChapterFacts();
  const missing = without(testChapterPlan(), 0, "10:5,5");
  assert.match(firstProblems(missing, facts), /首领/u);
  assert.match(firstProblems(missing, facts), /哥布林王/u);
  const skipped = {
    ...missing,
    skipped: [{ kind: "boss" as const, name: "哥布林王", why: "这一章绕开它" }],
  };
  assert.equal(validateChapterPlan(skipped, facts).ok, true);
});

function rewardFacts(kind: "hidden" | "event", item: string): ChapterFactsData {
  return testChapterFacts({
    hiddenItems: [{ kind, mapId: 10, cell: [7, 7], item, opened: false, source: "测试" }],
    sections: [
      {
        index: 0,
        title: "第一迷宫",
        done: false,
        facts: testSegmentFacts("第一迷宫", [10]),
      },
      {
        index: 1,
        title: "第二迷宫",
        done: false,
        facts: testSegmentFacts("第二迷宫", [11]),
      },
    ],
    shops: [],
    encounters: [],
  });
}

function rewardPlan(action: PlanStation["do"], to = "10:9,9"): ChapterPlan {
  return testChapterPlan({
    segments: [
      testSegmentPlan("第一迷宫", [
        testStation({
          to,
          do: action,
          ...(action === "choose" ? { choose: 0 } : {}),
        }),
      ]),
      testSegmentPlan("第二迷宫"),
    ],
  });
}

void test("an event reward accepts any open/talk/story/switch/choose station on its map", () => {
  const facts = rewardFacts("event", "缎带");
  for (const action of ["open", "talk", "story", "switch", "choose"] as const) {
    const validation = validateChapterPlan(rewardPlan(action), facts);
    assert.deepEqual(validation.problems, [], `${action} should cover the event reward`);
  }
  const missing = validateChapterPlan(rewardPlan("move"), facts);
  assert.match(missing.problems.join("\n"), /事件奖励/u);
  assert.match(missing.problems.join("\n"), /缎带/u);
  assert.match(missing.problems.join("\n"), /触发条件看攻略/u);
});

void test("the chapter check keeps the per-segment cell requirement for talk/switch", () => {
  const facts = rewardFacts("event", "缎带");
  const validation = validateChapterPlan(rewardPlan("talk", "10"), facts);
  assert.match(validation.problems.join("\n"), /第 1 段:第 1 站 do=talk 要写格子/u);
});

void test("an event reward can be skipped, but not by a station on another map", () => {
  const facts = rewardFacts("event", "缎带");
  const otherMap = validateChapterPlan(rewardPlan("talk", "11:1,1"), facts);
  assert.match(otherMap.problems.join("\n"), /事件奖励/u);
  const skipped = {
    ...rewardPlan("move"),
    skipped: [
      {
        kind: "hidden" as const,
        name: "缎带",
        where: "10:9,9",
        why: "剧情过了才拿得到",
      },
    ],
  };
  assert.equal(validateChapterPlan(skipped, facts).ok, true);
});

void test("a hidden item still needs its own cell, not any station on the map", () => {
  const facts = rewardFacts("hidden", "隐形草");
  const elsewhere = validateChapterPlan(rewardPlan("open", "10:9,9"), facts);
  assert.match(elsewhere.problems.join("\n"), /隐藏道具/u);
  assert.match(elsewhere.problems.join("\n"), /隐形草/u);
  assert.equal(validateChapterPlan(rewardPlan("open", "10:7,7"), facts).ok, true);
});

void test("a missing bestiary entry is rejected, and skipped accepts it", () => {
  const facts = testChapterFacts();
  const missing = replaceGrind(testChapterPlan(), {
    blueMagic: ["水泡"],
    minutes: 5,
  });
  assert.match(firstProblems(missing, facts), /图鉴/u);
  assert.match(firstProblems(missing, facts), /哥布林/u);
  const skipped = {
    ...missing,
    skipped: [{ kind: "bestiary" as const, name: "哥布林", why: "已经登记过别的档" }],
  };
  assert.equal(validateChapterPlan(skipped, facts).ok, true);
});

void test("a missing blue spell is rejected and skipped accepts it", () => {
  const facts = testChapterFacts();
  const missing = replaceGrind(testChapterPlan(), {
    bestiary: [8],
    minutes: 5,
  });
  assert.match(firstProblems(missing, facts), /青魔法/u);
  const skipped = {
    ...missing,
    skipped: [{ kind: "blueMagic" as const, name: "水泡", why: "错过学习窗口" }],
  };
  assert.equal(validateChapterPlan(skipped, facts).ok, true);
});

void test("without a Blue Mage only skipped with a reason can cover blue magic", () => {
  const facts = noBlueMageFacts();
  const plan = replaceGrind(testChapterPlan(), { bestiary: [8], minutes: 5 });
  assert.match(firstProblems(plan, facts), /没有青魔导士/u);
  const skipped = {
    ...plan,
    skipped: [
      {
        kind: "blueMagic" as const,
        name: "水泡",
        why: "队里没人能学,后面也不换",
      },
    ],
  };
  assert.equal(validateChapterPlan(skipped, facts).ok, true);
});

void test("a buy station must have a shop on its map that sells every item", () => {
  const facts = testChapterFacts();
  const noShop = replaceStations(
    {
      ...testChapterPlan(),
      segments: [
        firstSegment(testChapterPlan()),
        testSegmentPlan("第二迷宫", [
          testStation({
            to: "11:1,1",
            do: "buy",
            items: [{ item: "恢复药", count: 1 }],
          }),
        ]),
      ],
    },
    1,
    (stations) => stations,
  );
  assert.match(firstProblems(noShop, facts), /地图 11 上没有这家店/u);

  const notSold = replaceStations(testChapterPlan(), 0, (stations) =>
    stations.map((station) =>
      station.do === "buy" ? { ...station, items: [{ item: "圣灵药", count: 1 }] } : station,
    ),
  );
  assert.match(firstProblems(notSold, facts), /没有卖「圣灵药」/u);

  const iconTagged = {
    ...facts,
    shops: facts.shops.map((shop) => ({
      ...shop,
      products: shop.products.map((product) =>
        product.name === "恢复药" ? { ...product, name: "<IC_BAG>恢复药" } : product,
      ),
    })),
  };
  assert.equal(validateChapterPlan(testChapterPlan(), iconTagged).ok, true);
});

void test("buying more than the purse plus this chapter's chest gil is only a warning", () => {
  const facts = testChapterFacts();
  const plan = replaceStations(testChapterPlan(), 0, (stations) =>
    stations.map((station) =>
      station.do === "buy" ? { ...station, items: [{ item: "高级药", count: 5 }] } : station,
    ),
  );
  const validation = validateChapterPlan(plan, facts);
  assert.equal(validation.ok, true);
  assert.match(validation.warnings.join("\n"), /整章采购/u);
  assert.match(validation.warnings.join("\n"), /100/);
});

void test("chest gil raises the budget", () => {
  const base = testChapterFacts();
  const facts: ChapterFactsData = {
    ...base,
    sections: base.sections.map((section) =>
      section.title !== "第一迷宫"
        ? section
        : {
            ...section,
            facts: {
              ...section.facts,
              chests: [
                ...section.facts.chests,
                {
                  item: "1000 Gil",
                  where: null,
                  mapId: 10,
                  mapName: "测试地图 10",
                  cell: [6, 6],
                  opened: false,
                  note: "",
                },
              ],
            },
          },
    ),
  };
  const plan = replaceStations(testChapterPlan(), 0, (stations) => [
    ...stations,
    testStation({ to: "10:6,6", do: "open" }),
  ]);
  const expensive = replaceStations(plan, 0, (stations) =>
    stations.map((station) =>
      station.do === "buy" ? { ...station, items: [{ item: "高级药", count: 8 }] } : station,
    ),
  );
  const validation = validateChapterPlan(expensive, facts);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.warnings, []);
});

void test("growth: before must point at a segment, a level or gil target is required, maxMinutes > 0", () => {
  const facts = testChapterFacts();
  const base = testChapterPlan();
  const cases: [string, unknown][] = [
    ["before", { ...base, growth: [{ ...base.growth[0], before: 2 }] }],
    ["before", { ...base, growth: [{ ...base.growth[0], before: -1 }] }],
    [
      "level 或 gil",
      {
        ...base,
        growth: [{ before: 0, where: "10:3,3", why: "练级", maxMinutes: 10 }],
      },
    ],
    ["maxMinutes", { ...base, growth: [{ ...base.growth[0], maxMinutes: 0 }] }],
    ["where", { ...base, growth: [{ ...base.growth[0], where: "地图一" }] }],
  ];
  for (const [pattern, plan] of cases) {
    assert.match(firstProblems(plan, facts), new RegExp(pattern, "u"));
  }
});

void test("fallback: retries and boss retries 0–3, healBelowPct 10–60, fields present", () => {
  const facts = testChapterFacts();
  const base = testChapterPlan();
  const fallback = base.fallback;
  const valid: ChapterFallback = {
    retries: 0,
    bossLost: { levels: 1, where: null, tries: 3 },
    skipOptional: false,
    healBelowPct: 60,
  };
  assert.equal(validateChapterPlan({ ...base, fallback: valid }, facts).ok, true);
  assert.equal(
    validateChapterPlan(
      {
        ...base,
        fallback: {
          ...valid,
          retries: 3,
          bossLost: { levels: 2, where: "10", tries: 0 },
          healBelowPct: 10,
        },
      },
      facts,
    ).ok,
    true,
  );
  const cases: [string, unknown][] = [
    ["retries", { ...fallback, retries: 4 }],
    ["tries", { ...fallback, bossLost: { ...fallback.bossLost, tries: 4 } }],
    ["levels", { ...fallback, bossLost: { ...fallback.bossLost, levels: 0 } }],
    ["healBelowPct", { ...fallback, healBelowPct: 9 }],
    ["healBelowPct", { ...fallback, healBelowPct: 61 }],
    ["bossLost", { ...fallback, bossLost: { ...fallback.bossLost, where: "那里" } }],
  ];
  for (const [pattern, value] of cases) {
    assert.match(firstProblems({ ...base, fallback: value }, facts), new RegExp(pattern, "u"));
  }
});

void test("segments may leave the guide order (11-11: only a warning) but must include every unfinished section", () => {
  const facts = testChapterFacts();
  const base = testChapterPlan();
  const reversed = { ...base, segments: [base.segments[1], base.segments[0]] };
  assert.doesNotMatch(firstProblems(reversed, facts), /次序/u);

  const missing = { ...base, segments: [base.segments[0]] };
  assert.match(firstProblems(missing, facts), /第二迷宫/u);
  assert.match(firstProblems(missing, facts), /没写进计划/u);

  const unknown = { ...base, segments: [testSegmentPlan("第三迷宫")] };
  assert.match(firstProblems(unknown, facts), /不是本章的一节/u);
});

void test("a done section need not be written, and writing it only warns", () => {
  const facts = testChapterFacts();
  const done: ChapterFactsData = {
    ...facts,
    sections: facts.sections.map((section) =>
      section.title === "第二迷宫" ? { ...section, done: true } : section,
    ),
  };
  const plan = testChapterPlan();
  const onlyFirst = validateChapterPlan({ ...plan, segments: [plan.segments[0]] }, done);
  assert.equal(onlyFirst.ok, true);
  const written = validateChapterPlan(plan, done);
  assert.equal(written.ok, true);
  assert.match(written.warnings.join("\n"), /事实认为第 2 段「第二迷宫」已完成/u);
  assert.match(written.warnings.join("\n"), /剧情若没走完可以照写/u);
});

void test("a section with all chests open but its last story unset is not done", () => {
  const base = testChapterFacts();
  const first = base.sections[0];
  const second = base.sections[1];
  assert.ok(first !== undefined);
  assert.ok(second !== undefined);
  const facts: ChapterFactsData = {
    ...base,
    hiddenItems: [],
    encounters: [],
    sections: [
      {
        ...first,
        done: true,
        facts: {
          ...first.facts,
          storyDone: false,
          chests: first.facts.chests.map((chest) => ({
            ...chest,
            opened: true,
          })),
          bosses: first.facts.bosses.map((boss) => ({
            ...boss,
            defeated: true,
          })),
          blueMagic: [],
          blueMagicMissing: [],
        },
      },
      second,
    ],
  };
  const plan = testChapterPlan();
  const missing = validateChapterPlan({ ...plan, segments: [secondPlan(plan)] }, facts);
  assert.match(missing.problems.join("\n"), /第 1 段「第一迷宫」没写进计划/u);
  assert.doesNotMatch(missing.problems.join("\n"), /已完成/u);
});

void test("a missing fallback and malformed skipped rows are reported in Chinese", () => {
  const facts = testChapterFacts();
  const plan = testChapterPlan();
  assert.match(firstProblems({ ...plan, fallback: null }, facts), /fallback 要写成对象/u);
  assert.match(
    firstProblems(
      {
        ...plan,
        skipped: [{ kind: "宝箱", name: "", why: "" }],
      },
      facts,
    ),
    /skipped/u,
  );
  assert.match(firstProblems("计划", facts), /JSON 对象/u);
});

void test("a replan turn-back is rejected for chapter mode", () => {
  const plan = testChapterPlan();
  const first = plan.segments[0];
  if (first === undefined) throw new Error("fixture needs a first segment");
  const withThen = (then: "replan" | "heal-and-continue") => ({
    ...plan,
    segments: plan.segments.map((segment, index) =>
      index === 0 ? { ...segment, turnBack: [{ when: "party.dead >= 2", then }] } : segment,
    ),
  });
  const bad = firstProblems(withThen("replan"));
  assert.match(bad, /整章模式执行期间不会再叫你/u);
  assert.match(bad, /回头条件只能是 heal-and-continue/u);
  assert.doesNotMatch(firstProblems(withThen("heal-and-continue")), /回头条件只能是/u);
});

void test("a story station with no cell and several exported triggers only warns with the candidates", () => {
  const knowledge = {
    mapFiles: [
      {
        id: 189,
        name: "Map_20021",
        npcs: [
          { cell: [46, 12], name: "sc_e_0004:ガラフ" },
          { cell: [16, 21], name: "sc_e_0005:ボコ" },
        ],
      },
    ],
  } as unknown as Knowledge;
  const warning = storyTriggerWarning({ to: "189", do: "story", why: "加拉夫入队" }, knowledge);
  assert.ok(warning !== null);
  assert.match(warning, /剧情触发点有 2 个/u);
  assert.match(warning, /\(46,12\)「sc_e_0004:ガラフ」/u);
  assert.match(warning, /\(16,21\)「sc_e_0005:ボコ」/u);

  const one = {
    mapFiles: [
      { id: 189, name: "Map_20021", npcs: [{ cell: [46, 12], name: "sc_e_0004:ガラフ" }] },
    ],
  } as unknown as Knowledge;
  assert.equal(storyTriggerWarning({ to: "189", do: "story" }, one), null);
});

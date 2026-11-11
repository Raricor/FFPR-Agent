import assert from "node:assert/strict";
import test from "node:test";
import type { Fields, Reply } from "../src/engine/pilot.ts";
import { patchUp } from "../src/engine/skills/battle.ts";
import { FakeItemMenu } from "./fake-item-menu.ts";
import { FakePilot } from "./fake-pilot.ts";

interface HealMember {
  name: string;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  jobName?: string;
  abilities?: readonly { name: string; id: number; mp: number }[];
}

interface Spell {
  readonly name: string;
  readonly id: number;
  readonly mp: number;
  readonly heal: number;
}

/** A field magic menu: Tab → 魔法 → 白魔法 → spell → target, with HP/MP applied on Enter. */
class FakeHealMenu {
  readonly members: HealMember[];
  readonly spells: readonly Spell[];
  stage: "closed" | "top" | "types" | "list" | "target" = "closed";
  topCursor = 0;
  abilityCursor = 0;
  targetCursor = 0;

  constructor(members: readonly HealMember[], spells: readonly Spell[]) {
    this.members = members.map((member) => ({ ...member }));
    this.spells = spells;
  }

  install(pilot: FakePilot): void {
    pilot.on("pos", { pos: { state: "Player" } });
    pilot.on("wait", { ok: true });
    pilot.on("leave", { ok: true, presses: 1 });
    pilot.on("keys", (fields) => this.press(fields));
    pilot.onQuery("sample", () => ({
      sample: { party: this.members.map((member) => ({ ...member })) },
    }));
    pilot.onQuery("menu", () => ({ menu: this.menu() }));
    pilot.onQuery("items", { items: { normal: [], important: [] } });
  }

  private caster(): HealMember {
    return (
      this.members.find((member) => member.abilities !== undefined) ??
      this.members[0] ?? { name: "", hp: 0, maxHp: 0, mp: 0, maxMp: 0 }
    );
  }

  private menu(): Reply {
    const top = {
      open: true,
      commands: [{ id: "Magic", name: "魔法" }],
      cursor: this.topCursor,
    };
    if (this.stage === "top") return top;
    if (this.stage === "types") {
      return {
        ...top,
        state: "Magic",
        magic: {
          character: this.caster().name,
          commands: [{ name: "白魔法", enabled: true }],
          commandCursor: 0,
        },
      };
    }
    if (this.stage === "list" || this.stage === "target") {
      const magic: Record<string, unknown> = {
        character: this.caster().name,
        state: "MagicList",
        abilities: this.spells.map((spell) => ({
          name: spell.name,
          id: spell.id,
          mp: spell.mp,
        })),
        contentIds: this.spells.map((spell) => spell.id),
        abilityCursor: this.abilityCursor,
      };
      if (this.stage === "target") {
        magic.targets = this.members.map((member) => ({ name: member.name }));
        magic.targetMode = "Single";
        magic.targetCursor = this.targetCursor;
      }
      return { ...top, state: "Magic", magic };
    }
    return { open: false };
  }

  private press(fields: Fields): Reply {
    const keys = Array.isArray(fields.keys)
      ? fields.keys.filter((key): key is string => typeof key === "string")
      : [];
    for (const key of keys) {
      if (key === "Tab") this.stage = "top";
      else if (this.stage === "top" && key === "Enter") this.stage = "types";
      else if (this.stage === "types" && key === "Enter") this.stage = "list";
      else if (this.stage === "list" && key === "Enter") this.stage = "target";
      else if (this.stage === "list" && key === "Down") {
        this.abilityCursor = Math.min(this.spells.length - 1, this.abilityCursor + 1);
      } else if (this.stage === "list" && key === "Up") {
        this.abilityCursor = Math.max(0, this.abilityCursor - 1);
      } else if (this.stage === "target" && key === "Enter") this.cast();
    }
    return { ok: true };
  }

  private cast(): void {
    const spell = this.spells[this.abilityCursor];
    if (spell !== undefined) {
      const caster = this.caster();
      caster.mp = Math.max(0, caster.mp - spell.mp);
      const target = this.members[this.targetCursor] ?? this.members[0];
      if (target !== undefined) target.hp = Math.min(target.maxHp, target.hp + spell.heal);
    }
    this.stage = "closed";
  }
}

void test("after a battle one member at 60% is healed back over 70%", async () => {
  const pilot = new FakePilot();
  const menu = new FakeHealMenu(
    [
      { name: "巴兹", hp: 60, maxHp: 100, mp: 10, maxMp: 10 },
      {
        name: "蕾娜",
        hp: 100,
        maxHp: 100,
        mp: 50,
        maxMp: 50,
        jobName: "白魔法师",
        abilities: [{ name: "治疗", id: 1, mp: 4 }],
      },
    ],
    [{ name: "治疗", id: 1, mp: 4, heal: 50 }],
  );
  menu.install(pilot);
  const done = await patchUp(pilot);
  assert.equal(done.length, 1);
  assert.match(done[0] ?? "", /蕾娜 用了「治疗」:巴兹 HP 60→100/);
  assert.equal(menu.members[0]?.hp, 100);
  assert.equal(menu.members[1]?.mp, 46);
});

void test("a large gap chooses 救疗 instead of a cheaper but too-small 治疗", async () => {
  const pilot = new FakePilot();
  const menu = new FakeHealMenu(
    [
      { name: "巴兹", hp: 30, maxHp: 120, mp: 10, maxMp: 10 },
      {
        name: "蕾娜",
        hp: 100,
        maxHp: 100,
        mp: 60,
        maxMp: 60,
        jobName: "白魔法师",
        abilities: [
          { name: "治疗", id: 1, mp: 4 },
          { name: "救疗", id: 2, mp: 8 },
        ],
      },
    ],
    [
      { name: "治疗", id: 1, mp: 4, heal: 48 },
      { name: "救疗", id: 2, mp: 8, heal: 96 },
    ],
  );
  menu.install(pilot);
  const done = await patchUp(pilot);
  assert.equal(done.length, 1);
  assert.match(done[0] ?? "", /用了「救疗」/);
});

void test("with only the MP reserve left no spell is cast; a 35% member gets a potion", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [{ name: "恢复药", count: 2 }],
    members: [
      {
        name: "蕾娜",
        hp: 35,
        maxHp: 100,
        mp: 3,
        maxMp: 10,
        jobName: "白魔法师",
      },
    ],
    target: "蕾娜",
  });
  // MP 3 of 10 is the 30% reserve, so even 治疗's 4 MP is not allowed.
  menu.install(pilot);
  const done = await patchUp(pilot);
  assert.equal(done.length, 1);
  assert.match(done[0] ?? "", /恢复药/);
});

void test("with only the reserve left a 45% member is left alone (items wait for 40%)", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [{ name: "恢复药", count: 2 }],
    members: [
      {
        name: "蕾娜",
        hp: 45,
        maxHp: 100,
        mp: 3,
        maxMp: 10,
        jobName: "白魔法师",
      },
    ],
    target: "蕾娜",
  });
  menu.install(pilot);
  assert.deepEqual(await patchUp(pilot), []);
  assert.deepEqual(pilot.keys(), []);
});

void test("at a save point a tent is used when magic cannot fill the party", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [{ name: "帐篷", count: 1 }],
    members: [
      { name: "巴兹", hp: 60, maxHp: 100, mp: 0, maxMp: 20 },
      { name: "蕾娜", hp: 50, maxHp: 100, mp: 0, maxMp: 30 },
    ],
    target: "巴兹",
    targetMode: "All",
  });
  menu.install(pilot);
  const done = await patchUp(pilot, () => undefined, 8, undefined, {
    hpTarget: 95,
    mpReservePercent: 0,
    allowTent: true,
  });
  assert.equal(done.length, 1);
  assert.match(done[0] ?? "", /帐篷/);
});

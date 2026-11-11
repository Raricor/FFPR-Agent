/**
 * Task 141: the real plan ports classify a boss cell from the bridge's Event list and see
 * whether a confirm actually started the fight. No bridge or laptop is involved.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Game } from "../src/engine/game.ts";
import { gamePlanPorts } from "../src/engine/plan/game-ports.ts";
import { FakePilot } from "./fake-pilot.ts";

function portsFor(pilot: FakePilot) {
  return gamePlanPorts({} as Game, pilot);
}

void test("an event named sc_e_/ev_e_ is a story trigger, a boss entity is not", async () => {
  const boss = new FakePilot().on("entities", {
    entities: {
      entities: [
        { cell: [14, 11], name: "巨翼猛禽" },
        { cell: [13, 11], name: "sc_e_0016:コリジョンA" },
      ],
    },
  });
  assert.equal(await portsFor(boss).bossTarget([14, 11], "巨翼猛禽"), "object");

  const trigger = new FakePilot().on("entities", {
    entities: { entities: [{ cell: [14, 11], name: "ev_e_0016" }] },
  });
  assert.equal(await portsFor(trigger).bossTarget([14, 11], "巨翼猛禽"), "trigger");

  const sceneBoss = new FakePilot().on("entities", {
    entities: { entities: [{ cell: [14, 11], name: "sc_e_0016:巨翼猛禽" }] },
  });
  assert.equal(await portsFor(sceneBoss).bossTarget([14, 11], "巨翼猛禽"), "object");
});

void test("a battle is active when the sample names enemies or the boss flag", async () => {
  const active = new FakePilot().onQuery("sample", {
    sample: { battle: { active: true, enemies: [] } },
  });
  assert.equal(await portsFor(active).battleActive(), true);

  const enemies = new FakePilot().onQuery("sample", {
    sample: { battle: { active: false, enemies: [{ name: "巨翼猛禽" }] } },
  });
  assert.equal(await portsFor(enemies).battleActive(), true);

  const idle = new FakePilot().onQuery("sample", { sample: { battle: { active: false } } });
  assert.equal(await portsFor(idle).battleActive(), false);
});

/**
 * A scripted field job menu for skill tests, shaped like the bridge's `menu.job`
 * (GameState.Menus.cs JobMenu): the main menu's Job command, the member list, the job grid and
 * the confirm popup, plus enough of the equipment menu for the strongest-equipment pass that
 * follows a job change. `FakePilot` answers the pilot's keys and queries from this little state
 * machine, so a test presses through the real flow.
 */

import type { Fields, Reply } from "../src/engine/pilot.ts";
import type { FakePilot } from "./fake-pilot.ts";

export interface FakeJob {
  readonly name: string;
  readonly id?: number;
  readonly enabled?: boolean;
}

export interface FakeJobMember {
  readonly name: string;
  jobName: string;
  readonly jobLevel?: number;
  readonly hp?: number;
  readonly maxHp?: number;
  readonly mp?: number;
}

export interface FakeJobMenuOptions {
  readonly members: readonly FakeJobMember[];
  readonly jobs: readonly FakeJob[];
  readonly columns?: number;
}

type Stage = "closed" | "top" | "party" | "job" | "popup" | "equipParty" | "equipCommand";

const COMMANDS = [
  { id: "Item", name: "道具" },
  { id: "Magic", name: "魔法" },
  { id: "Job", name: "职业" },
  { id: "Equipment", name: "装备" },
];

export class FakeJobMenu {
  readonly members: FakeJobMember[];
  readonly jobs: FakeJob[];
  readonly columns: number;
  stage: Stage = "closed";
  topCursor = 0;
  partyCursor = 0;
  gridRow = 0;
  gridCol = 0;
  popupCursor = 0;
  readonly equipCursor = 0;
  equipCommandCursor = 0;

  constructor(options: FakeJobMenuOptions) {
    this.members = options.members.map((member) => ({ ...member }));
    this.jobs = options.jobs.map((job) => ({ ...job }));
    this.columns = options.columns ?? 4;
  }

  install(pilot: FakePilot): void {
    pilot.on("pos", { pos: { state: "Player" } });
    pilot.on("wait", { ok: true });
    pilot.on("leave", { ok: true, presses: 1 });
    pilot.on("keys", (fields) => this.press(fields));
    pilot.onQuery("menu", () => ({ menu: this.menu() }));
    pilot.onQuery("sample", () => ({ sample: { party: this.party() } }));
  }

  private party(): Reply[] {
    return this.members.map((member) => ({
      name: member.name,
      jobName: member.jobName,
      jobLevel: member.jobLevel ?? 1,
      hp: member.hp ?? 100,
      maxHp: member.maxHp ?? 100,
      mp: member.mp ?? 10,
    }));
  }

  private press(fields: Fields): Reply {
    const raw = fields.keys;
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : [];
    for (const spec of keys) {
      const [key = "", count] = spec.split("*");
      const times = count === undefined ? 1 : Number(count);
      for (let i = 0; i < times; i++) this.step(key);
    }
    return { ok: true };
  }

  private step(key: string): void {
    if (key === "Tab") {
      this.stage = this.stage === "closed" ? "top" : "closed";
      return;
    }
    if (key === "Backspace") {
      this.stage =
        this.stage === "popup"
          ? "job"
          : this.stage === "job"
            ? "party"
            : this.stage === "equipCommand"
              ? "equipParty"
              : this.stage === "equipParty"
                ? "top"
                : "closed";
      return;
    }
    if (this.stage === "top") {
      this.moveTop(key);
    } else if (this.stage === "party") {
      if (key === "Down")
        this.partyCursor = Math.min(this.members.length - 1, this.partyCursor + 1);
      if (key === "Up") this.partyCursor = Math.max(0, this.partyCursor - 1);
      if (key === "Enter") {
        this.gridRow = 0;
        this.gridCol = 0;
        this.stage = "job";
      }
    } else if (this.stage === "job") {
      this.moveGrid(key);
      if (key === "Enter") {
        const cell = this.jobs[this.gridRow * this.columns + this.gridCol];
        if (cell !== undefined && cell.enabled !== false) {
          this.popupCursor = 0;
          this.stage = "popup";
        }
      }
    } else if (this.stage === "popup") {
      if (key === "Down") this.popupCursor = Math.min(1, this.popupCursor + 1);
      if (key === "Up") this.popupCursor = Math.max(0, this.popupCursor - 1);
      if (key === "Enter") {
        if (this.popupCursor === 0) {
          const cell = this.jobs[this.gridRow * this.columns + this.gridCol];
          const member = this.members[this.partyCursor];
          if (cell !== undefined && member !== undefined) member.jobName = cell.name;
          this.stage = "closed";
        } else {
          this.stage = "job";
        }
      }
    } else if (this.stage === "equipParty") {
      if (key === "Down")
        this.partyCursor = Math.min(this.members.length - 1, this.partyCursor + 1);
      if (key === "Up") this.partyCursor = Math.max(0, this.partyCursor - 1);
      if (key === "Enter") {
        this.equipCommandCursor = 0;
        this.stage = "equipCommand";
      }
    } else if (this.stage === "equipCommand") {
      if (key === "Down") this.equipCommandCursor = Math.min(1, this.equipCommandCursor + 1);
      if (key === "Up") this.equipCommandCursor = Math.max(0, this.equipCommandCursor - 1);
    }
  }

  private moveTop(key: string): void {
    if (key === "Down") this.topCursor = Math.min(COMMANDS.length - 1, this.topCursor + 1);
    if (key === "Up") this.topCursor = Math.max(0, this.topCursor - 1);
    if (key !== "Enter") return;
    if (this.topCursor === 2) {
      this.stage = "party";
      this.partyCursor = 0;
    } else if (this.topCursor === 3) {
      this.stage = "equipParty";
      this.partyCursor = 0;
    }
  }

  private moveGrid(key: string): void {
    const last = this.jobs.length - 1;
    const index = this.gridRow * this.columns + this.gridCol;
    let next = index;
    if (key === "Down") next = Math.min(last, index + this.columns);
    if (key === "Up") next = Math.max(0, index - this.columns);
    if (key === "Right" && index % this.columns < this.columns - 1)
      next = Math.min(last, index + 1);
    if (key === "Left" && index % this.columns > 0) next = Math.max(0, index - 1);
    this.gridRow = Math.floor(next / this.columns);
    this.gridCol = next % this.columns;
  }

  private menu(): Reply {
    const base = {
      open: true,
      state: this.stage === "equipParty" || this.stage === "equipCommand" ? "Equipment" : "Job",
      commands: COMMANDS,
      cursor: this.topCursor,
    };
    switch (this.stage) {
      case "closed":
        return { open: false };
      case "top":
        return base;
      case "party":
        return { ...base, partyCursor: this.partyCursor };
      case "job":
      case "popup":
        return { ...base, partyCursor: this.partyCursor, job: this.job() };
      case "equipParty":
        return {
          ...base,
          partyCursor: this.partyCursor,
          equipment: { state: "Select", commandCursor: 0, slots: [] },
        };
      case "equipCommand":
        return {
          ...base,
          partyCursor: this.partyCursor,
          equipment: {
            state: "Command",
            commandCursor: this.equipCommandCursor,
            slots: [],
          },
        };
    }
  }

  private job(): Reply {
    const member = this.members[this.partyCursor];
    return {
      state: this.stage === "popup" ? "ConfirmPopup" : "SelectJob",
      character: member?.name,
      targetCursor: this.partyCursor,
      gridCursor: { row: this.gridRow, col: this.gridCol },
      maxColumnCount: this.columns,
      maxRowCount: Math.ceil(this.jobs.length / this.columns),
      jobs: this.jobs.map((job, index) => ({
        index,
        row: Math.floor(index / this.columns),
        col: index % this.columns,
        id: job.id,
        name: job.name,
        enabled: job.enabled !== false,
        active: true,
      })),
      popup:
        this.stage === "popup"
          ? {
              open: true,
              job: this.jobs[this.gridRow * this.columns + this.gridCol]?.name,
              cursor: this.popupCursor,
              commands: [
                { name: "是", enabled: true },
                { name: "否", enabled: true },
              ],
            }
          : { open: false },
    };
  }
}

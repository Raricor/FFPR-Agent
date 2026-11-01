/**
 * Plain-language game state for the six-game overview page (task 24). The bridge's scene state
 * is an English enum; the page's words are computed here so the browser only lays them out.
 */

import { num, record, records, text, truthy, type Json } from "./values.ts";

/** Bridge `scene.state` → one Chinese phrase; an unknown state is shown as-is. */
export const SCENE_STATUS: Readonly<Record<string, string>> = {
  Player: "在地图上",
  FieldReady: "在地图上",
  Battle: "战斗中",
  Menu: "菜单",
  Message: "对话中",
  Shop: "商店",
  Event: "剧情",
  ChangeMap: "切换地图",
  Gimmick: "机关",
  Transport: "乘交通工具",
  FieldHelp: "操作提示",
  GotoTitle: "标题画面",
  Init: "标题画面",
};

export interface PartyMemberView {
  readonly name: string;
  readonly hp: number;
  readonly maxHp: number;
}

export function sceneStatus(sample: Json | null): string {
  const scene = record(record(sample).scene);
  const state = text(scene.state) ?? "";
  // 10-29: on the title screen the bridge reports scene "Title" with a null state.
  if (state === "") return text(scene.name) === "Title" ? "标题画面" : "";
  return SCENE_STATUS[state] ?? state;
}

/** The same "area, then location" naming the strategy page uses. */
export function placeName(sample: Json | null): string {
  const user = record(record(sample).user);
  return [user.areaText, user.locationText]
    .map((value) => text(value))
    .filter((value): value is string => value !== undefined && value !== "")
    .join(" ");
}

/** Battle is either the scene state or the sample's battle flag, as the panel already decides. */
export function inBattle(sample: Json | null): boolean {
  const source = record(sample);
  return text(record(source.scene).state) === "Battle" || truthy(record(source.battle).active);
}

/** The party's first five members with HP, for one card's rows. */
export function partyMembers(sample: Json | null): PartyMemberView[] {
  return records(record(sample).party)
    .slice(0, 5)
    .flatMap((member) => {
      const name = text(member.name);
      if (name === undefined || name === "") return [];
      return [
        {
          name,
          hp: num(member.hp) ?? 0,
          maxHp: num(member.maxHp) ?? 0,
        },
      ];
    });
}

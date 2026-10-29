/**
 * FF2's profile (task 20). The Steam list is the public page's Simplified Chinese entries. The
 * missables come from the guides in .deps/knowledge/ff2 (Seeking Tech's missable chests and its
 * 12 missable enemies, RPG Site's walkthrough), matched against the game's own area ids and box
 * counts on the 10-28 title-screen dump (bridge 0.10.0). FF2 has no hidden items.
 */

import type { GameProfile } from "./types.ts";

export const FF2_PROFILE: GameProfile = {
  key: "ff2",
  achievements: [
    {
      api: "all_achievement",
      name: "ＦＦ２大师！",
      description: "获得了所有成就。",
      hidden: false,
    },
    {
      api: "scenario_1",
      name: "口令是“野玫瑰”",
      description: "开始了对帕拉美奇亚帝国的反抗。",
      hidden: true,
    },
    {
      api: "scenario_2",
      name: "帝国军的猛攻",
      description: "多个城镇遭到了帝国大战舰的破坏。",
      hidden: true,
    },
    {
      api: "scenario_3",
      name: "拉开反击的序幕",
      description: "击破了帝国的大战舰。",
      hidden: true,
    },
    {
      api: "scenario_4",
      name: "与海贼结盟",
      description: "遇到了海贼蕾拉，得到了船。",
      hidden: true,
    },
    {
      api: "scenario_5",
      name: "反抗军的胜利",
      description: "打倒了司令官高特斯，夺回了菲因城。",
      hidden: true,
    },
    {
      api: "scenario_6",
      name: "最后的龙骑士",
      description: "龙骑士理查德成为了同伴。",
      hidden: true,
    },
    {
      api: "scenario_7",
      name: "飞龙的诞生",
      description: "飞龙之卵中诞生了最后的飞龙。",
      hidden: true,
    },
    {
      api: "scenario_8",
      name: "新生帕拉美奇亚帝国",
      description: "暗黑骑士即位成为了新的皇帝。",
      hidden: true,
    },
    {
      api: "scenario_9",
      name: "久别重逢与并肩作战",
      description: "曾经的同伴加入了反抗军。",
      hidden: true,
    },
    {
      api: "scenario_10",
      name: "漫长战斗的终结",
      description: "打倒了皇帝，为世界取回了和平。",
      hidden: true,
    },
    {
      api: "scenario_11",
      name: "最棒的宝剑",
      description: "获得了王者之剑。",
      hidden: false,
    },
    {
      api: "word_master",
      name: "追忆的旅程",
      description: "学会了所有口令。",
      hidden: false,
    },
    {
      api: "equip_skill_master",
      name: "战斗高手",
      description: "某一装备的熟练度达到了16。",
      hidden: false,
    },
    {
      api: "magic_skill_master",
      name: "魔法高手",
      description: "某一魔法的熟练度达到了16。",
      hidden: false,
    },
    {
      api: "monster_hunt_100",
      name: "见习战士",
      description: "打倒了100只怪物。",
      hidden: false,
    },
    {
      api: "monster_hunt_300",
      name: "熟练战士",
      description: "打倒了300只怪物。",
      hidden: false,
    },
    {
      api: "monster_hunt_500",
      name: "传说战士",
      description: "打倒了500只怪物。",
      hidden: false,
    },
    {
      api: "picture_book_12",
      name: "魔物图鉴·基础知识篇",
      description: "怪物图鉴的完成率达到了10%。",
      hidden: false,
    },
    {
      api: "picture_book_64",
      name: "魔物图鉴·战斗解析篇",
      description: "怪物图鉴的完成率达到了50%。",
      hidden: false,
    },
    {
      api: "picture_book_128",
      name: "魔物图鉴·完全攻略篇",
      description: "怪物图鉴的完成率达到了100%。",
      hidden: false,
    },
    {
      api: "total_gil_10000",
      name: "中产",
      description: "累计获得了10000金币。",
      hidden: false,
    },
    {
      api: "total_gil_50000",
      name: "富人",
      description: "累计获得了50000金币。",
      hidden: false,
    },
    {
      api: "total_gil_100000",
      name: "大富豪",
      description: "累计获得了100000金币。",
      hidden: false,
    },
    {
      api: "treasure_box_23",
      name: "新手宝物猎人",
      description: "宝箱的回收率达到了10%。",
      hidden: false,
    },
    {
      api: "treasure_box_117",
      name: "老练宝物猎人",
      description: "宝箱的回收率达到了50%。",
      hidden: false,
    },
    {
      api: "treasure_box_234",
      name: "传奇宝物猎人",
      description: "宝箱的回收率达到了100%。",
      hidden: false,
    },
    {
      api: "area_visit",
      name: "探求的冒险者",
      description: "造访了所有地方。",
      hidden: false,
    },
  ],
  /**
   * `past` is the first story achievement certainly after the deadline. The wyvern hatches
   * (飞龙的诞生) only after the Mysidian Tower; Leon joins (久别重逢与并肩作战) only after the
   * Palamecia boss and the scenes outside.
   */
  oneTimePlaces: [
    // Altair is destroyed when the Mysidian Tower is done.
    { area: 2, until: "完成密西迪亚塔前", past: "scenario_7" }, // 阿尔提亚镇
    { area: 24, until: "用太阳之炎炸掉大战舰前", past: "scenario_3" }, // 大战舰
    { area: 26, until: "离开利维亚桑前", past: "scenario_7" }, // 利维亚桑
    // Only the 8 in Paul's secret room of the town's 11: no count of lost boxes, just the warning.
    { area: 9, until: "孵出飞龙后、完成龙卷前，拿保罗家密室里的 8 个" }, // 菲因镇
    // Seeking Tech says 8; the game has 7 boxes here.
    { area: 28, until: "离开龙卷前", past: "scenario_8" }, // 龙卷
    // Seeking Tech says 8; RPG Site and the game say 17.
    { area: 29, until: "打倒帕拉美奇亚城的首领前", past: "scenario_9" }, // 帕拉美奇亚城
  ],
  /** Seeking Tech's 12, whose numbers match the game's; 22 髑髅 is its Skull. */
  bestiaryMissables: [
    {
      numbers: [11, 31, 40, 42, 45, 52, 53],
      areas: [0, 24, 26],
      until: "完成密西迪亚塔前(之后世界地图上的怪会换)",
      past: "scenario_7",
    },
    {
      numbers: [22, 71, 91, 94, 106],
      areas: [28, 29],
      until: "打倒帕拉美奇亚城的首领前",
      past: "scenario_9",
    },
  ],
  areaGoals: [],
  // FF2's monster data names no element at all (10-28 dump); unknown ids show as numbers.
  elements: {},
};

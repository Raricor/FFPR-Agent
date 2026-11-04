/**
 * FF3's profile (task 20). The Steam list is the public page's Simplified Chinese entries. The
 * missables come from the guides in .deps/knowledge/ff3 (Seeking Tech's missable chests and
 * hidden items, RPG Site's walkthrough), matched against the game's own area ids and box counts
 * on the 10-28 title-screen dump (bridge 0.10.0).
 */

import type { GameProfile } from "./types.ts";

export const FF3_PROFILE: GameProfile = {
  key: "ff3",
  achievements: [
    {
      api: "all_achievement",
      name: "ＦＦ３大师！",
      description: "获得了所有成就。",
      hidden: false,
    },
    {
      api: "scenario_1",
      name: "风之希望",
      description: "领取了风之水晶的力量。",
      hidden: true,
    },
    {
      api: "scenario_2",
      name: "击碎巨岩",
      description: "击碎了巨岩，开辟了道路。",
      hidden: true,
    },
    {
      api: "scenario_3",
      name: "守卫的使命",
      description: "阻止了欧文塔的毁坏。",
      hidden: true,
    },
    {
      api: "scenario_4",
      name: "火之希望",
      description: "领取了火之水晶的力量。",
      hidden: true,
    },
    {
      api: "scenario_5",
      name: "水之希望",
      description: "领取了水之水晶的力量。",
      hidden: true,
    },
    {
      api: "scenario_6",
      name: "萨罗尼亚的和平",
      description: "打倒了迦楼罗，拯救了萨罗尼亚。",
      hidden: true,
    },
    {
      api: "scenario_7",
      name: "从梦之世界中苏醒",
      description: "使用诺亚之琴让乌内苏醒了过来。",
      hidden: true,
    },
    {
      api: "scenario_8",
      name: "土之希望",
      description: "领取了土之水晶的力量。",
      hidden: true,
    },
    {
      api: "scenario_9",
      name: "前往暗之世界",
      description: "打倒了赞德，前往了暗之世界。",
      hidden: true,
    },
    {
      api: "scenario_10",
      name: "希望之光迹",
      description: "打倒了暗黑之云，为世界夺回了和平。",
      hidden: true,
    },
    {
      api: "get_weapon",
      name: "禁忌武器",
      description: "获得了封印在优雷卡的所有武器。",
      hidden: false,
    },
    {
      api: "all_summon",
      name: "召唤大师",
      description: "学会了所有召唤魔法。",
      hidden: false,
    },
    {
      api: "job_master_10",
      name: "职业新人",
      description: "某职业的熟练度达到了10。",
      hidden: false,
    },
    {
      api: "job_master_50",
      name: "职业挑战者",
      description: "某职业的熟练度达到了50。",
      hidden: false,
    },
    {
      api: "job_master_99",
      name: "职业大师",
      description: "某职业的熟练度达到了99。",
      hidden: false,
    },
    {
      api: "level_all_50",
      name: "身经百战的强者们",
      description: "全员达到了50级。",
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
      api: "picture_book_22",
      name: "魔物图鉴·基础知识篇",
      description: "怪物图鉴的完成率达到了10%。",
      hidden: false,
    },
    {
      api: "picture_book_112",
      name: "魔物图鉴·战斗解析篇",
      description: "怪物图鉴的完成率达到了50%。",
      hidden: false,
    },
    {
      api: "picture_book_225",
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
      api: "total_gil_100000",
      name: "富人",
      description: "累计获得了100000金币。",
      hidden: false,
    },
    {
      api: "total_gil_500000",
      name: "大富豪",
      description: "累计获得了500000金币。",
      hidden: false,
    },
    {
      api: "treasure_box_37",
      name: "新手宝物猎人",
      description: "宝箱的回收率达到了10%。",
      hidden: false,
    },
    {
      api: "treasure_box_184",
      name: "老练宝物猎人",
      description: "宝箱的回收率达到了50%。",
      hidden: false,
    },
    {
      api: "treasure_box_367",
      name: "传奇宝物猎人",
      description: "宝箱的回收率达到了100%。",
      hidden: false,
    },
    {
      api: "get_hidden_item",
      name: "道具猎人",
      description: "获得了所有隐藏道具。",
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
   * `past` is the first story achievement certainly after the deadline, in RPG Site's chapter
   * order: Hein (8) and the Wrecked Ship (10) before 水之希望, Doga's dungeon (17) before 前往暗之世界.
   */
  oneTimePlaces: [
    // The hidden item: the guard on the left wall, as soon as you are brought in.
    { area: 25, until: "打倒海因前(被抓进城时先和左边城墙上的守卫说话)", past: "scenario_5" }, // 海因城
    { area: 27, until: "完成水之洞窟前", past: "scenario_5" }, // 遇难船
    // Only the 2 hidden items of the town's 13 boxes: no count of lost boxes, just the warning.
    { area: 36, until: "阿鲁斯王子同行时，找两个人拿 2 个隐藏道具" }, // 萨罗尼亚 西南
    { area: 52, until: "打倒首领、传送出去前", past: "scenario_9" }, // 多加洞窟
  ],
  /**
   * RPG Site's notes where the game's habitats agree. Left out: the outer sea (Anet, Mermaid,
   * Seahorse, Sea Serpent, Sea Dragon), which RPG Site says the Pixel Remaster also has on rivers
   * by canoe (and 74 海蟒 lives in 海底洞窟 too); and Doga's dungeon (Nemesis, Cyclops, Peryton,
   * Humbaba, Ogre), which the game lists elsewhere (水晶塔, 古代遗迹 ...).
   */
  bestiaryMissables: [
    {
      numbers: [198],
      areas: [0],
      until: "涅普特神殿的事办完前：出维京人据点后坐企业号往北，遇到一次就逃",
      past: "scenario_3",
    },
    // Killer Fish, Hermit, Sea Elemental, Tangie, Sahagin of the floating continent's inner sea.
    {
      numbers: [31, 32, 33, 34, 35],
      areas: [0],
      until: "在萨罗尼亚上空被击落前(之后没有能下水的船)",
      past: "scenario_6",
    },
    // Pharoah, Lemur, Lamia, Demon, Dullahan.
    { numbers: [66, 67, 68, 69, 70], areas: [25], until: "打倒海因前", past: "scenario_5" },
  ],
  areaGoals: [],
  // The weak-row sentences name 1-3 and 5-8 (10-28 dump); 4, 9 and 11-14 stay numbers.
  elements: {},
};

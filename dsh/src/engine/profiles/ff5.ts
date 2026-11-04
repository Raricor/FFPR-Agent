/**
 * FF5's profile: the 39 Steam achievements, the 10-27 live-dump area ids for one-time chests,
 * the bestiary missables from the Steam missables guide (.deps/knowledge/ff5, read 10-27), and
 * the sealed weapons' area goal (task 20, moved out of achievements.ts and bestiary.ts).
 */

import type { GameProfile } from "./types.ts";

export const FF5_PROFILE: GameProfile = {
  key: "ff5",
  achievements: [
    {
      api: "all_achievement",
      name: "ＦＦ５大师！",
      description: "获得了所有成就。",
      hidden: false,
    },
    {
      api: "scenario_1",
      name: "旅行的决心",
      description: "救助了蕾娜和加拉夫并一同踏上了旅程。",
      hidden: true,
    },
    {
      api: "scenario_2",
      name: "风之心“探求”",
      description: "领取了风之水晶的力量。",
      hidden: true,
    },
    {
      api: "scenario_3",
      name: "水之心“怜悯”",
      description: "领取了水之水晶的力量。",
      hidden: true,
    },
    {
      api: "scenario_4",
      name: "火之心“勇气”",
      description: "领取了火之水晶的力量。",
      hidden: true,
    },
    {
      api: "scenario_5",
      name: "梦幻黑陆行鸟",
      description: "发现了黑陆行鸟。",
      hidden: true,
    },
    {
      api: "scenario_6",
      name: "古代文明的遗物",
      description: "获得了飞空艇。",
      hidden: true,
    },
    {
      api: "scenario_7",
      name: "土之心“希望”",
      description: "领取了土之水晶的力量。",
      hidden: true,
    },
    {
      api: "scenario_8",
      name: "前往另一个世界",
      description: "来到了加拉夫的世界。",
      hidden: true,
    },
    {
      api: "scenario_9",
      name: "被托付的心愿",
      description: "获得了潜水艇。",
      hidden: true,
    },
    {
      api: "scenario_10",
      name: "被继承之心",
      description: "可露儿继承了加拉夫的力量。",
      hidden: true,
    },
    {
      api: "scenario_11",
      name: "回到原来的世界",
      description: "打倒了艾克斯迪司，回到了原来的世界。",
      hidden: true,
    },
    {
      api: "scenario_12",
      name: "四颗心",
      description: "打倒了新生艾克斯迪司，为世界夺回了和平。",
      hidden: true,
    },
    {
      api: "get_sealed_weapon",
      name: "传说中的武器",
      description: "获得了所有12件被封印的武器。",
      hidden: false,
    },
    {
      api: "get_hidden_job",
      name: "模仿师格格",
      description: "获得了隐藏职业。",
      hidden: false,
    },
    {
      api: "ultimate_omega",
      name: "最强兵器",
      description: "打倒了欧米茄。",
      hidden: false,
    },
    {
      api: "ultimate_dragon",
      name: "最强之龙",
      description: "打倒了神龙。",
      hidden: false,
    },
    {
      api: "piano_master",
      name: "钢琴大师",
      description: "掌握了钢琴。",
      hidden: false,
    },
    {
      api: "magic_learning_10",
      name: "学习·初级",
      description: "通过学习学会了10种青魔法。",
      hidden: false,
    },
    {
      api: "magic_learning_30",
      name: "学习·高级",
      description: "通过学习学会了所有青魔法。",
      hidden: false,
    },
    {
      api: "job_master_1",
      name: "职业新人",
      description: "掌握了某种职业。",
      hidden: false,
    },
    {
      api: "job_master_5",
      name: "职业挑战者",
      description: "掌握了5种职业。",
      hidden: false,
    },
    {
      api: "job_master_15",
      name: "职业高手",
      description: "掌握了15种职业。",
      hidden: false,
    },
    {
      api: "job_master_22",
      name: "职业大师",
      description: "掌握了所有职业。",
      hidden: false,
    },
    {
      api: "level_all_50",
      name: "身经百战的强者们",
      description: "全员达到了50级。",
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
      api: "monster_hunt_100",
      name: "见习战士",
      description: "打倒了100只怪物。",
      hidden: false,
    },
    {
      api: "monster_hunt_1000",
      name: "熟练战士",
      description: "打倒了1000只怪物。",
      hidden: false,
    },
    {
      api: "monster_hunt_2000",
      name: "传说战士",
      description: "打倒了2000只怪物。",
      hidden: false,
    },
    {
      api: "picture_book_30",
      name: "魔物图鉴·基础知识篇",
      description: "怪物图鉴的完成率达到了10%。",
      hidden: false,
    },
    {
      api: "picture_book_151",
      name: "魔物图鉴·战斗解析篇",
      description: "怪物图鉴的完成率达到了50%。",
      hidden: false,
    },
    {
      api: "picture_book_302",
      name: "魔物图鉴·完全攻略篇",
      description: "怪物图鉴的完成率达到了100%。",
      hidden: false,
    },
    {
      api: "treasure_box_21",
      name: "新手宝物猎人",
      description: "宝箱的回收率达到了10%。",
      hidden: false,
    },
    {
      api: "treasure_box_112",
      name: "老练宝物猎人",
      description: "宝箱的回收率达到了50%。",
      hidden: false,
    },
    {
      api: "treasure_box_225",
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
   * Places whose boxes are lost for good after a story point, from the Steam missables guide
   * (.deps/knowledge/ff5, read 10-27); area ids from the 10-27 live dump. `past` is the nearest
   * story flag we can read that the deadline is surely behind, so a set flag never misjudges a
   * box that can still be taken; between the deadline and that flag the row still only warns.
   */
  oneTimePlaces: [
    { area: 71, until: "打倒塔顶首领前", past: "scenario_3" }, // 沃尔斯塔: the water crystal is at the top
    { area: 24, until: "火力船首领后的 10 分钟逃脱里", past: "scenario_5" }, // 卡纳克城
    { area: 34, until: "打倒首领前", past: "scenario_7" }, // 隆卡遗迹: the earth crystal
    { area: 57, until: "打倒首领前", past: "scenario_10" }, // 屏障之塔
    { area: 79, until: "离开森林前", past: "scenario_11" }, // 慕亚大森林
    { area: 86, until: "离开森林前", past: "scenario_11" }, // 慕亚大森林, the changed forest
    { area: 40, until: "打倒十三层的艾克斯迪司前", past: "scenario_11" }, // 艾克斯迪司城
    { area: 28, until: "打倒金字塔首领前" }, // 古代图书馆
    { area: 67, until: "打倒首领前" }, // 两歧塔 黑塔
    { area: 68, until: "打倒首领前" }, // 两歧塔 白塔
  ],
  /**
   * 10-27: area ids are reused across worlds — 71 is Walse Tower and later the sunken Walse
   * Tower — so these rules are only trusted when every recorded area is one the guide names.
   * A set `past` flag whose areas include somewhere else means the game disagrees with the
   * guide: leave the monster unmarked rather than call it lost.
   */
  bestiaryMissables: [
    { numbers: [191, 192], areas: [11], until: "离开托纳运河前", past: "scenario_3" },
    {
      numbers: [233],
      areas: [15],
      until: "北山首领战里让玛基莎把它召唤出来",
      past: "scenario_3",
    },
    { numbers: [28, 29], areas: [71], until: "打倒沃尔斯塔顶的首领前", past: "scenario_3" },
    {
      numbers: [27],
      areas: [66, 71],
      until: "打倒两歧塔首领前(沃尔斯塔之后还有一次机会)",
    },
    {
      numbers: [41, 42, 43, 44, 238],
      areas: [24],
      until: "火力船首领后的 10 分钟逃脱里",
      past: "scenario_5",
    },
    {
      numbers: [62, 64, 65, 66, 67, 68, 69],
      areas: [34],
      until: "打倒隆卡遗迹首领前",
      past: "scenario_7",
    },
    { numbers: [76, 77, 78, 79], areas: [54], until: "大桥的战斗结束前", past: "scenario_10" },
    {
      numbers: [263],
      areas: [0],
      until: "泽扎的船队上，等吉尔伽美什召唤它再打倒吉尔伽美什",
      past: "scenario_10",
    },
    {
      numbers: [106, 107, 108, 109, 110, 111, 112],
      areas: [57],
      until: "打倒屏障之塔首领前",
      past: "scenario_10",
    },
    { numbers: [122], areas: [79, 86], until: "慕亚大森林变化前", past: "scenario_11" },
    {
      numbers: [71, 72],
      areas: [40],
      until: "艾克斯迪司城地下室，解除幻术前",
      past: "scenario_11",
    },
    {
      numbers: [
        30, 82, 121, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 158, 255, 271, 272,
        273,
      ],
      areas: [40],
      until: "打倒十三层的艾克斯迪司前",
      past: "scenario_11",
    },
    {
      numbers: [162, 163, 164, 165, 166, 167],
      areas: [66, 67, 68],
      until: "打倒两歧塔首领前",
    },
  ],
  /** 10-27 live dump: 封印之间 holds 12 hidden-item boxes, the 12 sealed weapons. */
  areaGoals: [{ api: "get_sealed_weapon", area: 55, kind: "hidden" }],
  /** Checked on the 10-27 live dump. */
  elements: { 1: "火", 2: "冰", 3: "雷", 4: "土", 5: "水", 6: "毒", 7: "圣", 8: "风" },
};

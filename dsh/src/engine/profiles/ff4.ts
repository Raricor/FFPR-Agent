/**
 * FF4's profile (task 20). The Steam list is the public page's Simplified Chinese entries. The
 * missables come from the guides in .deps/knowledge/ff4 (Seeking Tech's 38 missable chests, RPG
 * Site's walkthrough), matched against the game's own area ids and box counts on the 10-28
 * title-screen dump (bridge 0.10.0).
 */

import type { GameProfile } from "./types.ts";

export const FF4_PROFILE: GameProfile = {
  key: "ff4",
  achievements: [
    {
      api: "all_achievement",
      name: "ＦＦ４大师！",
      description: "获得了所有成就。",
      hidden: false,
    },
    {
      api: "scenario_1",
      name: "烧毁与决意",
      description: "迷雾村被摧毁了。",
      hidden: true,
    },
    {
      api: "scenario_3",
      name: "被托付光明之人",
      description: "登上试炼之山，成为了圣骑士。",
      hidden: true,
    },
    {
      api: "scenario_4",
      name: "跨越悲伤",
      description: "打倒了水之凯纳槽。",
      hidden: true,
    },
    {
      api: "scenario_5",
      name: "夺回的爱与羁绊",
      description: "打倒了风之巴尔巴莉希娅。",
      hidden: true,
    },
    {
      api: "scenario_6",
      name: "前往地底世界",
      description: "到达了地底世界。",
      hidden: true,
    },
    {
      api: "scenario_7",
      name: "化悲痛为力量",
      description: "打倒了炎之卢比坎特。",
      hidden: true,
    },
    {
      api: "scenario_8",
      name: "前往月亮",
      description: "获得了魔导船，到达了月亮世界。",
      hidden: true,
    },
    {
      api: "scenario_9",
      name: "再战",
      description: "再次打倒了四天王。",
      hidden: true,
    },
    {
      api: "scenario_10",
      name: "前往蓝星",
      description: "打倒了泽罗姆斯，为世界取回了和平。",
      hidden: true,
    },
    {
      api: "scenario_11",
      name: "传说中的圣剑",
      description: "获得了王者之剑。",
      hidden: false,
    },
    {
      api: "scenario_12",
      name: "传说中的尾巴",
      description: "用粉色尾巴交换了精金铠。",
      hidden: false,
    },
    {
      api: "get_weapon",
      name: "获得释放的力量",
      description: "得到了所有被封印的装备。",
      hidden: false,
    },
    {
      api: "all_summon",
      name: "召唤大师",
      description: "学会了除隐藏召唤魔法外的所有召唤魔法。",
      hidden: false,
    },
    {
      api: "all_hidden_summon",
      name: "召唤收藏家",
      description: "学会了所有隐藏召唤魔法。",
      hidden: false,
    },
    {
      api: "level_all_70",
      name: "身经百战的强者们",
      description: "全员达到了70级。",
      hidden: false,
    },
    {
      api: "monster_hunt_100",
      name: "见习战士",
      description: "打倒了100只怪物。",
      hidden: false,
    },
    {
      api: "monster_hunt_500",
      name: "熟练战士",
      description: "打倒了500只怪物。",
      hidden: false,
    },
    {
      api: "monster_hunt_1000",
      name: "传说战士",
      description: "打倒了1000只怪物。",
      hidden: false,
    },
    {
      api: "picture_book_19",
      name: "魔物图鉴·基础知识篇",
      description: "怪物图鉴的完成率达到了10%。",
      hidden: false,
    },
    {
      api: "picture_book_98",
      name: "魔物图鉴·战斗解析篇",
      description: "怪物图鉴的完成率达到了50%。",
      hidden: false,
    },
    {
      api: "picture_book_197",
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
      api: "treasure_box_34",
      name: "新手宝物猎人",
      description: "宝箱的回收率达到了10%。",
      hidden: false,
    },
    {
      api: "treasure_box_171",
      name: "老练宝物猎人",
      description: "宝箱的回收率达到了50%。",
      hidden: false,
    },
    {
      api: "treasure_box_342",
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
   * The four one-time towers; every count matches the game's boxes. Two areas are named 巴别塔:
   * 45 (16 boxes) is the underworld tower, 38 (8) the overworld one. The Four Fiends' rematch
   * (再战) is inside the Giant, so only the ending is certainly after it: the Giant only warns.
   */
  oneTimePlaces: [
    { area: 36, until: "进五楼中间的门前", past: "scenario_5" }, // 佐特塔
    { area: 45, until: "进八楼中间的门前", past: "scenario_7" }, // 巴别塔 (underworld)
    {
      area: 38,
      until: "六个在进五楼中间的门前，两个在首领战后、进六楼西南的门前",
      past: "scenario_8",
    }, // 巴别塔 (overworld)
    { area: 60, until: "去巨人的阶梯前" }, // 巴别巨人
  ],
  /**
   * RPG Site's Tower of Zot list, all only in the game's habitat 36. Left out: Puppeteer (67),
   * which RPG Site and the game both place in a later tower too, and the Babel and Giant lists:
   * on the 10-28 dump the game's habitat ids do not follow the towers there (the Giant's Mech
   * Dragon is under 巴别塔, Mystery Egg and Stone Golem under 巴别巨人), so no rule could be
   * checked against them.
   */
  bestiaryMissables: [
    {
      // Puppet, Sorceress, Black Knight, Centaur Knight, Gremlin, Soldieress, Ice Lizard,
      // Cold Beast, Hell Turtle.
      numbers: [61, 62, 63, 64, 65, 66, 68, 69, 70],
      areas: [36],
      until: "打倒佐特塔顶的首领前",
      past: "scenario_5",
    },
  ],
  areaGoals: [],
  // The weak-row sentences name 1-6 (10-28 dump); 7 stays a number.
  elements: {},
};

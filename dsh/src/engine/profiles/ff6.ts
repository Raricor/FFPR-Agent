/**
 * FF6's profile (task 20). The Steam list is the public page's Simplified Chinese entries. The
 * missables come from the guides in .deps/knowledge/ff6 (Seeking Tech's missable chests, RPG
 * Site's walkthrough), matched against the game's own area ids and box counts on the 10-28
 * title-screen dump (bridge 0.10.0).
 */

import type { GameProfile } from "./types.ts";

export const FF6_PROFILE: GameProfile = {
  key: "ff6",
  achievements: [
    {
      api: "all_achievement",
      name: "ＦＦ６大师！",
      description: "获得了所有成就。",
      hidden: false,
    },
    {
      api: "scenario_1",
      name: "魔导少女",
      description: "遇到了冰封的幻兽并获得了觉醒。",
      hidden: true,
    },
    {
      api: "scenario_2",
      name: "残存的希望",
      description: "与巴南相遇，下定了与帝国对抗的决心。",
      hidden: true,
    },
    {
      api: "scenario_3",
      name: "幻兽攻防战",
      description: "成功击退帝国军，保护了冰封的幻兽。",
      hidden: true,
    },
    {
      api: "scenario_4",
      name: "被托付的力量",
      description: "与拉姆相遇，获得了魔石。",
      hidden: true,
    },
    {
      api: "scenario_5",
      name: "翱翔天空",
      description: "让歌剧大获成功，获得了飞空艇。",
      hidden: true,
    },
    {
      api: "scenario_6",
      name: "为了和平",
      description: "与格斯塔拉皇帝会餐，并进行了和平交涉。",
      hidden: true,
    },
    {
      api: "scenario_7",
      name: "世界的毁灭",
      description: "三斗神复活，给世界带来了毁灭。",
      hidden: true,
    },
    {
      api: "scenario_8",
      name: "寻找同伴 I",
      description: "与1名同伴重逢。",
      hidden: true,
    },
    {
      api: "scenario_9",
      name: "寻找同伴 II",
      description: "与5名同伴重逢。",
      hidden: true,
    },
    {
      api: "scenario_10",
      name: "寻找同伴 III",
      description: "与10名同伴重逢。",
      hidden: true,
    },
    {
      api: "scenario_11",
      name: "复苏的生机",
      description: "打倒了凯夫卡，为世界夺回了和平。",
      hidden: true,
    },
    {
      api: "magicite_collect_15",
      name: "魔石收藏家",
      description: "获得了15个魔石。",
      hidden: false,
    },
    {
      api: "magicite_collect_25",
      name: "魔石达人",
      description: "获得了所有魔石。",
      hidden: false,
    },
    {
      api: "machinery_master",
      name: "机械师大师",
      description: "获得了所有“机械”。",
      hidden: false,
    },
    {
      api: "monk_master",
      name: "武僧大师",
      description: "学会了所有“必杀技”。",
      hidden: false,
    },
    {
      api: "samurai_master",
      name: "武士大师",
      description: "学会了所有“必杀剑”。",
      hidden: false,
    },
    {
      api: "gambler_master",
      name: "赌博师大师",
      description: "在“老虎机”中掷出了“致命鬼牌”。",
      hidden: false,
    },
    {
      api: "blue_magic_master_20",
      name: "青魔法师大师",
      description: "学会了20种敌人的招数。",
      hidden: false,
    },
    {
      api: "wild_master_50",
      name: "野孩子大师",
      description: "使用“跳入”学会了50种敌人的招数。",
      hidden: false,
    },
    {
      api: "auction_battle",
      name: "竞拍中标者",
      description: "通过竞拍中标了道具。",
      hidden: false,
    },
    {
      api: "coliseum_champion",
      name: "竞技场霸者",
      description: "在竞技场获得了10场胜利。",
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
      api: "picture_book_34",
      name: "魔物图鉴·基础知识篇",
      description: "怪物图鉴的完成率达到了10%。",
      hidden: false,
    },
    {
      api: "picture_book_173",
      name: "魔物图鉴·战斗解析篇",
      description: "怪物图鉴的完成率达到了50%。",
      hidden: false,
    },
    {
      api: "picture_book_346",
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
      api: "treasure_box_22",
      name: "新手宝物猎人",
      description: "宝箱的回收率达到了10%。",
      hidden: false,
    },
    {
      api: "treasure_box_107",
      name: "老练宝物猎人",
      description: "宝箱的回收率达到了50%。",
      hidden: false,
    },
    {
      api: "treasure_box_214",
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
   * Seeking Tech's 88 chests and 8 hidden items, one place each; every count matches the game's
   * boxes for that area, except 回归者总部, where the game has 3 hidden items and the guide
   * names 1. `past` is the first story achievement certainly after the deadline: 世界的毁灭
   * (scenario_7) for whatever is gone in the World of Ruin.
   */
  oneTimePlaces: [
    { area: 13, until: "进入崩坏后的世界前", past: "scenario_7" }, // 科尔兹山
    { area: 14, until: "进入崩坏后的世界前", past: "scenario_7" }, // 回归者总部
    // The first box before heading south to the bridge, the other three before the third Kefka.
    { area: 17, until: "多玛城第三次和凯夫卡交手前", past: "scenario_3" }, // 帝国军阵地
    { area: 22, until: "进车头机房前", past: "scenario_3" }, // 魔列车
    { area: 2, until: "进入崩坏后的世界前", past: "scenario_7" }, // 蛇道
    { area: 43, until: "去地下二层前", past: "scenario_6" }, // 魔导工厂
    { area: 44, until: "离开研究所前", past: "scenario_6" }, // 魔导研究所
    { area: 63, until: "走到地下四层前", past: "scenario_6" }, // 封魔壁洞窟
    { area: 41, until: "进入崩坏后的世界前", past: "scenario_7" }, // 帝国城
    // Only open when the banquet went well.
    { area: 62, until: "进入崩坏后的世界前(皇帝的宴会要表现好)", past: "scenario_7" }, // 封魔壁监视所
    { area: 56, until: "离开着火的民房前(先走右边的房间，再走左边)", past: "scenario_7" }, // 着火的民房
    { area: 60, until: "进入崩坏后的世界前", past: "scenario_7" }, // 幻兽洞窟
    // Three before Ultima Weapon; the fourth on the escape, south then north.
    { area: 58, until: "逃出魔大陆前(第四个在逃跑路上：先往南再往北)", past: "scenario_7" }, // 魔大陆
    // Tzen's collapsing house and Cyan's dream are optional World of Ruin events: no story
    // achievement is certainly after them, so these two only warn.
    { area: 49, until: "救出危房里的孩子前(有时限)" }, // 危房
    { area: 23, until: "拉下车头的拉杆前" }, // 梦境迷宫 魔列车
  ],
  /**
   * Only what the guide names and the game's habitats agree with (10-28 dump). Area 76 is the
   * Veldt, where Gau's rages bring back monsters already fought, so it is no second chance for
   * a part of a boss. RPG Site also calls Tzen's three monsters missable, but the game lists
   * them elsewhere too (123 on the world map, 124 and 125 in 南费加罗洞窟): left unmarked, as
   * for FF5 when the two disagree.
   */
  bestiaryMissables: [
    // The Phantom Train's ghosts and the false Siegfried (the optional sixth chest).
    { numbers: [47, 48], areas: [22], until: "进车头机房前", past: "scenario_3" },
    {
      numbers: [290, 291, 292],
      areas: [58, 76],
      until: "空军装甲战里：只打掉激光炮，袖珍屏障才出现",
      past: "scenario_7",
    },
  ],
  // 道具猎人 counts every hidden item, not one place's.
  areaGoals: [],
  // The weak-row sentences name all eight (10-28 dump).
  elements: {},
};

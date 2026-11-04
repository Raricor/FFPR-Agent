/**
 * FF1's profile (task 20). The Steam list is the public page's Simplified Chinese entries. RPG
 * Site's FF2 walkthrough notes that FF1 has no missable items, and the 10-28 title-screen dump
 * has no hidden items at all (249 chests, the Steam 100% count), so the lists stay empty.
 */

import type { GameProfile } from "./types.ts";

export const FF1_PROFILE: GameProfile = {
  key: "ff1",
  achievements: [
    {
      api: "all_achievement",
      name: "ＦＦ１大师！",
      description: "获得了所有成就。",
      hidden: false,
    },
    {
      api: "scenario_1",
      name: "光之战士的旅程",
      description: "打倒了加兰德，救出了莎拉公主。",
      hidden: true,
    },
    {
      api: "scenario_2",
      name: "大地的恩惠",
      description: "取回了土之水晶的光辉。",
      hidden: true,
    },
    {
      api: "scenario_3",
      name: "燃烧的火炎",
      description: "取回了火之水晶的光辉。",
      hidden: true,
    },
    {
      api: "scenario_4",
      name: "治愈之水",
      description: "取回了水之水晶的光辉。",
      hidden: true,
    },
    {
      api: "scenario_5",
      name: "风之细语",
      description: "取回了风之水晶的光辉。",
      hidden: true,
    },
    {
      api: "scenario_6",
      name: "勇气与力量之证",
      description: "被巴哈姆特授予了勇者的称号。",
      hidden: true,
    },
    {
      api: "scenario_7",
      name: "幻想物语",
      description: "打倒了卡奥斯，为世界夺回了和平。",
      hidden: true,
    },
    {
      api: "scenario_8",
      name: "梦幻之剑",
      description: "获得了王者之剑。",
      hidden: false,
    },
    {
      api: "pazzle_play",
      name: "隐藏游戏",
      description: "玩了数字拼图游戏。",
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
      api: "treasure_box_25",
      name: "新手宝物猎人",
      description: "宝箱的回收率达到了10%。",
      hidden: false,
    },
    {
      api: "treasure_box_125",
      name: "老练宝物猎人",
      description: "宝箱的回收率达到了50%。",
      hidden: false,
    },
    {
      api: "treasure_box_249",
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
  oneTimePlaces: [],
  bestiaryMissables: [],
  areaGoals: [],
  // FF1's monster data names no element at all (10-28 dump); unknown ids show as numbers.
  elements: {},
};

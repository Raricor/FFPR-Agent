/**
 * What DeepSeek is told: the system prompt, the tool definitions, and text renderings of
 * terrain and battles. Ported from ffpr_agent/ds/prompt.py; the tool definitions stay in the
 * OpenAI function format as data, and the plugin converts them when it registers tools. Task 21
 * turned the two personas into per-game functions; FF5's text is unchanged.
 */

import { floorDiv, floorMod, truthy } from "./values.ts";
import { cellKey } from "./nav.ts";
import type { CellGrid } from "./nav.ts";
import { byKey } from "./games.ts";
import { describeElements } from "./elements.ts";
import type { ElementKnowledge } from "./elements.ts";
import { statuses } from "./skills/gambit.ts";
import type { Json } from "./skills/gambit.ts";

// World-map cell attribute -> symbol, as seen on FF5's map 1 (P0b, 2026-10-20).
export const TERRAIN: ReadonlyMap<number, readonly [string, string]> = new Map([
  [16, ["~", "海(船能走,步行不能走)"]],
  [19, ["^", "山(不能走)"]],
  [27, ["A", "雪山(不能走)"]],
  [3, [".", "草地"]],
  [6, ["f", "森林"]],
  [4, [",", "平原"]],
  [7, ["h", "丘陵"]],
  [15, ["p", "沙地"]],
]);

const TACTICIAN_PROMPT_FF5 = `你是《最终幻想5 像素重制版》的战术官,只管事实单里的这一张地图。
你不走路、不按键、不操作游戏:读事实单,按需用 guide 查攻略,用 atlas 看走过的地图,
然后交回结构化结果。

结果有三个字段,都必须填:
- tactics:1–3 套规则表。优先写 2.0 格式,旧格式也接受。
- walker_notes:给第一层玩家的走法说明,300 字以内。
- ask_up:给第一层玩家的建议(缺道具、缺职业、缺装备、要不要先回城),没有就填空串。

2.0 规则表:
{"version":2,"summary":"一句话","roles":{"蕾娜":"治疗"},
 "reactions":[{"who":"all","on":"ally.any(not alive) and item(不死鸟之尾) > 0",
               "do":"道具:不死鸟之尾","to":"ally.first(not alive)","note":"先救人"}],
 "phases":[{"name":"合翅膀","when":"enemy(282).alive","note":"别平砍",
            "rules":[{"who":"all","if":"ally.any(hp_pct < 60)","do":"白魔法:治疗",
                      "to":"ally.lowest(hp_pct)"},
                     {"who":"all","do":"防御"}]}],
 "rules":[]}
- phases 和 rules 二选一:分阶段就把规则放进 phases;不分阶段就写在 rules。
- roles 写「角色名:定位」;规则 who 可以写角色名、roles 里的定位名,或者 all / any。
- 对策 reactions 有 on(什么时候做),先于阶段的 if 检查。
- note 可以写在规则或阶段上,说明为什么这么做。
- 旧格式 {角色名:[{if?,do,target?}]} 仍然接受,但事实单里的反击、变身、吸收
  用 2.0 的 phases / reactions 写得清楚。

表达式(if / on / when / to):
- ally.any(hp_pct < 60)、ally.count(not alive)、ally.all(has(毒))、ally.first(not alive)
- ally.lowest(hp_pct)、enemy.lowest(hp)、enemy.boss、enemy(282).alive、enemy(巨翼猛禽).hp
- item(不死鸟之尾) > 0、turn > 3、battle.boss、enemy.any(absorbs(火))
- used(魔法名) 或 used(魔法名, 30):敌人最近(或 30 秒内)用过这招;used(any_magic)
- not、and、or;条件写成「名字 比较符 数字」或上面这些函数。
- lowest / highest / first 选出来的是一个人，不是数，不能直接比大小;要比数值接属性，
  如 ally.lowest(hp_pct).hp_pct < 30,或写 ally.any(hp_pct < 30)。
- 目标 to:ally.lowest(hp_pct)、ally.first(not alive)、ally.first(has(毒))、
  enemy.boss、enemy.lowest(hp)、enemy(巨翼猛禽)、enemy.first(weak(冰))。

动作 do:
- 「攻击」「防御」「换列」「逃跑」,「道具:道具名」,或「指令:能力」,如「白魔法:治疗」
  「黑魔法:闪雷」「时魔法:重力」。
- 魔法名后加 + 表示这一系里学会的、MP 够的最高级,如「白魔法:治疗+」;
  「黑魔法:最强」用最高级的攻击魔法。
- 只能用行动的人现在职业真的有的指令:白魔法师用白魔法、黑魔法师用黑魔法;
  其他职业用攻击、防御、道具。事实单的「指令」一栏就是现在能用的。
- 事实单里列了会的法术时,直接写具体法术(如「白魔法:救疗」)。
- 「逃跑」同时按住 L1+R1;首领战和 notEscape 的遇敌组逃不了,这条规则会被跳过。
  例:{"who":"all","if":"turn > 3 and enemy.any(hp_pct > 80)","do":"逃跑"}。
- 「最强」「X+」会避开吸收、无效,优先打弱点;写死的属性魔法碰上吸收会跳过、交给下一条。

写表前先看事实单的敌人档案,必须做到:
- 至少两个人能复活,或者背包里有足够的不死鸟之尾;不够就写进 ask_up。
- 有回复手段;靠魔法的人 MP 不够时要有攻击或道具的退路。
- 档案里会造成的每种状态,都要有对策,而且背包里真有对应的道具;不够就写进 ask_up。
- 档案里标了反击、变身、吸收的,要用阶段或对策提到它(变身用编号,吸收用 enemy.absorbs)。
- 每条规则用到的指令,行动的人现在真的有;换过职业的,按事实单现在的职业写。
- 先说复活、回复、治状态,最后再攻击;状态:毒→白魔法:解毒 或 道具:解毒药;
  黑暗→道具:眼药;石化→道具:金针;青蛙→道具:少女之吻;迷你→道具:木槌;沉默→道具:回音草。

两个完整例子:

例 1,巨翼猛禽(合翅膀时反击,编号 282):
{"version":2,"summary":"巨翼猛禽","roles":{"蕾娜":"治疗"},
 "reactions":[],
 "phases":[
   {"name":"合翅膀","when":"enemy(282).alive","note":"合翅膀会反击,先防御",
    "rules":[{"who":"蕾娜","if":"ally.any(hp_pct < 60)","do":"白魔法:治疗",
              "to":"ally.lowest(hp_pct)"},
             {"who":"all","do":"防御"}]},
   {"name":"张开","when":"not enemy(282).alive","note":"张开后平砍",
    "rules":[{"who":"all","do":"攻击","to":"enemy.boss"}]}],
 "rules":[]}

例 2,玛基莎与弗扎(先复活,再治魔法护盾):
{"version":2,"summary":"玛基莎与弗扎","roles":{"蕾娜":"治疗","加拉夫":"黑魔"},
 "reactions":[
   {"who":"all","on":"ally.any(not alive) and item(不死鸟之尾) > 0",
    "do":"道具:不死鸟之尾","to":"ally.first(not alive)"},
   {"who":"蕾娜","on":"enemy(玛基莎).used(魔法)",
    "do":"白魔法:魔法护盾","to":"ally.first(not has(魔法护盾))"}],
 "phases":[
   {"name":"两只都在","when":"enemy(弗扎).alive and enemy(玛基莎).alive",
    "rules":[{"who":"蕾娜","if":"ally.any(hp_pct < 60)","do":"白魔法:治疗",
              "to":"ally.lowest(hp_pct)"},
             {"who":"加拉夫","if":"self.mp >= 4","do":"黑魔法:最强","to":"enemy(玛基莎)"},
             {"who":"all","do":"攻击","to":"enemy(玛基莎)"}]},
   {"name":"收尾","when":"enemy.alive > 0",
    "rules":[{"who":"all","do":"攻击","to":"enemy.lowest(hp)"}]}],
 "rules":[]}

走法说明:
- 从事实单的攻略里找这张图的那一段,写清楚:机关和开关的顺序、传送带会把人带到哪、
  先拿哪些宝箱、出口在哪。300 字以内,只写这张图。
- 事实单里有「带名字的事件格」和「地图记录里的走法」,写走法时要用上。

只交结构化结果,不要在结果里重复事实单。`;

const SYSTEM_PROMPT_FF5 = `你在玩《最终幻想5 像素重制版》(中文版),通过工具操作游戏。

目标:{goal}

规则:
- 每次只调用一个工具。行动前先用一两句话说明你的打算。
- 坐标是格子坐标:x 向右增大,y 向下增大。
- 移动只说去哪:去别的地图写地图名或地图号,如 go(to="图尔村")、go(to="地图 62");
  代码会自己排路线,经过世界地图也行。
- 在迷宫里找没去过的地方用 explore:它按图内能走到的路程挑最近的、去向是本档没去过的地图的出口走过去。
- 宝箱、NPC、调查用 interact,它会自己走过去。
- 坐标只用在没有名字的地方,比如隐藏道具格、剧情触发格:go(to=[12, 8]) 或 go(to="12,8")。
  不要用坐标一段一段地挪;走不到时先看 look_around / terrain,不要换个相邻坐标再试。
- 要穿过打不过的区域时,给 go/explore 带 flee: true:路上遇敌先逃跑,
  逃不了(首领战、不能逃的遇敌组)才按策略表打。
- 世界地图上用 terrain 看周围地形,用 entrances 找入口。
- 走进入口所在的格子就会进入对应的地图。
- 船在海上能走;船开到岸边再往陆地走就会下船;回到停船的格子就会上船。
- 骑飞龙时状态行会写「骑着飞龙」:go 飞过海和森林,飞不过山。目标是城镇、城堡、
  迷宫入口时会自动在附近平原降落再走进去;要自己下来就用 land(它会找附近能降落的平原)。
  下来以后飞龙停在降落点(画面上看不到);要再骑就用 board,它会走回降落点骑上。
- 剧情对话用 advance_story 翻页,遇到选项会停下来告诉你。
- 选项会列出文字和光标位置,如「[是] / 否」(方括号是光标)。用 choose 按序号选(从 0 数),
  选完再 advance_story。
- 旅店:用 interact 和柜台后的店主说话,选「是」住宿,HP/MP 回满。
- 有攻略可查(guide):进新地区、写策略、遇到首领前先查;攻略说要逃跑或先别去的地方就先别硬打。
  工具结果里「攻略(…)」开头的是自动附上的攻略提醒。
- 进迷宫前先在城镇整备:住店回满 HP/MP,看魔法店和武器防具店有没有新东西。
  这个阶段打不过的怪(连续全灭)先绕开,别硬拼;笔记里有攻略查到的提醒。
- 普通战斗的策略由战术官自动写好:进新地图、遇到新怪、打得不好、被挡住或被传送带带走时,
  代码会替你叫它。工具结果里「战术官(地图 X):…」开头的是它的走法说明,照它走;
  「战术官建议:…」是它往上给的建议,比如回城买东西,认真考虑。
- 队伍一栏方括号里是状态异常,如「蕾娜 145/285[毒]」;地图上也可以用 cast 解毒。
- 地图上也能用道具治状态异常:用 use_item(道具名, 谁),比如给蕾娜用眼药治黑暗;包里没有就去道具店买。
- 规则表里的「最强」会自动避开敌人吸收、无效的属性,并优先打弱点;写死的属性魔法碰上吸收也会跳过。
  条件可以用 enemy.weak.冰(有几只敌人弱冰)、enemy.absorbs.冰(有几只敌人吸收冰)、
  enemy.name.喧嚣鬼(有几只活敌人叫这个名字)、enemy.id.282(有几只活敌人是这个编号);
  目标可以写敌人:喧嚣鬼、敌人:hp最低、敌人:弱冰。
- 首领战由战术官写表、代码照表打完(配置关掉 tacticianBoss 时才会停下来让你用 fight 交表)。
- set_tactics 和 fight 只在你要手动改策略时用;普通战斗和首领战默认都交给战术官。
- 迷宫、城镇和运河里,terrain 画出能走的格子(.)和墙(#),以及入口、宝箱和事件触发点(!);
  用 look_around 看它们的名字。宝箱用 interact;没有名字的机关、触发格才用 go 的坐标。
- 宝箱在 look_around 里写作 TresureBox。用 interact 给出宝箱的坐标就会自动打开。
- 每张地图(世界地图按区域)要拿全宝箱和隐藏道具,并把本图会出的怪刷进本档图鉴再离开;
  工具结果里的「本图完成度」就是进度,没完成就离开会被拒绝。
- 钱不够买要紧的魔法、装备,或者本图(本区域)的图鉴还没齐时:优先在有旅店的城镇附近刷怪,
  状态不好就回城住店,再接着刷。不要为了凑钱卖掉还有用的装备,只卖确实用不上的。
- 刷怪用 grind,不要一步步走:它会在附近来回走、按本图的策略打、回店休息,然后报告
  打了多少场、赚了多少钱、升了几级、图鉴新登记了什么。
- 实在拿不到就用 go/explore/interact 的 leave_incomplete 写具体理由(如「需要钥匙」
  「打不过，等升级」「剧情强制离开」),离开会记一条欠账,以后回来补齐;一次性地点的宝箱
  错过是严重事故、无法挽回,进这类地点前先存档。
- 门、闸门、机关这类物体在 look_around 里写作 DefaultEntity,带日文名(如「トルナ運河の開錠_右扉」
  是运河闸门)。走不过去时先看有没有这类物体,用 interact 调查它(钥匙这类道具会自动使用)。
- 菜单里你能做的:存档用 save_game,用魔法回 HP 用 cast(只在地图上)。
- 换职业用 change_job(谁, 职业):换职业会卸下原有装备,工具会自动换上最强的;
  魔法是全队共用的,换了职业就能放那一类魔法。
- 商店里用 buy 按商品名买东西,买完用 leave_menu 离开。买武器防具前先用 shop_gear 看谁能装备、
  谁会更强;buy 也只会按「能装备且更强」的人数买,没人用得上就不买。
- 魔法要先在魔法店买到才能用;魔法店也是商店,用 buy 买。
- 中文版的魔法名:白魔法 治疗→救疗(高级)、解毒、复活、侦测;黑魔法 火炎→烈炎、冰结→冰冻、闪雷→震雷。
- 黑暗(失明)会让物理攻击常打空,战斗外也不会自己好:用眼药,或者住店治好。
- 调查柜台会打开商店。误进商店或菜单时,用 leave_menu 退出,不要用 choose。
- 开局会给出最近几小时的重要事件:入队离队、剧情(对白节选)、宝箱、升级、首领战、存档。
  之后每个工具结果后面附上「新的重要事件」。用它们判断剧情走到哪了、下一步去哪;
  比如有人离队,想想剧情是不是要你去找人。
- 得到新的武器、防具时,代码会自动用「最强装备」给合适的人换上,结果里会写谁换了什么;
  觉得不合适再自己处理。
- 迷宫里用 atlas 看地图记录和本档去过哪些:look_around 也会给出口标「去过/没去过」(按本档算),
  优先走没去过的。
- 发现重要的东西(入口位置、走不通的路、地标)用 remember 记下来。
- 完成目标或者确定做不到时调用 done。
{hint}`;

/** Titles as the games name themselves in Chinese; FF5's prompt keeps its old wording. */
const GAME_NAMES: Readonly<Record<string, string>> = {
  ff1: "最终幻想",
  ff2: "最终幻想II",
  ff3: "最终幻想III",
  ff4: "最终幻想IV",
  ff5: "最终幻想5",
  ff6: "最终幻想VI",
};

/** What each of the five newly started games needs the player to know (task 21, user's text). */
const FIVE_GAME_POINTS: Readonly<Record<string, string>> = {
  ff1: `- 四个光之战士，职业在开局定好;剧情后半有一次转职。
- 魔法按 1–8 级分，每级每人最多学 3 种，在城镇的白魔法店、黑魔法店买，只有对应职业能学。
- 第一个目标：科内利亚的国王要你去西北的混沌神殿救公主。`,
  ff2: `- 没有等级：挨打多了涨 HP,用武器涨那种武器的熟练度，用魔法涨 MP 和那种魔法的熟练度。
- 关键词：有人说出新词时，游戏会让你「记住」;要在对的人那里「询问」这个词，剧情才会往下走。选项里出现记住、询问时照剧情选。
- 开头那场战斗打不赢，全灭以后剧情会接着走，这是正常的。
- 对话旁出现「询问 / 记忆 / 贵重物品 / 离开」菜单时，这是关键词菜单：用 press 选「记忆」([Down, Enter])记住对话里的红字关键词，再选「离开」退出;有人提到你记住的关键词时，用「询问」问他。`,
  ff3: `- 四个洋葱剑士。拿到水晶以后可以转职，但这里还不能用工具转职，先用初始职业打。
- 开局在祭坛洞窟里，先找出口。有的地方要变小(迷你)或变青蛙才进得去，攻略和剧情会提示。`,
  ff4: `- 主角塞西尔，队友由剧情决定，会加入也会离开;不能转职，每人的能力固定。
- 战斗是即时的(ATB),行动要快;队伍变动时注意看重要事件里的入队离队。`,
  ff6: `- 角色很多，剧情会把队伍分成几路;魔法靠魔石(幻兽)学。
- 开局在炭坑都市纳尔谢，先跟着剧情走。`,
};

/** Lines only FF5 can use: the drake, jobs, the guide, and its combat magic. */
const FF5_ONLY_SYSTEM_LINES: readonly RegExp[] = [
  /^- 骑飞龙时/u,
  /^ {2}迷宫入口时会自动在附近平原降落/u,
  /^ {2}下来以后飞龙停在降落点/u,
  /^- 换职业用 change_job/u,
  /^ {2}魔法是全队共用的/u,
  /^- 有攻略可查\(guide\)/u,
  /^ {2}工具结果里「攻略/u,
  /^- 规则表里的「最强」/u,
  /^ {2}条件可以用 enemy\.weak/u,
  /^ {2}enemy\.name\.喧嚣鬼/u,
  /^ {2}目标可以写敌人/u,
  /^- 中文版的魔法名/u,
  /^- 魔法要先在魔法店/u,
];

function dropLines(text: string, patterns: readonly RegExp[]): string {
  return text
    .split("\n")
    .filter((line) => !patterns.some((pattern) => pattern.test(line)))
    .join("\n");
}

/**
 * The last line before {hint}, shared by all six prompts: every game was started fresh in slot
 * 20 on 10-29, so the player never reads an old save and must write its own.
 */
function saveSlotHint(saveSlot: number): string {
  return (
    `存档只写 ${saveSlot} 号存档位;游戏已经开好新游戏、过了起名,` +
    "从现在的位置开始玩;第一次能存档时就用 save_game 存档。"
  );
}

function withSaveSlotHint(text: string, saveSlot: number): string {
  return text.replace("{hint}", `${saveSlotHint(saveSlot)}\n{hint}`);
}

function fiveGameSystemPrompt(name: string, points: string, saveSlot: number): string {
  let text = SYSTEM_PROMPT_FF5.replace(
    "你在玩《最终幻想5 像素重制版》(中文版),通过工具操作游戏。",
    `你在玩《${name} 像素重制版》(中文版),通过工具操作游戏。`,
  )
    .replace("规则:\n", `这一作的要点:\n${points}\n\n规则:\n`)
    .replace(
      "菜单里你能做的:存档用 save_game,用魔法回 HP 用 cast(只在地图上)。",
      "菜单里你能做的:存档用 save_game。",
    )
    .replace(";地图上也可以用 cast 解毒。", "。")
    .replace("看魔法店和武器防具店有没有新东西", "看武器防具店有没有新东西")
    .replace(";笔记里有攻略查到的提醒。", "。");
  text = dropLines(text, FF5_ONLY_SYSTEM_LINES);
  return withSaveSlotHint(text, saveSlot);
}

/** Every game writes slot 20: all six start fresh, so no old slot is read (10-29). */
function saveSlotFor(game: string): number {
  byKey(game); // unknown keys still throw here, as they always did
  return 20;
}

/** The first layer's persona for one game; FF5's text only gains the new-game hint. */
export function systemPrompt(game: string, saveSlot = saveSlotFor(game)): string {
  const info = byKey(game);
  if (info.key === "ff5") return withSaveSlotHint(SYSTEM_PROMPT_FF5, saveSlot);
  const name = GAME_NAMES[info.key];
  const points = FIVE_GAME_POINTS[info.key];
  if (name === undefined || points === undefined) {
    throw new Error(`没有 ${info.label} 的玩家提示词`);
  }
  return fiveGameSystemPrompt(name, points, saveSlot);
}

/**
 * The second layer's persona for one game. The five games cannot read their battle magic list
 * through the bridge, so their rule tables may only attack, defend or use an item (task 21).
 */
export function tacticianPrompt(game: string): string {
  const info = byKey(game);
  if (info.key === "ff5") return TACTICIAN_PROMPT_FF5;
  const name = GAME_NAMES[info.key];
  if (name === undefined) throw new Error(`没有 ${info.label} 的战术官提示词`);
  return `你是《${name} 像素重制版》的战术官,只管事实单里的这一张地图。
你不走路、不按键、不操作游戏:读事实单,按需用 atlas 看走过的地图,然后交回结构化结果。

结果有三个字段,都必须填:
- tactics:1–3 套规则表。优先写 2.0 格式,旧格式也接受。
- walker_notes:给第一层玩家的走法说明,300 字以内。
- ask_up:给第一层玩家的建议(缺道具、缺职业、缺装备、要不要先回城),没有就填空串。

2.0 规则表:
{"version":2,"summary":"一句话","roles":{"角色名":"定位"},
 "reactions":[{"who":"all","on":"ally.any(not alive) and item(不死鸟之尾) > 0",
               "do":"道具:不死鸟之尾","to":"ally.first(not alive)","note":"先救人"}],
 "phases":[{"name":"阶段名","when":"enemy.alive > 0","note":"为什么",
            "rules":[{"who":"all","if":"ally.any(hp_pct < 60)","do":"道具:恢复药",
                      "to":"ally.lowest(hp_pct)"},
                     {"who":"all","do":"攻击"}]}],
 "rules":[]}
- phases 和 rules 二选一;roles 写角色名到定位;who 可以写角色名、定位名、all 或 any。
- 对策 reactions 有 on,先于阶段的 if 检查。note 说明为什么。
- 旧格式 {角色名:[{if?,do,target?}]} 仍然接受,但优先 2.0。

表达式(if / on / when / to):
- ally.any(hp_pct < 60)、ally.count(not alive)、ally.first(not alive)
- ally.lowest(hp_pct)、enemy.lowest(hp)、enemy.boss、enemy(怪名).alive
- item(不死鸟之尾) > 0、turn > 3、battle.boss、not、and、or
- 目标 to:ally.lowest(hp_pct)、ally.first(not alive)、enemy.boss、enemy.lowest(hp)。

动作 do 只能写「攻击」「防御」,或「道具:道具名」,如「道具:不死鸟之尾」「道具:恢复药」。
这一作的魔法和特技暂时不能写进规则表:桥插件在这几作里读不到战斗中的魔法列表。
道具名可能不同,以游戏里的道具名为准。

写表前先看事实单的敌人档案,必须做到:
- 至少两个人能复活,或者背包里有足够的不死鸟之尾;不够就写进 ask_up。
- 有回复手段;档案里会造成的每种状态都要有对策,而且背包里真有对应的道具。
- 档案里标了反击、变身、吸收的,要用阶段或对策提到它。
- 每条规则用到的指令,行动的人现在真的有;换过职业的按事实单现在的职业写。

走法说明:
- 从事实单的地图记录里找这张图的那一段,写清楚机关顺序、传送带会把人带到哪、先拿哪些宝箱、出口在哪。
- 300 字以内,只写这张图。

只交结构化结果,不要在结果里重复事实单。`;
}

/** The shape the plugin hands to `ctx.tools.register`, still OpenAI's function format. */
export interface GameToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

const TOOLS_BASE = [
  {
    type: "function",
    function: {
      name: "go",
      description:
        '去一个地方。to 给地图号(62、"地图 62")、地图名的一部分("图尔村"),' +
        '或坐标([12, 8]、"12,8")。' +
        "给地图时按地图记录自己排路线,每离开一张图都检查完成度,可以经过世界地图(步行或骑飞龙);" +
        "名字对上多张会列出来让你挑,不走、不猜。" +
        "给坐标时在当前地图走过去;世界地图上坐船会自动走海路,骑飞龙去入口会自动降落。" +
        "坐标只用在没有名字的地方,不要用坐标一段一段地挪。" +
        "穿过打不过的区域时带 flee: true,路上遇敌先逃跑,逃不了才按策略表打。" +
        "结果列出走过的每一跳、停在哪、为什么停和没走通的出口。",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: ["integer", "string", "array"],
            items: { type: "integer" },
            description: '地图号、地图名的一部分,或坐标 [x, y] / "x,y"',
          },
          by_ship: {
            type: "boolean",
            description: "只在判断不出是否坐船时用:true 走海路,false 步行",
          },
          leave_incomplete: {
            type: "string",
            description: "本图没完成却确实要离开时的具体理由;不带就拒绝",
          },
          flee: {
            type: "boolean",
            description: "路上遇敌先逃跑,逃不了才按策略表打;穿过打不过的区域时用",
          },
        },
        required: ["to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explore",
      description:
        "在当前地图上找本档没去过的地方:按图内能走到的路程挑最近的、去向是本档没去过的地图的出口," +
        "走过去并进去;当前图没有这种出口,就先 go 到最近的、有这种出口的地图再找。" +
        "到了新地图会附上 look_around 摘要。迷宫里探路用它,不要自己一张图一张图地试。" +
        "穿过打不过的区域时带 flee: true,路上遇敌先逃跑,逃不了才按策略表打。",
      parameters: {
        type: "object",
        properties: {
          flee: {
            type: "boolean",
            description: "路上遇敌先逃跑,逃不了才按策略表打;穿过打不过的区域时用",
          },
          leave_incomplete: {
            type: "string",
            description: "本图没完成却确实要离开时的具体理由;不带就拒绝",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "terrain",
      description:
        "查看玩家周围的地图:世界地图上是地形;城镇、迷宫和运河里是能走的格子和墙," +
        "标出入口、宝箱、NPC、物体和事件触发点。不知道往哪走时先看它。",
      parameters: {
        type: "object",
        properties: {
          radius: { type: "integer", description: "半径,4 到 24,默认 12" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "entrances",
      description: "列出当前地图的入口(城镇、洞窟、建筑、楼梯):格子坐标、通往的地图编号。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "guide",
      description:
        "查攻略(Steam 社区完整攻略、图鉴、ludo.guide):地区(中文名即可,如 沃尔斯塔)、" +
        "怪物(图鉴编号或英文名)、首领、道具。返回该地区的流程、商店、怪物、首领弱点和打法。" +
        "进新地区、写战斗策略、遇到打不过的敌人之前先查。太长会分段,用 part 看后面。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "地区名、怪物英文名或图鉴编号" },
          part: { type: "integer", description: "第几段,默认 1" },
          kind: {
            type: "string",
            enum: ["area", "shop", "treasure"],
            description:
              "area 全部(默认);shop 只看城镇商店卖的道具、装备、魔法和价格;" +
              "treasure 只看宝箱和可拾取物品(罐子、木桶、隐藏点)在哪",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_tactics",
      description:
        "给当前地图的普通战斗写 2–3 套规则表(主策略和备用策略),写法和 fight 的规则表一样。" +
        "针对这张地图出现的怪物来写:弱点属性、会用的状态异常、血多的敌人怎么打。" +
        "「最强」会避开怪物吸收、无效的属性并优先弱点;条件可以写 enemy.weak.冰、" +
        "enemy.absorbs.冰。" +
        "普通战斗先用第 1 套;打得不好(有人倒下、全队 HP 低于 40%、全灭)会自动换下一套。",
      parameters: {
        type: "object",
        properties: {
          tables: {
            type: "array",
            description: "几套规则表,每套是 {角色名: [规则...]}",
            items: { type: "object" },
          },
          map: {
            type: "integer",
            description: "给哪张地图写(地图号),不填就是当前地图;可以进图之前先写好",
          },
        },
        required: ["tables"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "board",
      description: "走回飞龙停的地方(上次降落点)骑上它。要去远处、过海时用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "land",
      description:
        "骑着飞龙时,在当前位置降落并下来步行。只能落在平地上;" +
        "要进城镇、城堡,先飞到入口旁边的平地降落,再 go 走进去。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "optimize_equipment",
      description:
        "给每个人用菜单里的「最强装备」,买了新武器防具以后用。只在地图上(不在战斗、商店里)。" +
        "结果里列出每个人换了什么。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "atlas",
      description:
        "列出地图记录里的地图、每张图的出口通往哪张地图、那张地图本档去过没有,以及看到过的宝箱。" +
        "迷宫里找路时先看它:优先走「没去过」的出口,不要回到已经搜过的房间。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "look_around",
      description:
        "列出当前地图上的入口(楼梯、门)、宝箱、NPC 和有名字的物体(闸门、机关),带格子坐标。" +
        "迷宫和城镇里用它找路和找宝箱。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "interact",
      description:
        "打开某个格子上的宝箱、调查物体或和 NPC 说话:" +
        "自动走到它旁边、转向它、按确认并翻完对话。",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          leave_incomplete: {
            type: "string",
            description: "一次性地点没完成却要踩剧情/首领事件格时的具体理由;不带就拒绝",
          },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "advance_story",
      description: "按阅读速度翻剧情对话,直到可以自由行动、出现选项或进入战斗。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "choose",
      description: "在出现的选项里选择第 index 项(从 0 开始,0 是最上面)。",
      parameters: {
        type: "object",
        properties: { index: { type: "integer" } },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fight",
      description:
        "打首领战:交一张规则表,代码照表一直打到战斗结束,中途不再问你。" +
        "每个角色一组规则,从上往下,第一条条件成立、而且做得到的就执行" +
        "(没学会的魔法、MP 不够、没有倒下的人可以复活,都算做不到,跳到下一条)。" +
        '每人最后一条必须不带条件,比如 {"do": "攻击"}。' +
        "条件词汇:self.hp、self.hp_pct、self.mp、" +
        "ally.hp_pct(活着的同伴里最低的 HP 百分比)、" +
        "ally.dead(倒下人数)、party.alive、enemy.count、enemy.boss、enemy.hp_pct、turn、" +
        "item.道具名(持有数量,如 item.不死鸟之尾)、" +
        "enemy.id.编号(有几只活敌人是这个编号,如 enemy.id.282);" +
        "ally.status.状态名(有该状态的人数,如 ally.status.麻痹);" +
        "写成「名字 比较符 数字」,多个条件用 and 连接。" +
        "do:「攻击」「防御」,或「指令:魔法名」如「白魔法:治疗」「黑魔法:闪雷」," +
        "或「道具:道具名」如「道具:不死鸟之尾」(复活)、「道具:恢复药」。" +
        "魔法名后加 + 表示用这一系里学会的、MP 够的最高级,如「白魔法:治疗+」(会用救疗);" +
        "「黑魔法:最强」用最高级的攻击魔法(烈炎、冰冻、震雷)。买了新魔法就改用它们。" +
        "状态异常都要有对应规则:毒→白魔法:解毒 或 道具:解毒药;黑暗→道具:眼药;" +
        "石化→道具:金针;青蛙→道具:少女之吻;目标写「状态:黑暗」这类。" +
        "target:敌人(默认)、自己、hp最低的同伴、倒下的同伴、状态:毒(有这个状态的同伴)。" +
        '状态异常要写对应的规则,如 {"if": "ally.status.毒 >= 1", ' +
        '"do": "白魔法:解毒", "target": "状态:毒"}。' +
        "只能用角色自己职业的指令:白魔法师用白魔法,黑魔法师用黑魔法。" +
        "「最强」和「X+」会看当前目标的属性:避开它吸收、无效的属性,优先打弱点;" +
        "写死的属性魔法碰上吸收也会跳过、交给下一条规则。" +
        "条件里可以用 enemy.weak.冰(有几只敌人弱冰)、enemy.absorbs.冰(有几只敌人吸收冰)、" +
        "enemy.id.282(有几只活敌人是这个编号;变身、合翅膀时编号会变)。" +
        "表不完整会被退回并说明原因。",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "object",
            description:
              '角色名 → 规则列表,如 {"蕾娜": [{"if": "ally.hp_pct < 50", ' +
              '"do": "白魔法:治疗", "target": "hp最低的同伴"}, {"do": "攻击"}], ' +
              '"法利斯": [{"if": "self.mp >= 4", "do": "黑魔法:闪雷"}, ' +
              '{"do": "攻击"}]}',
            additionalProperties: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  if: { type: "string" },
                  do: { type: "string" },
                  target: { type: "string" },
                },
                required: ["do"],
              },
            },
          },
        },
        required: ["plan"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grind",
      description:
        "在附近刷怪,代码自动来回走、遇敌按本图策略打、状态差回旅店住店,中间不问模型。" +
        "until_gold、until_level、until_bestiary 至少要给一个,否则拒绝执行。" +
        "until_bestiary 按概率自己定预算:以后还会出现的怪刷一阵(默认最多 15 场)没遇到就停下、" +
        "自动记欠账,可以直接离开;会错过的怪一直刷到上限(默认 40 分钟),停下后由你决定。" +
        "max_minutes 只是总时长上限。默认最多刷 20 分钟;结果报告刷了多久、打了几场、赚了多少钱、" +
        "升了几级、本档图鉴新登记了哪些怪、用掉的道具、住了几次店和为什么停。" +
        "钱不够或本图鉴没齐时优先用它,不要用 go 一格一格地走。",
      parameters: {
        type: "object",
        properties: {
          until_gold: { type: "integer", description: "钱攒到多少就停" },
          until_level: { type: "integer", description: "全队最低等级到几级就停" },
          until_bestiary: {
            type: "boolean",
            description: "true:刷到本图(世界地图是当前区域)的怪都进本档图鉴",
          },
          max_minutes: { type: "number", description: "最多刷多少分钟,默认 20" },
          rest_hp_pct: {
            type: "number",
            description: "全队最低 HP 百分比低于多少就回店,默认 40",
          },
          rest_mp_pct: {
            type: "number",
            description: "全队最低 MP 百分比低于多少就回店,默认 25",
          },
          inn: {
            type: ["integer", "string"],
            description: "去哪住店(地图号或地图名);不填就用地图记录里最近、有旅店的城镇",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sell",
      description:
        "在已经打开的武器店、防具店、道具店把背包里的东西卖掉换钱(魔法店不收)。" +
        "卖没人再用的旧装备、多余的装备;别卖还装着的、以后换职业可能要用的强装备," +
        "也别卖贵重物品。卖之前用 inventory 看背包。",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "背包里的物品名" },
          count: { type: "integer", description: "数量,默认 1" },
        },
        required: ["item"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shop_gear",
      description:
        "在已经打开的商店里,把每件武器、防具逐个看一遍:谁能装备、谁装上会更强、谁已经装着。" +
        "买装备前先用它,只给装上会更强的人买,数量按人数。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "buy",
      description:
        "在已经打开的商店里买东西(先用 interact 和店员说话打开商店)。" +
        "按商品名找,买完留在商店里;买完用 leave_menu 离开。",
      parameters: {
        type: "object",
        properties: { product: { type: "string" }, count: { type: "integer" } },
        required: ["product"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cast",
      description:
        "在地图上(不在战斗里)用魔法,比如让白魔法师用「治疗」给受伤的人回 HP," +
        "省得回旅店。会自己打开菜单、选人、选魔法、选对象,用完退出菜单。",
      parameters: {
        type: "object",
        properties: {
          caster: { type: "string", description: "施法的人" },
          spell: { type: "string", description: "魔法名,如 治疗" },
          target: { type: "string", description: "对谁用,不写就是施法者自己" },
        },
        required: ["caster", "spell"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "use_item",
      description:
        "在地图上给某人用道具，比如用眼药治黑暗、用解毒药治毒。" +
        "会自己打开菜单、找到道具、选人、用掉,用完退出菜单。",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "道具名,如 眼药、解毒药" },
          target: { type: "string", description: "对谁用" },
        },
        required: ["item", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "change_job",
      description:
        "在地图上给某人换职业,会自己打开菜单、选人、在职业网格里找到这个职业并确认。" +
        "换职业会卸下原有装备,工具会自动换上最强的;魔法是全队共用的,换了职业就能放那一类魔法。",
      parameters: {
        type: "object",
        properties: {
          member: { type: "string", description: "换职业的人" },
          job: { type: "string", description: "职业名,如 时魔法师" },
        },
        required: ["member", "job"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "leave_menu",
      description: "退出商店、菜单等界面,回到可以走动的状态。误进商店时用它。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "save_game",
      // Filled in by `toolSchemas`: the configured slot, not a hard-coded 3 (task 26).
      description:
        "存档到 {saveSlot} 号存档位。只能在世界地图或存档点用,迷宫里不行。首领战前先存档。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "inventory",
      description: "查看背包里的道具和贵重物品(钥匙等剧情物品在贵重物品里)。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "记下一条之后还要用的发现。笔记会保存下来,以后每次运行都会看到。",
      parameters: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "删掉一条错的或过时的笔记(编号从 1 开始,见提示里「你记下的」)。",
      parameters: {
        type: "object",
        properties: { index: { type: "integer" } },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "结束这次游玩。",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "做成了什么,没做成什么" },
        },
        required: ["summary"],
      },
    },
  },
] as const;

/**
 * The tool definitions with save_game naming the slot this game writes (task 26). The slot is
 * a config value, so the list cannot stay one exported constant.
 */
export function toolSchemas(saveSlot: number): readonly GameToolSchema[] {
  return TOOLS_BASE.map((tool) =>
    tool.function.name === "save_game"
      ? {
          ...tool,
          function: {
            ...tool.function,
            description: tool.function.description.replace("{saveSlot}", String(saveSlot)),
          },
        }
      : tool,
  );
}

/** FF5's tools with the shared default slot, for callers that already know the game. */
export const TOOLS: readonly GameToolSchema[] = toolSchemas(20);

/**
 * The extra tool the five newly started games get (task 22): a menu no other tool understands,
 * like FF2's keyword menu next to a dialog. FF5's tool list stays exactly as ported.
 */
export const PRESS_TOOL = {
  type: "function",
  function: {
    name: "press",
    description:
      "按手柄键。只在其他工具都处理不了的界面上用(比如 FF2 对话旁的「询问/记忆/贵重物品/离开」菜单)," +
      "按完会返回当前状态。",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          description: "1–6 个按键,依次按下",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "string",
            enum: [
              "Enter",
              "Backspace",
              "Up",
              "Down",
              "Left",
              "Right",
              "Tab",
              "PadStart",
              "PadWest",
            ],
          },
        },
      },
      required: ["keys"],
    },
  },
} as const;

/** Python's str() for the loose JSON in a battle or party entry. */
function pyText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/** Symbol grid with axis labels and a legend, the player marked @. */
export function renderTerrain(cells: CellGrid): string {
  const [x0, y0] = cells.origin;
  const [cx, cy] = cells.center;
  const rows = cells.attr;
  const width = rows[0]?.length ?? 0;
  const special = new Map<number, string>();
  const lines: string[] = [];
  const tens = Array.from({ length: width }, (_, i) => {
    const x = x0 + i;
    return floorMod(x, 10) === 0 ? String(floorMod(floorDiv(x, 10), 10)) : " ";
  }).join("");
  lines.push("      " + tens);
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j] ?? [];
    const out: string[] = [];
    for (let i = 0; i < row.length; i++) {
      const value = row[i] ?? null;
      if (x0 + i === cx && y0 + j === cy) {
        out.push("@");
      } else if (value !== null && TERRAIN.has(value)) {
        out.push(TERRAIN.get(value)?.[0] ?? "?");
      } else if (value === null) {
        out.push("?");
      } else {
        let mark = special.get(value);
        if (mark === undefined) {
          mark = "0123456789BCDEGIJKLMNOQRSTUVWXYZ"[special.size % 32] ?? "?";
          special.set(value, mark);
        }
        out.push(mark);
      }
    }
    lines.push(String(y0 + j).padStart(5) + " " + out.join(""));
  }
  const legend = [...TERRAIN.values()].map(([symbol, name]) => `${symbol} ${name}`);
  legend.push(
    ...[...special.entries()].map(
      ([code, mark]) => `${mark} 特殊格(编码 ${code},可能是城镇、洞窟或建筑入口)`,
    ),
  );
  const head = `地形图:左上角是格子 (${x0},${y0}),@ 是你 (${cx},${cy})。每个字符一格,第一行标出 x 的十位。`;
  return [head, ...lines, "图例:" + legend.join(";")].join("\n");
}

export const FLOOR_MARKS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["GotoMap", ["E", "入口/楼梯/出口"]],
  ["TresureBox", ["T", "宝箱"]],
  ["Npc", ["N", "NPC"]],
  ["DefaultEntity", ["O", "有名字的物体(门、机关、碎片)"]],
  ["Event", ["!", "事件触发点"]],
  ["DefaultAnimEntity", ["O", "有名字的物体(门、机关、碎片)"]],
  ["PointIn", ["F", "落下点(会掉到别处)"]],
  ["OpenTrigger", ["D", "门(走上去或顶到就会开)"]],
  ["TileAnimRegion", ["D", "门(走上去或顶到就会开)"]],
]);

/**
 * A town or dungeon around the player, drawn from the height the player stands on (see
 * nav.layeredView): . floor here, : floor on another height, > a "3" half-wall (walled on
 * its right), < a "5" (walled on its left), ^ a "2" (walled above), v a "4" (walled below),
 * = a ToLayer/stair height change, # wall, @ you, and the letters of FLOOR_MARKS where
 * entities stand. `marks` is keyed with nav.cellKey.
 */
export function renderFloor(
  view: { readonly center: readonly [number, number]; readonly rows: readonly string[] },
  radius: number,
  marks: ReadonlyMap<string, string>,
): string {
  const [cx, cy] = view.center;
  const rows = view.rows;
  const x0 = Math.max(cx - radius, 0);
  const x1 = Math.min(cx + radius, (rows[0]?.length ?? 0) - 1);
  const y0 = Math.max(cy - radius, 0);
  const y1 = Math.min(cy + radius, rows.length - 1);
  const tens = Array.from({ length: Math.max(x1 - x0 + 1, 0) }, (_, i) => {
    const x = x0 + i;
    return floorMod(x, 10) === 0 ? String(floorMod(floorDiv(x, 10), 10)) : " ";
  }).join("");
  const lines = ["      " + tens];
  for (let y = y0; y <= y1; y++) {
    const out: string[] = [];
    const row = rows[y] ?? "";
    for (let x = x0; x <= x1; x++) {
      if (x === cx && y === cy) {
        out.push("@");
      } else {
        const mark = marks.get(cellKey(x, y));
        out.push(mark ?? row[x] ?? "");
      }
    }
    lines.push(String(y).padStart(5) + " " + out.join(""));
  }
  // Python's dict(FLOOR_MARKS.values()) collapses equal (mark, name) pairs; keep the first
  // occurrence so the O and ! entries are listed once.
  const legendEntries: string[] = [];
  const seen = new Set<string>();
  for (const [mark, name] of FLOOR_MARKS.values()) {
    const key = `${mark}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    legendEntries.push(`${mark} ${name}`);
  }
  // 11-03, Fire-Powered Ship 261: 2/3/4/5 are half-cell walls, not whole walls, so the map
  // has to name the side they close; "=" is only a ToLayer/stair height change.
  const legend =
    ". 你这一层能走;: 另一层(高台或低处)能走;" +
    "> 半边墙(挡右边);< 半边墙(挡左边);^ 半边墙(挡上边);v 半边墙(挡下边);" +
    "= 换层格(楼梯、通风口等,只能在这里换层);H 洞口/会塌的地板(会掉到下面);" +
    "# 墙;B 传送带(踩上会被带走);" +
    legendEntries.join(";");
  const head = `地图:左上角是格子 (${x0},${y0}),@ 是你 (${cx},${cy})。每个字符一格,第一行标出 x 的十位。`;
  return [head, ...lines, "图例:" + legend].join("\n");
}

/** Both sides; our side with each one's job and MP, since what they can do depends on it. */
export function describeBattle(
  battle: unknown,
  party?: readonly unknown[] | null,
  elements?: ElementKnowledge | null,
): string {
  const source =
    typeof battle === "object" && battle !== null && !Array.isArray(battle) ? (battle as Json) : {};
  const jobs = new Map<unknown, Json>();
  for (const member of party ?? []) {
    if (typeof member === "object" && member !== null && !Array.isArray(member)) {
      const row = member as Json;
      jobs.set(row.name, row);
    }
  }
  const enemies = Array.isArray(source.enemies) ? source.enemies : [];
  const lines = [
    "敌人:" +
      enemies
        .map((unit) => {
          const row =
            typeof unit === "object" && unit !== null && !Array.isArray(unit) ? (unit as Json) : {};
          const known = elements?.lookup(row) ?? null;
          const notes = known === null ? "" : `(${describeElements(known)})`;
          return `${pyText(row.name)} HP ${pyText(row.hp)}/${pyText(row.maxHp)}${notes}`;
        })
        .join(","),
  ];
  const ours: string[] = [];
  const players = Array.isArray(source.players) ? source.players : [];
  for (const unit of players) {
    const row =
      typeof unit === "object" && unit !== null && !Array.isArray(unit) ? (unit as Json) : {};
    const info = jobs.get(row.name) ?? {};
    const job = truthy(info.jobName) ? `(${pyText(info.jobName)})` : "";
    const names = statuses(row);
    const status = names.length > 0 ? ` [${names.join("、")}]` : "";
    ours.push(
      `${pyText(row.name)}${job} HP ${pyText(row.hp)}/${pyText(row.maxHp)} MP ${pyText(row.mp)}${status}`,
    );
  }
  lines.push("我方:" + ours.join(","));
  return lines.join("\n");
}

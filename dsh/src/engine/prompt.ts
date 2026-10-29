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
- tactics:1–3 套规则表。每套写成 {角色名: [规则, ...]},规则是 {if?, do, target?}。
  第 1 套是主策略,后面是备用。普通战斗先用第 1 套,打得不好代码会换下一套。
- walker_notes:给第一层玩家的走法说明,300 字以内。
- ask_up:给第一层玩家的建议(比如缺眼药,回卡纳克买),没有就填空串。
  可以在 ask_up 里建议换职业:写清楚谁换成什么、为什么。

规则表的写法:
- 每个角色一组规则,从上往下检查;第一条条件成立、而且做得到的规则就执行。
  做不到的规则会被跳过(没学会的魔法、MP 不够、没有倒下的人可以复活,都算做不到)。
- 每个人最后一条必须不带条件,写 {"do": "攻击"} 这样的兜底;没有兜底的规则表会被退回。
- 先说复活、回复、治状态,最后再攻击。复活优先用白魔法:复活或道具:不死鸟之尾;
  回复用白魔法:治疗(或 治疗+),治状态用对应的魔法或道具。
- 条件词汇:self.hp、self.hp_pct、self.mp、ally.hp_pct(活着的同伴里最低的 HP 百分比)、
  ally.dead(倒下人数)、party.alive、enemy.count、enemy.boss、enemy.hp_pct、turn、
  item.道具名(持有数量,如 item.不死鸟之尾)、
  enemy.name.怪名(有几只活着的敌人叫这个名字,如 enemy.name.喧嚣鬼)、
  ally.status.状态名(有该状态的人数,如 ally.status.麻痹)、self.status.状态名。
  写成「名字 比较符 数字」,多个条件用 and 连接。
- do:「攻击」「防御」,或「指令:魔法名」,如「白魔法:治疗」「黑魔法:闪雷」,
  或「道具:道具名」,如「道具:不死鸟之尾」(复活)、「道具:恢复药」。
  魔法名后加 + 表示用这一系里学会的、MP 够的最高级,如「白魔法:治疗+」(会用救疗);
  「黑魔法:最强」用最高级的攻击魔法(烈炎、冰冻、震雷)。
- target:敌人(默认)、自己、hp最低的同伴、倒下的同伴、状态:毒(有这个状态的同伴)、
  敌人:怪名(第一只叫这个名字的活敌人,如 敌人:喧嚣鬼)、敌人:hp最低、
  敌人:弱冰(第一只弱冰的活敌人)。
  治状态要写对应的 target,如 {"if": "ally.status.毒 >= 1", "do": "白魔法:解毒", "target": "状态:毒"}。
- 只能用角色自己职业的指令:白魔法师用白魔法,黑魔法师用黑魔法;其他职业用攻击、防御或道具。
- 事实单里列了会的法术时,规则表可以直接写具体法术(如「白魔法:救疗」);「最强」「X+」照样能用。
- 「最强」和「X+」会看当前目标的属性:避开它吸收、无效的属性,优先打弱点;
  写死的属性魔法碰上吸收也会跳过、交给下一条规则。
- 条件里可以用 enemy.weak.冰(有几只敌人弱冰)、enemy.absorbs.冰(有几只敌人吸收冰)。
  属性词汇:火、冰、雷、水、风、土、圣、毒。
- 用事实单里的弱点和攻略说明写;敌人吸收的属性不要用。治状态要的道具包里没有,就写进 ask_up。
- 遇敌表里各种怪的弱点、吸收不一样时,用 enemy.name.X 和 敌人:X 分开写;
  绝不用某只怪吸收的属性打它。某只怪什么法术都打不动,就写物理攻击或道具,目标写 敌人:X。
- 状态异常都要有对应规则:毒→白魔法:解毒 或 道具:解毒药;黑暗→道具:眼药;
  石化→道具:金针;青蛙→道具:少女之吻;迷你→道具:木槌;沉默→道具:回音草。

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
- 移动用 walk_to(步行)或 go_to(可选坐船):都会自动寻路,绕开墙壁和障碍。
- 世界地图上用 terrain 看周围地形,用 entrances 找入口。
- 走进入口所在的格子就会进入对应的地图。
- 船在海上能走;船开到岸边再往陆地走就会下船;回到停船的格子就会上船。
- 骑飞龙时状态行会写「骑着飞龙」:walk_to/go_to 飞过海和森林,飞不过山。目标是城镇、城堡、
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
  enemy.name.喧嚣鬼(有几只活敌人叫这个名字);目标可以写敌人:喧嚣鬼、敌人:hp最低、敌人:弱冰。
- 首领战由战术官写表、代码照表打完(配置关掉 tacticianBoss 时才会停下来让你用 fight 交表)。
- set_tactics 和 fight 只在你要手动改策略时用;普通战斗和首领战默认都交给战术官。
- 迷宫、城镇和运河里,terrain 画出能走的格子(.)和墙(#),以及入口、宝箱和事件触发点(!);
  用 look_around 看它们的名字和坐标,再用 walk_to 走过去。目标坐标要选在能走的格子上。
- 宝箱在 look_around 里写作 TresureBox。用 interact 给出宝箱的坐标就会自动打开。
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
- 迷宫里用 atlas 看去过的地图和出口:look_around 也会给出口标「去过/没去过」,优先走没去过的。
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
  /^- 中文版的魔法名/u,
  /^- 魔法要先在魔法店/u,
];

function dropLines(text: string, patterns: readonly RegExp[]): string {
  return text
    .split("\n")
    .filter((line) => !patterns.some((pattern) => pattern.test(line)))
    .join("\n");
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
    .replace(";笔记里有攻略查到的提醒。", "。")
    .replace(
      "{hint}",
      `存档只写 ${saveSlot} 号存档位;游戏已经开好新游戏、过了起名,` +
        "从现在的位置开始玩;第一次能存档时就用 save_game 存档。\n{hint}",
    );
  text = dropLines(text, FF5_ONLY_SYSTEM_LINES);
  return text;
}

/** FF5 writes slot 3; the five games that started fresh write slot 20 (task 21). */
function saveSlotFor(game: string): number {
  return byKey(game).key === "ff5" ? 3 : 20;
}

/** The first layer's persona for one game; FF5's text is byte-for-byte the old constant. */
export function systemPrompt(game: string, saveSlot = saveSlotFor(game)): string {
  const info = byKey(game);
  if (info.key === "ff5") return SYSTEM_PROMPT_FF5;
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
  const text = TACTICIAN_PROMPT_FF5.replace(
    "你是《最终幻想5 像素重制版》的战术官",
    `你是《${name} 像素重制版》的战术官`,
  )
    .replace(
      "你不走路、不按键、不操作游戏:读事实单,按需用 guide 查攻略,用 atlas 看走过的地图,\n" +
        "然后交回结构化结果。",
      "你不走路、不按键、不操作游戏:读事实单,按需用 atlas 看走过的地图," + "然后交回结构化结果。",
    )
    .replace("  可以在 ask_up 里建议换职业:写清楚谁换成什么、为什么。\n", "")
    .replace("(比如缺眼药,回卡纳克买)", "(比如缺眼药,回城买)")
    .replace(
      "  做不到的规则会被跳过(没学会的魔法、MP 不够、没有倒下的人可以复活,都算做不到)。",
      "  做不到的规则会被跳过(没有这种指令、没有这种道具、没有倒下的人可以复活,都算做不到)。",
    )
    .replace(
      "- 先说复活、回复、治状态,最后再攻击。复活优先用白魔法:复活或道具:不死鸟之尾;\n" +
        "  回复用白魔法:治疗(或 治疗+),治状态用对应的魔法或道具。",
      "- 先说复活、回复、治状态,最后再攻击。复活用道具:不死鸟之尾;" + "回复和治状态都用道具。",
    )
    .replace(
      "- do:「攻击」「防御」,或「指令:魔法名」,如「白魔法:治疗」「黑魔法:闪雷」,\n" +
        "  或「道具:道具名」,如「道具:不死鸟之尾」(复活)、「道具:恢复药」。\n" +
        "  魔法名后加 + 表示用这一系里学会的、MP 够的最高级,如「白魔法:治疗+」(会用救疗);\n" +
        "  「黑魔法:最强」用最高级的攻击魔法(烈炎、冰冻、震雷)。",
      "- do 只能写「攻击」「防御」,或「道具:道具名」,如「道具:不死鸟之尾」(复活)、" +
        "「道具:恢复药」。\n" +
        "  这一作的魔法和特技暂时不能写进规则表:桥插件在这几作里读不到战斗中的魔法列表。",
    )
    .replace(
      "- target:敌人(默认)、自己、hp最低的同伴、倒下的同伴、状态:毒(有这个状态的同伴)、\n" +
        "  敌人:怪名(第一只叫这个名字的活敌人,如 敌人:喧嚣鬼)、敌人:hp最低、\n" +
        "  敌人:弱冰(第一只弱冰的活敌人)。",
      "- target:敌人(默认)、自己、hp最低的同伴、倒下的同伴、状态:毒(有这个状态的同伴)、\n" +
        "  敌人:怪名(第一只叫这个名字的活敌人,如 敌人:喧嚣鬼)、敌人:hp最低。",
    )
    .replace(
      "- 只能用角色自己职业的指令:白魔法师用白魔法,黑魔法师用黑魔法;其他职业用攻击、防御或道具。\n" +
        "- 事实单里列了会的法术时,规则表可以直接写具体法术(如「白魔法:救疗」);" +
        "「最强」「X+」照样能用。\n" +
        "- 「最强」和「X+」会看当前目标的属性:避开它吸收、无效的属性,优先打弱点;\n" +
        "  写死的属性魔法碰上吸收也会跳过、交给下一条规则。\n" +
        "- 条件里可以用 enemy.weak.冰(有几只敌人弱冰)、enemy.absorbs.冰(有几只敌人吸收冰)。\n" +
        "  属性词汇:火、冰、雷、水、风、土、圣、毒。\n" +
        "- 用事实单里的弱点和攻略说明写;敌人吸收的属性不要用。治状态要的道具包里没有," +
        "就写进 ask_up。\n" +
        "- 遇敌表里各种怪的弱点、吸收不一样时,用 enemy.name.X 和 敌人:X 分开写;\n" +
        "  绝不用某只怪吸收的属性打它。某只怪什么法术都打不动,就写物理攻击或道具," +
        "目标写 敌人:X。",
      "- 遇敌表里各种怪不一样时,用 enemy.name.X 和 敌人:X 分开写。",
    )
    .replace('"do": "白魔法:解毒"', '"do": "道具:解毒药"')
    .replace(
      "- 状态异常都要有对应规则:毒→白魔法:解毒 或 道具:解毒药;黑暗→道具:眼药;\n" +
        "  石化→道具:金针;青蛙→道具:少女之吻;迷你→道具:木槌;沉默→道具:回音草。",
      "- 状态异常都要有对应规则,用道具治:毒→道具:解毒药;黑暗→道具:眼药;\n" +
        "  石化→道具:金针;青蛙→道具:少女之吻;迷你→道具:木槌;沉默→道具:回音草。\n" +
        "  这几作的道具名可能不同,以游戏里的道具名为准。",
    )
    .replace(
      "- 从事实单的攻略里找这张图的那一段,写清楚:机关和开关的顺序、传送带会把人带到哪、",
      "- 从事实单的地图记录里找这张图的那一段,写清楚:机关和开关的顺序、传送带会把人带到哪、",
    );
  return dropLines(text, [/^ {2}可以在 ask_up 里建议换职业/u]);
}

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "walk_to",
      description: "步行到指定格子,自动寻路绕开墙壁;途中遇敌自动战斗,遇到剧情会停下。",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "目标格子 x" },
          y: { type: "integer", description: "目标格子 y" },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_to",
      description:
        "在世界地图上自动寻路前往某个格子,途中遇敌自动战斗。目标太远时会分几段走。" +
        "坐船时 by_ship 填 true(只走海),步行填 false(不走海和山)。",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          by_ship: { type: "boolean" },
        },
        required: ["x", "y", "by_ship"],
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
        "要进城镇、城堡,先飞到入口旁边的平地降落,再 walk_to 走进去。",
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
        "列出去过的地图、每张图的出口通往哪张地图、那张地图去过没有,以及看到过的宝箱。" +
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
        properties: { x: { type: "integer" }, y: { type: "integer" } },
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
        "条件里可以用 enemy.weak.冰(有几只敌人弱冰)、enemy.absorbs.冰(有几只敌人吸收冰)。" +
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
      description: "存档到 3 号存档位。只能在世界地图或存档点用,迷宫里不行。首领战前先存档。",
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
  ["PointIn", ["!", "事件触发点"]],
]);

/**
 * A town or dungeon around the player, drawn from the height the player stands on (see
 * nav.layeredView): . floor here, : floor on another height, = stairs, # wall, @ you, and
 * the letters of FLOOR_MARKS where entities stand. `marks` is keyed with nav.cellKey.
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
  const legend =
    ". 你这一层能走;: 另一层(高台或低处)能走,要经楼梯(=)才上得去或下得来;" +
    "= 楼梯(只能上下走);# 墙;" +
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

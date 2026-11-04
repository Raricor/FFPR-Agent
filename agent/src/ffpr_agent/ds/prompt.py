"""What DeepSeek is told: the system prompt, the tool definitions, and text renderings
of terrain and battles."""

from ffpr_agent.skills.gambit import statuses

# World-map cell attribute -> symbol, as seen on FF5's map 1 (P0b, 2026-10-20).
TERRAIN = {
    16: ("~", "海(船能走,步行不能走)"),
    19: ("^", "山(不能走)"),
    27: ("A", "雪山(不能走)"),
    3: (".", "草地"),
    6: ("f", "森林"),
    4: (",", "平原"),
    7: ("h", "丘陵"),
    15: ("p", "沙地"),
}


SYSTEM_PROMPT = """你在玩《最终幻想5 像素重制版》(中文版),通过工具操作游戏。

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
- 普通战斗由代码按默认规则打完:白魔法师复活、治疗 HP 低于一半的人、给中毒的人解毒;
  战后再治疗、解毒。
- 队伍一栏方括号里是状态异常,如「蕾娜 145/285[毒]」;地图上也可以用 cast 解毒。
- 每张地图的普通战斗用你写的策略(set_tactics),没写就用默认规则(只会攻击、治疗、解毒、复活)。
  进入新地图、遇到新怪物时先写策略;全灭会读回最近的存档并换下一套策略。
- 首领战会停下来告诉你敌我状态和每个人的职业,你用 fight 交一张规则表:
  把回复、复活写在前面,攻击写在最后兜底;代码照表打完整场,中途不再问你。
- 迷宫、城镇和运河里,terrain 画出能走的格子(.)和墙(#),以及入口、宝箱和事件触发点(!);
  用 look_around 看它们的名字和坐标,再用 walk_to 走过去。目标坐标要选在能走的格子上。
- 宝箱在 look_around 里写作 TresureBox。用 interact 给出宝箱的坐标就会自动打开。
- 门、闸门、机关这类物体在 look_around 里写作 DefaultEntity,带日文名(如「トルナ運河の開錠_右扉」
  是运河闸门)。走不过去时先看有没有这类物体,用 interact 调查它(钥匙这类道具会自动使用)。
- 菜单里你能做的:存档用 save_game,用魔法回 HP 用 cast(只在地图上)。
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
{hint}"""


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "walk_to",
            "description": "步行到指定格子,自动寻路绕开墙壁;途中遇敌自动战斗,遇到剧情会停下。",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer", "description": "目标格子 x"},
                    "y": {"type": "integer", "description": "目标格子 y"},
                },
                "required": ["x", "y"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "go_to",
            "description": (
                "在世界地图上自动寻路前往某个格子,途中遇敌自动战斗。目标太远时会分几段走。"
                "坐船时 by_ship 填 true(只走海),步行填 false(不走海和山)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                    "by_ship": {"type": "boolean"},
                },
                "required": ["x", "y", "by_ship"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "terrain",
            "description": (
                "查看玩家周围的地图:世界地图上是地形;城镇、迷宫和运河里是能走的格子和墙,"
                "标出入口、宝箱、NPC、物体和事件触发点。不知道往哪走时先看它。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "radius": {"type": "integer", "description": "半径,4 到 24,默认 12"}
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "entrances",
            "description": "列出当前地图的入口(城镇、洞窟、建筑、楼梯):格子坐标、通往的地图编号。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "guide",
            "description": (
                "查攻略(Steam 社区完整攻略、图鉴、ludo.guide):地区(中文名即可,如 沃尔斯塔)、"
                "怪物(图鉴编号或英文名)、首领、道具。返回该地区的流程、商店、怪物、首领弱点和打法。"
                "进新地区、写战斗策略、遇到打不过的敌人之前先查。太长会分段,用 part 看后面。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "地区名、怪物英文名或图鉴编号"},
                    "part": {"type": "integer", "description": "第几段,默认 1"},
                    "kind": {
                        "type": "string",
                        "enum": ["area", "shop", "treasure"],
                        "description": (
                            "area 全部(默认);shop 只看城镇商店卖的道具、装备、魔法和价格;"
                            "treasure 只看宝箱和可拾取物品(罐子、木桶、隐藏点)在哪"
                        ),
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_tactics",
            "description": (
                "给当前地图的普通战斗写 2–3 套规则表(主策略和备用策略),写法和 fight 的规则表一样。"
                "针对这张地图出现的怪物来写:弱点属性、会用的状态异常、血多的敌人怎么打。"
                "普通战斗先用第 1 套;打得不好(有人倒下、全队 HP 低于 40%、全灭)会自动换下一套。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "tables": {
                        "type": "array",
                        "description": "几套规则表,每套是 {角色名: [规则...]}",
                        "items": {"type": "object"},
                    },
                    "map": {
                        "type": "integer",
                        "description": "给哪张地图写(地图号),不填就是当前地图;可以进图之前先写好",
                    },
                },
                "required": ["tables"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "board",
            "description": "走回飞龙停的地方(上次降落点)骑上它。要去远处、过海时用。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "land",
            "description": (
                "骑着飞龙时,在当前位置降落并下来步行。只能落在平地上;"
                "要进城镇、城堡,先飞到入口旁边的平地降落,再 walk_to 走进去。"
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "optimize_equipment",
            "description": (
                "给每个人用菜单里的「最强装备」,买了新武器防具以后用。只在地图上(不在战斗、商店里)。"
                "结果里列出每个人换了什么。"
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "atlas",
            "description": (
                "列出去过的地图、每张图的出口通往哪张地图、那张地图去过没有,以及看到过的宝箱。"
                "迷宫里找路时先看它:优先走「没去过」的出口,不要回到已经搜过的房间。"
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "look_around",
            "description": (
                "列出当前地图上的入口(楼梯、门)、宝箱、NPC 和有名字的物体(闸门、机关),带格子坐标。"
                "迷宫和城镇里用它找路和找宝箱。"
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "interact",
            "description": (
                "打开某个格子上的宝箱、调查物体或和 NPC 说话:"
                "自动走到它旁边、转向它、按确认并翻完对话。"
            ),
            "parameters": {
                "type": "object",
                "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}},
                "required": ["x", "y"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "advance_story",
            "description": "按阅读速度翻剧情对话,直到可以自由行动、出现选项或进入战斗。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "choose",
            "description": "在出现的选项里选择第 index 项(从 0 开始,0 是最上面)。",
            "parameters": {
                "type": "object",
                "properties": {"index": {"type": "integer"}},
                "required": ["index"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fight",
            "description": (
                "打首领战:交一张规则表,代码照表一直打到战斗结束,中途不再问你。"
                "每个角色一组规则,从上往下,第一条条件成立、而且做得到的就执行"
                "(没学会的魔法、MP 不够、没有倒下的人可以复活,都算做不到,跳到下一条)。"
                '每人最后一条必须不带条件,比如 {"do": "攻击"}。'
                "条件词汇:self.hp、self.hp_pct、self.mp、"
                "ally.hp_pct(活着的同伴里最低的 HP 百分比)、"
                "ally.dead(倒下人数)、party.alive、enemy.count、enemy.boss、enemy.hp_pct、turn、"
                "item.道具名(持有数量,如 item.不死鸟之尾)、"
                "ally.status.状态名(有该状态的人数,如 ally.status.麻痹);"
                "写成「名字 比较符 数字」,多个条件用 and 连接。"
                "do:「攻击」「防御」,或「指令:魔法名」如「白魔法:治疗」「黑魔法:闪雷」,"
                "或「道具:道具名」如「道具:不死鸟之尾」(复活)、「道具:恢复药」。"
                "魔法名后加 + 表示用这一系里学会的、MP 够的最高级,如「白魔法:治疗+」(会用救疗);"
                "「黑魔法:最强」用最高级的攻击魔法(烈炎、冰冻、震雷)。买了新魔法就改用它们。"
                "状态异常都要有对应规则:毒→白魔法:解毒 或 道具:解毒药;黑暗→道具:眼药;"
                "石化→道具:金针;青蛙→道具:少女之吻;目标写「状态:黑暗」这类。"
                "target:敌人(默认)、自己、hp最低的同伴、倒下的同伴、状态:毒(有这个状态的同伴)。"
                '状态异常要写对应的规则,如 {"if": "ally.status.毒 >= 1", '
                '"do": "白魔法:解毒", "target": "状态:毒"}。'
                "只能用角色自己职业的指令:白魔法师用白魔法,黑魔法师用黑魔法。"
                "表不完整会被退回并说明原因。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "object",
                        "description": (
                            '角色名 → 规则列表,如 {"蕾娜": [{"if": "ally.hp_pct < 50", '
                            '"do": "白魔法:治疗", "target": "hp最低的同伴"}, {"do": "攻击"}], '
                            '"法利斯": [{"if": "self.mp >= 4", "do": "黑魔法:闪雷"}, '
                            '{"do": "攻击"}]}'
                        ),
                        "additionalProperties": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "if": {"type": "string"},
                                    "do": {"type": "string"},
                                    "target": {"type": "string"},
                                },
                                "required": ["do"],
                            },
                        },
                    }
                },
                "required": ["plan"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sell",
            "description": (
                "在已经打开的武器店、防具店、道具店把背包里的东西卖掉换钱(魔法店不收)。"
                "卖没人再用的旧装备、多余的装备;别卖还装着的、以后换职业可能要用的强装备,"
                "也别卖贵重物品。卖之前用 inventory 看背包。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "item": {"type": "string", "description": "背包里的物品名"},
                    "count": {"type": "integer", "description": "数量,默认 1"},
                },
                "required": ["item"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shop_gear",
            "description": (
                "在已经打开的商店里,把每件武器、防具逐个看一遍:谁能装备、谁装上会更强、谁已经装着。"
                "买装备前先用它,只给装上会更强的人买,数量按人数。"
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "buy",
            "description": (
                "在已经打开的商店里买东西(先用 interact 和店员说话打开商店)。"
                "按商品名找,买完留在商店里;买完用 leave_menu 离开。"
            ),
            "parameters": {
                "type": "object",
                "properties": {"product": {"type": "string"}, "count": {"type": "integer"}},
                "required": ["product"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cast",
            "description": (
                "在地图上(不在战斗里)用魔法,比如让白魔法师用「治疗」给受伤的人回 HP,"
                "省得回旅店。会自己打开菜单、选人、选魔法、选对象,用完退出菜单。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "caster": {"type": "string", "description": "施法的人"},
                    "spell": {"type": "string", "description": "魔法名,如 治疗"},
                    "target": {"type": "string", "description": "对谁用,不写就是施法者自己"},
                },
                "required": ["caster", "spell"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "leave_menu",
            "description": "退出商店、菜单等界面,回到可以走动的状态。误进商店时用它。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_game",
            "description": (
                "存档到 3 号存档位。只能在世界地图或存档点用,迷宫里不行。首领战前先存档。"
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inventory",
            "description": "查看背包里的道具和贵重物品(钥匙等剧情物品在贵重物品里)。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remember",
            "description": "记下一条之后还要用的发现。笔记会保存下来,以后每次运行都会看到。",
            "parameters": {
                "type": "object",
                "properties": {"note": {"type": "string"}},
                "required": ["note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forget",
            "description": "删掉一条错的或过时的笔记(编号从 1 开始,见提示里「你记下的」)。",
            "parameters": {
                "type": "object",
                "properties": {"index": {"type": "integer"}},
                "required": ["index"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "done",
            "description": "结束这次游玩。",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "做成了什么,没做成什么"}
                },
                "required": ["summary"],
            },
        },
    },
]


def render_terrain(cells: dict) -> str:
    """Symbol grid with axis labels and a legend, the player marked @."""
    x0, y0 = cells["origin"]
    cx, cy = cells["center"]
    rows = cells["attr"]
    width = len(rows[0])
    special: dict[int, str] = {}
    lines = []
    tens = "".join(str((x0 + i) // 10 % 10) if (x0 + i) % 10 == 0 else " " for i in range(width))
    lines.append("      " + tens)
    for j, row in enumerate(rows):
        out = []
        for i, v in enumerate(row):
            if (x0 + i, y0 + j) == (cx, cy):
                out.append("@")
            elif v in TERRAIN:
                out.append(TERRAIN[v][0])
            elif v is None:
                out.append("?")
            else:
                mark = special.setdefault(v, "0123456789BCDEGIJKLMNOQRSTUVWXYZ"[len(special) % 32])
                out.append(mark)
        lines.append(f"{y0 + j:5} " + "".join(out))
    legend = [f"{sym} {name}" for sym, name in TERRAIN.values()]
    legend += [
        f"{mark} 特殊格(编码 {code},可能是城镇、洞窟或建筑入口)" for code, mark in special.items()
    ]
    head = f"地形图:左上角是格子 ({x0},{y0}),@ 是你 ({cx},{cy})。每个字符一格,第一行标出 x 的十位。"
    return "\n".join([head, *lines, "图例:" + ";".join(legend)])


FLOOR_MARKS = {"GotoMap": ("E", "入口/楼梯/出口"), "TresureBox": ("T", "宝箱"), "Npc": ("N", "NPC")}
FLOOR_MARKS |= {
    "DefaultEntity": ("O", "有名字的物体(门、机关、碎片)"),
    "Event": ("!", "事件触发点"),
}
FLOOR_MARKS |= {"DefaultAnimEntity": ("O", "有名字的物体(门、机关、碎片)")}
FLOOR_MARKS |= {"PointIn": ("!", "事件触发点")}


def render_floor(view: dict, radius: int, marks: dict[tuple[int, int], str]) -> str:
    """A town or dungeon around the player, drawn from the height the player stands on (see
    nav.layered_view): . floor here, : floor on another height, = stairs, # wall, @ you, and
    the letters of FLOOR_MARKS where entities stand."""
    cx, cy = view["center"]
    rows = view["rows"]
    x0, x1 = max(cx - radius, 0), min(cx + radius, len(rows[0]) - 1)
    y0, y1 = max(cy - radius, 0), min(cy + radius, len(rows) - 1)
    tens = "".join(str(x // 10 % 10) if x % 10 == 0 else " " for x in range(x0, x1 + 1))
    lines = ["      " + tens]
    for y in range(y0, y1 + 1):
        out = []
        for x in range(x0, x1 + 1):
            if (x, y) == (cx, cy):
                out.append("@")
            elif (x, y) in marks:
                out.append(marks[(x, y)])
            else:
                out.append(rows[y][x])
        lines.append(f"{y:5} " + "".join(out))
    legend = (
        ". 你这一层能走;: 另一层(高台或低处)能走,要经楼梯(=)才上得去或下得来;"
        "= 楼梯(只能上下走);# 墙;"
        + ";".join(f"{m} {name}" for m, name in dict(FLOOR_MARKS.values()).items())
    )
    head = f"地图:左上角是格子 ({x0},{y0}),@ 是你 ({cx},{cy})。每个字符一格,第一行标出 x 的十位。"
    return "\n".join([head, *lines, "图例:" + legend])


def describe_battle(battle: dict, party: list[dict] | None = None) -> str:
    """Both sides; our side with each one's job and MP, since what they can do depends on it."""
    jobs = {p.get("name"): p for p in party or []}
    enemies = battle.get("enemies") or []
    lines = [
        "敌人:" + ",".join(f"{u.get('name')} HP {u.get('hp')}/{u.get('maxHp')}" for u in enemies)
    ]
    ours = []
    for u in battle.get("players") or []:
        info = jobs.get(u.get("name"), {})
        job = f"({info['jobName']})" if info.get("jobName") else ""
        names = statuses(u)
        status = f" [{'、'.join(names)}]" if names else ""
        ours.append(
            f"{u.get('name')}{job} HP {u.get('hp')}/{u.get('maxHp')} MP {u.get('mp')}{status}"
        )
    lines.append("我方:" + ",".join(ours))
    return "\n".join(lines)

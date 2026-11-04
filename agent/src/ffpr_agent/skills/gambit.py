"""Battle rule tables (control plan §4.6): each character has rules, checked top down, and
the first whose condition holds and that can be done right now is done (FF12's Gambits).

    {"蕾娜": [{"if": "ally.hp_pct < 50", "do": "白魔法:治疗", "target": "hp最低的同伴"},
              {"do": "攻击"}],
     "法利斯": [{"if": "self.mp >= 4", "do": "黑魔法:闪雷"}, {"do": "攻击"}]}

Conditions are clauses joined by "and", each `name op number` or a bare name (true when not
0), over a fixed vocabulary (VOCABULARY). A rule that cannot be done (the actor has no such
command, the spell is not learned or MP is short, nobody to revive) is skipped like a false
condition, so the next rule takes over. This module decides; skills/battle.py presses keys.
"""

import operator
import re
from dataclasses import dataclass, field

OPS = {
    "<=": operator.le,
    ">=": operator.ge,
    "==": operator.eq,
    "!=": operator.ne,
    "<": operator.lt,
    ">": operator.gt,
}
CLAUSE = re.compile(r"^\s*([a-z_.一-鿿]+)\s*(?:(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?))?\s*$")

VOCABULARY = {
    "self.hp": "自己的 HP",
    "self.hp_pct": "自己的 HP 百分比",
    "self.mp": "自己的 MP",
    "ally.hp_pct": "活着的同伴(含自己)里最低的 HP 百分比",
    "ally.dead": "倒下的同伴人数",
    "party.alive": "活着的人数",
    "enemy.count": "活着的敌人数",
    "enemy.boss": "是否首领战(1/0)",
    "enemy.hp_pct": "活着的敌人里最低的 HP 百分比",
    "turn": "这个角色第几次行动(从 1 数)",
    "item.<道具名>": "背包里这种道具的数量,如 item.不死鸟之尾",
    "ally.status.<状态>": "有这个状态的同伴人数,如 ally.status.麻痹(桥插件 0.6.3+)",
    "self.status.<状态>": "自己有这个状态时为 1",
}
OPEN_ENDED = ("item.", "ally.status.", "self.status.")  # names that carry a game word

ENEMY, SELF, WEAKEST, FALLEN, AILING = "敌人", "自己", "hp最低的同伴", "倒下的同伴", "状态"
# Written with or without spaces ("hp 最低的同伴"); no target means the game's default.
TARGETS = {"敌人": ENEMY, "": ENEMY, "自己": SELF, "hp最低的同伴": WEAKEST, "倒下的同伴": FALLEN}


def target_of(rule: dict) -> str | None:
    """ENEMY, SELF, WEAKEST, FALLEN, or AILING for 「状态:毒」 (an ally with that status)."""
    text = str(rule.get("target") or "").replace(" ", "")
    if text.startswith("状态:") and len(text) > 3:
        return AILING
    return TARGETS.get(text)


def ailment_of(rule: dict) -> str:
    return str(rule.get("target") or "").replace(" ", "").removeprefix("状态:")


# The bridge sends a condition's type when its name reads empty (0.6.6): the game's own words
# for them, as the rules and the player write them.
STATUS_ZH = {
    "Poison": "毒",
    "Silence": "沉默",
    "Sleep": "睡眠",
    "Paralysis": "麻痹",
    "Blind": "黑暗",
    "Mineralization": "石化",
    "SlowlyMineralization": "渐渐石化",
    "Confusion": "混乱",
    "Slow": "减速",
    "Stop": "停止",
    "Zombie": "僵尸",
    "Frog": "青蛙",
    "Child": "迷你",
    "Pig": "猪",
    "Aging": "老化",
    "Bersak": "狂暴",
    "Curse": "诅咒",
    "UnableFight": "战斗不能",
    "Dying": "濒死",
    "Heist": "加速",
    "Regeneration": "再生",
    "Proteus": "防护",
    "Shell": "魔法防护",
    "Reflex": "反射",
    "Blink": "分身",
    "Transparent": "隐身",
    "Leviteto": "浮空",
}


def statuses(unit: dict) -> list[str]:
    """A unit's status conditions in Chinese; empty names (older bridges) are dropped."""
    return [STATUS_ZH.get(s, s) for s in unit.get("status") or [] if s]


class RuleError(ValueError):
    pass


@dataclass
class Situation:
    """What the conditions read at one actor's turn."""

    actor: str
    players: list[dict]  # name, hp, maxHp, mp
    enemies: list[dict]  # name, hp, maxHp, boss
    turn: int = 1
    boss: bool = False
    items: dict[str, int] = field(default_factory=dict)  # name → count

    def me(self) -> dict:
        return next((p for p in self.players if p.get("name") == self.actor), {})

    def value(self, name: str) -> float:
        me = self.me()
        alive = [p for p in self.players if (p.get("hp") or 0) > 0]
        foes = [e for e in self.enemies if (e.get("hp") or 0) > 0]
        values = {
            "self.hp": lambda: me.get("hp") or 0,
            "self.hp_pct": lambda: pct(me),
            "self.mp": lambda: me.get("mp") or 0,
            "ally.hp_pct": lambda: min((pct(p) for p in alive), default=100),
            "ally.dead": lambda: len(self.players) - len(alive),
            "party.alive": lambda: len(alive),
            "enemy.count": lambda: len(foes),
            "enemy.boss": lambda: 1 if self.boss else 0,
            "enemy.hp_pct": lambda: min((pct(e) for e in foes), default=0),
            "turn": lambda: self.turn,
        }
        if name.startswith("item."):
            wanted = name.removeprefix("item.")
            return sum(n for item, n in self.items.items() if wanted and wanted in item)
        if name.startswith(("ally.status.", "self.status.")):
            wanted = name.split(".", 2)[2]
            units = [me] if name.startswith("self.") else self.players
            return sum(1 for u in units if any(wanted in s for s in statuses(u)))
        if name not in values:
            raise RuleError(f"条件里没有「{name}」这个词;能用的:{'、'.join(VOCABULARY)}")
        return values[name]()


def pct(unit: dict) -> float:
    top = unit.get("maxHp") or 0
    return 100.0 * (unit.get("hp") or 0) / top if top else 100.0


def parse(condition: str) -> list[tuple[str, str | None, float | None]]:
    clauses = []
    for part in re.split(r"\s+and\s+|\s*且\s*", condition.strip()):
        m = CLAUSE.match(part)
        if not m:
            raise RuleError(f"看不懂条件「{part}」:写成 名字 比较符 数字,如 ally.hp_pct < 50")
        name, op, number = m.groups()
        open_ended = any(name.startswith(p) and len(name) > len(p) for p in OPEN_ENDED)
        if name not in VOCABULARY and not open_ended:
            raise RuleError(f"条件里没有「{name}」这个词;能用的:{'、'.join(VOCABULARY)}")
        clauses.append((name, op, float(number) if number is not None else None))
    return clauses


def holds(condition: str | None, situation: Situation) -> bool:
    if not condition:
        return True
    for name, op, number in parse(condition):
        value = situation.value(name)
        if op is None and not value:
            return False
        if op is not None and not OPS[op](value, number):
            return False
    return True


@dataclass
class Action:
    command: str  # 攻击, 白魔法, 防御 ...
    ability: str  # 治疗, or "" for a plain command
    target: str  # ENEMY, SELF, WEAKEST, FALLEN
    whom: str | None = None  # the ally's name for SELF, WEAKEST and FALLEN
    rule: int = 0  # which rule (1-based) chose it; 0 for the fallback attack


def action_of(rule: dict, index: int, situation: Situation) -> Action | None:
    """The rule's action with its target resolved, or None when it has no one to act on."""
    command, _, ability = str(rule.get("do") or "攻击").partition(":")
    target = target_of(rule) or ENEMY
    alive = [p for p in situation.players if (p.get("hp") or 0) > 0]
    whom = None
    if target == SELF:
        whom = situation.actor
    elif target == WEAKEST:
        if not alive:
            return None
        whom = min(alive, key=pct)["name"]
    elif target == FALLEN:
        fallen = [p for p in situation.players if (p.get("hp") or 0) <= 0]
        if not fallen:
            return None
        whom = fallen[0]["name"]
    elif target == AILING:
        wanted = ailment_of(rule)
        ailing = [p for p in alive if any(wanted in s for s in statuses(p))]
        if not ailing:
            return None
        whom = ailing[0]["name"]
    return Action(command.strip(), ability.strip(), target, whom, index)


def choose(rules: list[dict], situation: Situation, skip: set[int] = frozenset()) -> Action:
    """The first rule that holds and has someone to act on; rules in `skip` were tried and
    could not be done. Falls back to attacking."""
    for i, rule in enumerate(rules, start=1):
        if i in skip or not holds(rule.get("if"), situation):
            continue
        action = action_of(rule, i, situation)
        if action is not None:
            return action
    return Action("攻击", "", ENEMY, None, 0)


def check(table: dict) -> list[str]:
    """What is wrong with a table, as the completeness check reports it (§4.6); [] when fine.
    It checks what code can know before a battle: shape, vocabulary, targets, a last rule
    without a condition for everyone."""
    problems = []
    rules_by_actor = table.get("battle", table) if isinstance(table, dict) else None
    if not isinstance(rules_by_actor, dict) or not rules_by_actor:
        return ["规则表要写成 {角色名: [规则, ...]}"]
    for actor, rules in rules_by_actor.items():
        if not isinstance(rules, list) or not rules:
            problems.append(f"{actor}:规则要写成列表")
            continue
        for i, rule in enumerate(rules, start=1):
            if not isinstance(rule, dict) or not rule.get("do"):
                problems.append(f"{actor} 第 {i} 条:缺少 do")
                continue
            if rule.get("if"):
                try:
                    parse(rule["if"])
                except RuleError as e:
                    problems.append(f"{actor} 第 {i} 条:{e}")
            if target_of(rule) is None:
                problems.append(
                    f"{actor} 第 {i} 条:目标「{rule['target']}」不认识;"
                    "能用:敌人、自己、hp最低的同伴、倒下的同伴、状态:毒(有这个状态的同伴)"
                )
        if isinstance(rules[-1], dict) and rules[-1].get("if"):
            problems.append(f'{actor}:最后一条要不带条件(兜底),比如 {{"do": "攻击"}}')
    return problems


def normalize(plan: dict) -> dict[str, list[dict]]:
    """Old plans ({角色: "指令"}) become one-rule tables; tables pass through."""
    plan = plan.get("battle", plan)
    return {
        actor: rules if isinstance(rules, list) else [{"do": str(rules)}]
        for actor, rules in plan.items()
    }


# Jobs by the name the bridge reads (0.6.0+); a party without them gets attack-only rules.
# Spell families, weakest first, as the Pixel Remaster names them in Chinese (shops, 10-21).
# A rule may ask for 「治疗+」: the strongest of the family the caster knows and has MP for;
# 「最强」 asks for the strongest attack spell of all (control plan §4.6).
FAMILIES = {
    "治疗": ["治疗", "救疗"],
    "火炎": ["火炎", "烈炎"],
    "冰结": ["冰结", "冰冻"],
    "闪雷": ["闪雷", "震雷"],
}
ATTACKS = ("火炎", "冰结", "闪雷")
BEST = "最强"

# Ailments: what cures each, white magic first, then items (names matched by containment,
# so 「眼药」 finds 眼药水). Blindness had no answer at all (10-21: Lenna and Faris blind).
CURES = {
    "毒": ("解毒", "解毒药"),
    "黑暗": (None, "眼药"),
    "石化": (None, "金针"),
    "青蛙": (None, "少女之吻"),
    "迷你": (None, "木槌"),
    "沉默": (None, "回音草"),
}


def cure_rules() -> list[dict]:
    """Rules any member can follow: an item on an ally with the ailment it cures."""
    return [
        {
            "if": f"ally.status.{ailment} >= 1 and item.{item} > 0",
            "do": f"道具:{item}",
            "target": f"状态:{ailment}",
        }
        for ailment, (_, item) in CURES.items()
        if item
    ]


REVIVE_ITEM = {
    "if": "ally.dead >= 1 and item.不死鸟之尾 > 0",
    "do": "道具:不死鸟之尾",
    "target": "倒下的同伴",
}
DEFAULT_RULES = {
    "白魔法师": [
        {"if": "ally.dead >= 1", "do": "白魔法:复活", "target": "倒下的同伴"},
        REVIVE_ITEM,
        {"if": "ally.hp_pct < 35", "do": "白魔法:治疗+", "target": "hp最低的同伴"},
        {"if": "ally.hp_pct < 60", "do": "白魔法:治疗", "target": "hp最低的同伴"},
        {"if": "ally.status.毒 >= 1", "do": "白魔法:解毒", "target": "状态:毒"},
        *cure_rules(),
        {"do": "攻击"},
    ],
    "黑魔法师": [
        REVIVE_ITEM,
        *cure_rules(),
        {"if": "self.mp >= 4", "do": f"黑魔法:{BEST}"},
        {"do": "攻击"},
    ],
}
OTHERS = [REVIVE_ITEM, *cure_rules(), {"do": "攻击"}]


def ability_candidates(wanted: str) -> list[str]:
    """The spells a rule's ability may be, best first: 「治疗+」 the family strongest first,
    「最强」 every attack family's tiers strongest first, else just the name."""
    if wanted == BEST:
        tiers = max(len(FAMILIES[f]) for f in ATTACKS)
        return [
            FAMILIES[f][i]
            for i in range(tiers - 1, -1, -1)
            for f in ATTACKS
            if i < len(FAMILIES[f])
        ]
    if wanted.endswith("+"):
        base = wanted[:-1]
        family = next((tiers for tiers in FAMILIES.values() if base in tiers), [base])
        return list(reversed(family))
    return [wanted]


def default_table(party: list[dict]) -> dict[str, list[dict]]:
    """The rules used when nobody wrote any (regular battles): healers heal, others attack."""
    return {
        p["name"]: DEFAULT_RULES.get(p.get("jobName") or "", OTHERS) for p in party if p.get("name")
    }

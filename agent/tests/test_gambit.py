from ffpr_agent.skills import gambit

PARTY = [
    {"name": "巴兹", "hp": 8, "maxHp": 197, "mp": 19, "jobName": "骑士"},
    {"name": "蕾娜", "hp": 60, "maxHp": 142, "mp": 16, "jobName": "白魔法师"},
    {"name": "加拉夫", "hp": 0, "maxHp": 215, "mp": 19, "jobName": "武僧"},
    {"name": "法利斯", "hp": 140, "maxHp": 140, "mp": 2, "jobName": "黑魔法师"},
]
CRAB = [{"name": "龙虾", "hp": 500, "maxHp": 650, "boss": 1}]


def at(actor, turn=1, players=PARTY):
    return gambit.Situation(actor, players, CRAB, turn, boss=True)


def test_the_vocabulary_reads_the_situation():
    s = at("蕾娜")
    assert round(s.value("ally.hp_pct"), 1) == 4.1  # Bartz 8/197; Galuf is down, not counted
    assert s.value("ally.dead") == 1 and s.value("party.alive") == 3
    assert s.value("self.mp") == 16 and s.value("enemy.boss") == 1
    assert gambit.holds("ally.hp_pct < 50 and self.mp >= 4", s)
    assert not gambit.holds("ally.dead == 0", s)
    assert gambit.holds("enemy.boss", s) and gambit.holds(None, s)


def test_the_first_rule_that_holds_and_has_a_target_wins():
    rules = [
        {"if": "ally.dead >= 1", "do": "白魔法:复活", "target": "倒下的同伴"},
        {"if": "ally.hp_pct < 50", "do": "白魔法:治疗", "target": "hp 最低的同伴"},
        {"do": "攻击"},
    ]
    first = gambit.choose(rules, at("蕾娜"))
    assert (first.command, first.ability, first.whom, first.rule) == ("白魔法", "复活", "加拉夫", 1)
    # Revive cannot be done (not learned): the executor skips it and the next rule takes over.
    second = gambit.choose(rules, at("蕾娜"), skip={1})
    assert (second.ability, second.target, second.whom) == ("治疗", gambit.WEAKEST, "巴兹")
    healthy = [dict(p, hp=p["maxHp"]) for p in PARTY]
    assert gambit.choose(rules, at("蕾娜", players=healthy)).command == "攻击"


def test_no_rule_left_means_attack():
    action = gambit.choose([{"if": "turn > 3", "do": "黑魔法:闪雷"}], at("法利斯"))
    assert (action.command, action.rule) == ("攻击", 0)


def test_the_check_sends_bad_tables_back_with_reasons():
    assert (
        gambit.check({"蕾娜": [{"if": "ally.hp_pct < 50", "do": "白魔法:治疗"}, {"do": "攻击"}]})
        == []
    )
    problems = gambit.check(
        {
            "蕾娜": [{"if": "ally.hp < 50", "do": "白魔法:治疗"}],  # no such word, no fallback
            "法利斯": [{"do": "黑魔法:闪雷", "target": "最强的敌人"}],
            "巴兹": "攻击",
        }
    )
    assert any("蕾娜 第 1 条" in p and "ally.hp" in p for p in problems)
    assert any(p.startswith("蕾娜:最后一条") for p in problems)
    assert any("最强的敌人" in p for p in problems)
    assert any(p.startswith("巴兹:") for p in problems)


def test_old_plans_and_default_rules():
    assert gambit.normalize({"巴兹": "攻击"}) == {"巴兹": [{"do": "攻击"}]}
    table = gambit.default_table(PARTY)
    assert [r["do"] for r in table["蕾娜"][:4]] == [
        "白魔法:复活",
        "道具:不死鸟之尾",
        "白魔法:治疗+",
        "白魔法:治疗",
    ]
    assert table["巴兹"][-1] == {"do": "攻击"} and table["法利斯"][-2]["do"] == "黑魔法:最强"
    assert gambit.check(table) == []


def test_items_in_conditions():
    s = gambit.Situation("蕾娜", PARTY, CRAB, items={"不死鸟之尾": 1, "恢复药": 3})
    assert gambit.holds("ally.dead >= 1 and item.不死鸟之尾 > 0", s)
    assert not gambit.holds("item.以太 > 0", s)
    revive = gambit.choose(gambit.default_table(PARTY)["蕾娜"], s, skip={1})  # no Raise
    assert (revive.command, revive.ability, revive.whom) == ("道具", "不死鸟之尾", "加拉夫")
    assert (
        gambit.check({"蕾娜": [{"if": "item.恢复药 > 0", "do": "道具:恢复药"}, {"do": "攻击"}]})
        == []
    )


def test_items_ordered_this_battle_count_as_used(monkeypatch):
    from ffpr_agent.skills import battle

    bag = {"恢复药": 3}
    monkeypatch.setattr(
        battle,
        "query",
        lambda laptop, op: {"items": {"normal": [{"name": "<IC_DRAG>恢复药", "count": 3}]}},
    )
    menu = {"players": PARTY, "enemies": CRAB}
    # Two potions ordered, none used yet: the bag still says 3, the rules see 1.
    s = battle.situation_of(None, menu, "蕾娜", 1, bag, {"恢复药": 2})
    assert s.items == {"恢复药": 1}
    assert not gambit.holds("item.恢复药 >= 3", s)


def test_status_in_conditions():
    players = [dict(p) for p in PARTY]
    players[3]["status"] = ["麻痹"]
    s = gambit.Situation("法利斯", players, CRAB)
    assert gambit.holds("ally.status.麻痹 >= 1", s) and gambit.holds("self.status.麻痹", s)
    assert not gambit.holds("ally.status.石化", s)
    assert (
        gambit.check({"蕾娜": [{"if": "ally.status.毒 > 0", "do": "白魔法:解毒"}, {"do": "攻击"}]})
        == []
    )


def test_a_status_target_picks_the_ailing_ally():
    players = [dict(p) for p in PARTY]
    players[0]["status"] = ["毒"]
    # Everyone at full HP but Galuf, who is down: no healing; revive has no item, so skip it.
    healthy = [dict(p, hp=p["maxHp"]) if p["name"] != "加拉夫" else dict(p) for p in players]
    s = gambit.Situation("蕾娜", healthy, CRAB)
    rules = gambit.default_table(PARTY)["蕾娜"]
    action = gambit.choose(rules, s, skip={1, 2})  # reviving Galuf cannot be done here
    assert (action.ability, action.target, action.whom) == ("解毒", gambit.AILING, "巴兹")
    assert (
        gambit.check({"蕾娜": [{"do": "白魔法:解毒", "target": "状态:毒"}, {"do": "攻击"}]}) == []
    )
    assert gambit.check({"蕾娜": [{"do": "白魔法:解毒", "target": "状态:"}, {"do": "攻击"}]})


def test_condition_types_read_in_chinese():
    unit = {"status": ["Poison", "", "Mineralization"]}
    assert gambit.statuses(unit) == ["毒", "石化"]
    s = gambit.Situation("蕾娜", [dict(PARTY[1], status=["Poison"])], CRAB)
    assert gambit.holds("ally.status.毒 >= 1 and self.status.毒", s)


def test_tactics_rotate_after_a_bad_battle(tmp_path):
    from ffpr_agent.ds.tactics import Tactics

    a, b = {"巴兹": [{"do": "攻击"}]}, {"巴兹": [{"do": "防御"}]}
    tactics = Tactics(tmp_path / "t.json")
    assert tactics.current(64) is None and tactics.record(64, "lost", "全员倒下") == ""
    tactics.set(64, [a, b])
    assert tactics.current(64) == a
    assert tactics.record(64, "ok", "全队 HP 80%") == "" and tactics.current(64) == a
    assert "换策略 2" in tactics.record(64, "hard", "巴兹倒下") and tactics.current(64) == b
    note = tactics.record(64, "lost", "全员倒下")
    assert "每套策略都失败过" in note and tactics.current(64) == a  # back to the first
    assert Tactics(tmp_path / "t.json").current(64) == a  # kept across runs


def test_judge_reads_the_party_after_a_battle(monkeypatch):
    from ffpr_agent.skills import battle

    def party(*hps):
        rows = [{"name": n, "hp": h, "maxHp": 100} for n, h in zip("ABCD", hps, strict=False)]
        return lambda laptop, op: {"sample": {"party": rows}}

    monkeypatch.setattr(battle, "query", party(0, 0, 0, 0))
    assert battle.judge(None)[0] == "lost"
    monkeypatch.setattr(battle, "query", party(50, 0, 90, 90))
    assert battle.judge(None) == ("hard", "B倒下")
    monkeypatch.setattr(battle, "query", party(30, 30, 30, 30))
    assert battle.judge(None)[0] == "hard"
    monkeypatch.setattr(battle, "query", party(90, 80, 70, 60))
    assert battle.judge(None) == ("ok", "全队 HP 75%")


def test_best_spell_candidates():
    assert gambit.ability_candidates("治疗+") == ["救疗", "治疗"]
    assert gambit.ability_candidates("冰冻+") == ["冰冻", "冰结"]
    assert gambit.ability_candidates("最强")[:3] == ["烈炎", "冰冻", "震雷"]
    assert gambit.ability_candidates("解毒") == ["解毒"]


def test_blindness_is_cured_with_eye_drops_by_anyone():
    players = [dict(p, hp=p["maxHp"]) for p in PARTY]
    players[1]["status"] = ["Blind"]  # the bridge's type name, read as 黑暗
    s = gambit.Situation("巴兹", players, CRAB, items={"眼药水": 2})
    action = gambit.choose(gambit.default_table(PARTY)["巴兹"], s)
    assert (action.command, action.ability, action.whom) == ("道具", "眼药", "蕾娜")
    s.items = {}  # none in the bag: the rule cannot fire, attack
    assert gambit.choose(gambit.default_table(PARTY)["巴兹"], s).command == "攻击"

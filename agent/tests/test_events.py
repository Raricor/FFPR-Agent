from datetime import datetime

from ffpr_agent import events as ev
from ffpr_agent.ds import game as ds_game
from ffpr_agent.ds import loop
from ffpr_agent.logs import key_log
from ffpr_agent.logs.key_log import SHANGHAI


def rec(seq, sec, type_, **body):
    minute, sec = divmod(sec, 60)
    return {"seq": seq, "t": f"2026-10-20T12:{minute:02d}:{sec:02d}Z", "type": type_, **body}


def sample(seq, sec, names=("巴兹", "蕾娜", "加拉夫", "法利斯"), hp=50, battle=None, **user):
    party = [{"name": n, "lv": 7, "hp": hp} for n in names]
    user = {"mapId": 30, "areaText": "图尔村", "gil": 100, **user}
    return rec(seq, sec, "sample", user=user, party=party, battle=battle or {"active": False})


def line(seq, sec, scene, speaker, text):
    return rec(seq, sec, "dialog.play", ids=[f"{scene}_a_01"], speaker=speaker, lines=[text])


def entries(records):
    b = key_log.Builder("r")
    for r in records:
        b.feed(r)
    return [(e["type"], e["text"], e["progress"]) for e in b.entries]


def test_who_leaves_and_joins_the_party():
    got = entries(
        [
            sample(1, 0, names=()),  # title screen: no party yet, no entry
            sample(2, 1),
            sample(3, 2, names=("巴兹", "蕾娜", "加拉夫")),  # 10-20: Faris left entering Tule
            sample(4, 3, names=()),  # loading a save: not a change
            sample(5, 4),
        ]
    )
    assert [g for g in got if g[0] == "party"] == [
        ("party", "法利斯 离队", "队伍 3 人"),
        ("party", "法利斯 入队", "队伍 4 人"),
    ]


def test_story_lines_gather_into_one_entry_per_scene():
    got = entries(
        [
            line(1, 0, "E0001_00_071", "蕾娜", "父王！"),
            line(2, 3, "E0001_00_071", "泰空王", "蕾娜，你要保护城堡。"),
            line(3, 6, "E0001_00_071", "", "风停了！"),
            line(4, 9, "E0002_00_010", "巴兹", "那是？"),
            line(5, 300, "E0002_00_010", "巴兹", "那是？"),  # the scene again, minutes later
            rec(6, 301, "dialog.play", ids=["N0001_a_01"], speaker="村民", lines=["你好"]),
        ]
    )
    assert got == [
        ("story", "蕾娜:父王！ …… 风停了！", "3 句"),
        ("story", "巴兹:那是？", "1 句"),
        ("story", "巴兹:那是？", "1 句"),
    ]


def test_boss_start_win_and_defeat_from_the_game_counters():
    fight = {"active": True, "boss": True, "enemies": [{"name": "卡拉波斯"}]}
    goblin = {"active": True, "enemies": [{"name": "哥布林"}]}
    got = entries(
        [
            sample(1, 0, wins=20, escapes=0),
            sample(2, 1, battle=fight, wins=20, escapes=0),
            sample(3, 2, battle=fight, wins=20, escapes=0),
            sample(4, 3, wins=21, escapes=0),  # won
            sample(5, 4, battle=fight, wins=21, escapes=0),
            sample(6, 5, hp=0, wins=21, escapes=0),  # everyone down: lost
            sample(7, 6, battle=goblin, wins=21, escapes=0),
            sample(8, 7, wins=21, escapes=1),  # fled a regular battle: no entry
        ]
    )
    assert [g[:2] for g in got if g[0] in ("bossfight", "boss", "defeat")] == [
        ("bossfight", "开始:「卡拉波斯」"),
        ("boss", "击败「卡拉波斯」"),
        ("bossfight", "开始:「卡拉波斯」"),
        ("defeat", "全灭:「卡拉波斯」"),
    ]


def test_shorten_keeps_the_first_and_last_lines():
    lines = ["甲" * 10, "乙" * 10, "丙" * 10, "丁" * 10, "戊" * 10]
    assert ev.shorten(lines, 100) == " / ".join(lines)
    assert ev.shorten(lines, 30) == f"{'甲' * 10} / {'乙' * 10} / …… / {'戊' * 10}"
    assert ev.shorten(["长" * 50], 20) == "长" * 20 + " / ……"


def at(minute):
    return lambda: datetime(2026, 10, 20, 20, minute, tzinfo=SHANGHAI)


def test_seed_then_stream_without_doubles_and_a_restart_starts_a_new_run():
    hello = rec(1, 0, "hello", product="FF5", gameVersion="1.2.0", plugin="0.5.2")
    events = ev.KeyEvents(now=at(30))
    for r in [hello, sample(2, 1), sample(3, 2, names=("巴兹", "蕾娜", "加拉夫"))]:
        events.feed(r, live=False)
    # The stream resends the hello and may overlap what the file held.
    for r in [hello, sample(3, 2, names=("巴兹", "蕾娜", "加拉夫")), sample(4, 3)]:
        events.feed(r)
    assert [e["text"] for e in events.entries if e["type"] == "party"] == [
        "法利斯 离队",
        "法利斯 入队",
    ]
    restarted = rec(1, 600, "hello", product="FF5", gameVersion="1.2.0", plugin="0.5.2")
    events.feed(restarted)
    events.feed(sample(2, 601))  # seq starts again at 1 in the new run
    assert [e["type"] for e in events.entries].count("run") == 2
    assert events.live_sample() is not None


def test_windows_per_layer_and_news_since_the_last_read():
    events = ev.KeyEvents(now=at(30))
    events.feed(rec(1, 0, "hello", product="FF5", gameVersion="1.2.0", plugin="0.5.2"))
    events.feed(rec(2, 0, "save.write", slot=3, result="Success"))  # 20:00 local
    events.feed(sample(3, 1500))  # 20:25
    events.feed(sample(4, 1501, names=("巴兹", "蕾娜", "加拉夫")))
    strategy, tactics = events.window(1), events.window(2)
    assert "存档到 3 号位" in strategy and "法利斯 离队" in strategy
    assert "存档" not in tactics and "法利斯 离队" in tactics  # saves are strategy's business
    assert events.news() == ""  # the window was read: nothing new
    events.feed(line(5, 1502, "E0003_00_001", "巴兹", "法利斯去哪了？"))
    assert events.news() == "20:25 剧情 巴兹:法利斯去哪了？(1 句)"
    events.feed(line(6, 1503, "E0003_00_001", "加拉夫", "去酒馆看看。"))
    assert "去酒馆看看" in events.news()  # the scene grew
    assert events.news() == ""
    assert ev.KeyEvents(now=at(59)).window(2) == ""


def test_the_player_sees_the_window_first_and_news_after_each_tool():
    class Events(ev.KeyEvents):
        def live_sample(self, max_age=3.0):
            return {"user": {"mapId": 30}, "party": []}

    events = Events(now=at(30))
    events.feed(rec(1, 0, "hello", product="FF5", gameVersion="1.2.0", plugin="0.5.2"))
    events.feed(sample(2, 1500))
    events.feed(sample(3, 1501, names=("巴兹", "蕾娜", "加拉夫")))
    game = ds_game.Game(laptop=None, events=events)
    game.settle = lambda: ""
    game.ready = lambda: None
    seen = []

    def chat(messages):
        seen.append(messages)
        if len(seen) == 1:
            events.feed(line(4, 1502, "E0003_00_001", "巴兹", "法利斯去哪了？"))
            calls = [{"id": "c1", "function": {"name": "remember", "arguments": '{"note": "x"}'}}]
            return {"choices": [{"message": {"role": "assistant", "tool_calls": calls}}]}
        done = [{"id": "c2", "function": {"name": "done", "arguments": '{"summary": "ok"}'}}]
        return {"choices": [{"message": {"role": "assistant", "tool_calls": done}}]}

    game.run = lambda name, args: "已记下\n新的重要事件:\n" + game.news()
    loop.play("找法利斯", "", chat, game, 5, lambda _: None, lambda _: None)
    opening = seen[0][1]["content"]
    assert "最近几小时的重要事件:" in opening and "20:25 队伍 法利斯 离队(队伍 3 人)" in opening
    assert "法利斯去哪了" in seen[1][-1]["content"]


def test_minutes_since_the_last_save():
    events = ev.KeyEvents(now=at(30))
    events.feed(rec(1, 0, "hello", product="FF5", gameVersion="1.2.0", plugin="0.6.4"))
    assert events.last_save_minutes() is None
    events.feed(rec(2, 600, "save.write", slot=3, result="Success"))  # 20:10 local
    assert events.last_save_minutes() == 20


def test_purchases_told_by_the_tools_stay_in_the_windows():
    events = ev.KeyEvents(now=at(30))
    events.note("buy", "买了「催眠」×1,花了 300")
    assert "20:30 购买 买了「催眠」×1,花了 300" in events.window(1)
    assert "购买" in events.window(2)


def test_monsters_met_are_kept_per_map():
    events = ev.KeyEvents(now=at(30))
    events.feed(rec(1, 0, "hello", product="FF5", gameVersion="1.2.0", plugin="0.6.8"))
    fight = {"active": True, "enemies": [{"name": "小妖魔"}]}
    events.feed(sample(2, 1, battle=fight, mapId=64))
    assert events.enemies == {64: {"小妖魔"}}


def test_bestiary_numbers_only_from_bridges_that_send_the_shown_ones():
    events = ev.KeyEvents(now=at(30))
    fight = {"active": True, "enemies": [{"name": "寒冰士兵", "book": 30}]}
    events.feed(rec(1, 0, "hello", product="FF5", gameVersion="1.2.0", plugin="0.6.9"), live=False)
    events.feed(sample(2, 1, battle=fight, mapId=238), live=False)
    assert events.books == {}  # an entry id from an old bridge
    events.feed(rec(1, 60, "hello", product="FF5", gameVersion="1.2.0", plugin="0.7.2"))
    fight["enemies"][0]["book"] = 26
    events.feed(sample(2, 61, battle=fight, mapId=238))
    assert events.books == {"寒冰士兵": 26}

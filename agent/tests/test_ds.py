import json
import re
from pathlib import Path

import httpx

from ffpr_agent.ds import client as ds_client
from ffpr_agent.ds import game as ds_game
from ffpr_agent.ds import loop, prompt


def test_render_terrain_marks_player_and_special_cells():
    cells = {"origin": [9, 4], "center": [10, 5], "attr": [[16, 19, 3], [10, 3, 99]]}
    text = prompt.render_terrain(cells)
    lines = text.splitlines()
    assert lines[0].startswith("地形图:左上角是格子 (9,4),@ 是你 (10,5)")
    assert lines[2] == "    4 ~^."
    assert lines[3] == "    5 0@1"
    assert "0 特殊格(编码 10" in text and "1 特殊格(编码 99" in text


def test_trim_never_starts_on_a_tool_result():
    history = [
        {"role": "assistant", "content": "a", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "tool_call_id": "1", "content": "r"},
        {"role": "assistant", "content": "b"},
    ]
    assert loop.trim(history, 2) == [history[2]]
    assert loop.trim(history, 3) == history


class FakeGame:
    def __init__(self):
        self.notes = []
        self.calls = []

    def observe(self):
        return "地图 1 · 格子 140,99"

    def run(self, name, args):
        self.calls.append((name, args))
        if name == "remember":
            self.notes.append(args["note"])
        return f"{name} ok"


def call(name, args, cid):
    return {
        "id": cid,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)},
    }


def test_play_runs_tools_until_done_and_feeds_results_back():
    replies = iter(
        [
            {"content": "先看地形", "tool_calls": [call("terrain", {"radius": 8}, "c1")]},
            {"content": "记下", "tool_calls": [call("remember", {"note": "入口在西边"}, "c2")]},
            {"content": None, "tool_calls": [call("done", {"summary": "到了"}, "c3")]},
        ]
    )
    seen = []

    def chat(messages):
        seen.append(messages)
        return {"choices": [{"message": {"role": "assistant", **next(replies)}}]}

    game, logs, said = FakeGame(), [], []
    summary = loop.play("去风之神殿", "在西边", chat, game, 10, logs.append, said.append)

    assert summary == "到了"
    assert game.calls == [("terrain", {"radius": 8}), ("remember", {"note": "入口在西边"})]
    # The second request carries the first tool's result, the third the remembered note.
    assert seen[1][-1] == {"role": "tool", "tool_call_id": "c1", "content": "terrain ok"}
    assert "1. 入口在西边" in seen[2][0]["content"]
    assert "已知信息:在西边" in seen[0][0]["content"]
    assert any("→ terrain" in s for s in said)


def test_deepseek_client_retries_and_keeps_the_key_out_of_errors():
    statuses = iter([503, 400])

    def handler(request):
        assert request.headers["authorization"] == "Bearer sk-secret-123456"
        body = json.loads(request.content)
        assert body["model"] == "deepseek-flash" and body["tools"] == []
        assert body["thinking"] == {"type": "enabled"} and body["reasoning_effort"] == "high"
        assert "temperature" not in body  # no effect while thinking
        return httpx.Response(next(statuses), text="bad request")

    http = httpx.Client(base_url=ds_client.BASE_URL, transport=httpx.MockTransport(handler))
    client = ds_client.DeepSeek("sk-secret-123456", "deepseek-flash", http, sleep=lambda _: None)
    try:
        client.chat([{"role": "user", "content": "hi"}], [])
    except RuntimeError as e:
        assert "400" in str(e) and "sk-secret" not in str(e)
    else:
        raise AssertionError("expected an error")


def test_play_stops_at_the_deadline_and_deadline_rolls_over():
    from datetime import datetime

    def chat(messages):
        raise AssertionError("must not call the model after the deadline")

    t = datetime(2026, 10, 20, 6, 0, 1, tzinfo=loop.SHANGHAI)
    deadline = datetime(2026, 10, 20, 6, 0, tzinfo=loop.SHANGHAI)
    said = []
    result = loop.play(
        "g", "", chat, FakeGame(), 5, lambda r: None, said.append, deadline=deadline, now=lambda: t
    )
    assert result == "到达截止时间" and "06:00" in said[0]
    assert (
        loop.next_deadline("06:00", datetime(2026, 10, 20, 1, 50, tzinfo=loop.SHANGHAI)).day == 20
    )
    assert loop.next_deadline("06:00", datetime(2026, 10, 20, 7, 0, tzinfo=loop.SHANGHAI)).day == 21


def test_play_waits_while_the_laptop_is_locked():
    class LockedGame(FakeGame):
        def __init__(self):
            super().__init__()
            self.states = iter(["locked", "locked", None])

        def ready(self):
            return next(self.states, None)

    waits, said = [], []

    def chat(messages):
        return {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "tool_calls": [call("done", {"summary": "ok"}, "c")],
                    }
                }
            ]
        }

    result = loop.play(
        "g", "", chat, LockedGame(), 3, lambda r: None, said.append, wait=waits.append
    )
    assert result == "ok"
    assert waits == [60, 60]
    assert any("locked" in s for s in said) and any("已恢复" in s for s in said)


def test_notes_persist_and_can_be_forgotten(tmp_path):
    path = tmp_path / "notes.json"
    game = ds_game.Game(laptop=None, notes_file=path)
    game.run("remember", {"note": "旅店在 (43,42)"})
    game.run("remember", {"note": "宝箱 (9,6) 是陷阱"})
    assert ds_game.Game(laptop=None, notes_file=path).notes == [
        "旅店在 (43,42)",
        "宝箱 (9,6) 是陷阱",
    ]
    assert game.run("forget", {"index": 2}) == "已删除:宝箱 (9,6) 是陷阱"
    assert ds_game.load_notes(path) == ["旅店在 (43,42)"]
    assert game.run("forget", {"index": 5}) == "没有第 5 条笔记"


def test_every_tool_has_a_handler():
    # Tools run in ds/game.py, except `done`, which ends the loop in ds/loop.py.
    source = "".join(Path(m.__file__).read_text(encoding="utf-8") for m in (ds_game, loop))
    handled = set(re.findall(r'name == "(\w+)"', source))
    for group in re.findall(r"name in \(([^)]*)\)", source):
        handled |= set(re.findall(r'"(\w+)"', group))
    assert {t["function"]["name"] for t in prompt.TOOLS} <= handled


def test_rounds_use_the_next_hint_and_stop_at_the_deadline():
    from datetime import datetime, timedelta

    start = datetime(2026, 10, 20, 5, 0, tzinfo=loop.SHANGHAI)
    clock = iter(start + timedelta(minutes=m) for m in range(0, 600, 20))
    seen = []

    def chat(messages):
        seen.append(messages[0]["content"])
        done = call("done", {"summary": f"第 {len(seen)} 轮完成"}, "c")
        return {"choices": [{"message": {"role": "assistant", "tool_calls": [done]}}]}

    opened = []
    summaries = loop.play_rounds(
        ["甲", "乙", "丙", "丁"],
        "先看地形",
        chat,
        FakeGame(),
        5,
        lambda goal, hint: opened.append((goal, hint)) or (lambda r: None),
        say=lambda s: None,
        deadline=start + timedelta(minutes=70),  # each round reads the clock twice
        now=lambda: next(clock),
        next_hint="接着玩",
    )
    assert summaries == ["第 1 轮完成", "第 2 轮完成"]
    assert opened == [("甲", "先看地形"), ("乙", "接着玩")]
    assert "已知信息:先看地形" in seen[0] and "已知信息:接着玩" in seen[1]


def test_restart_reads_the_bridge_version_from_the_source():
    from ffpr_agent import restart

    assert re.fullmatch(r"\d+\.\d+\.\d+", restart.bridge_version())


def test_thinking_off_and_reasoning_kept_for_the_next_request():
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant"}}]})

    http = httpx.Client(base_url=ds_client.BASE_URL, transport=httpx.MockTransport(handler))
    ds_client.DeepSeek("sk-x", "deepseek-flash", http, effort=None).chat([], [])
    assert sent[0]["thinking"] == {"type": "disabled"} and "reasoning_effort" not in sent[0]

    replies = iter(
        [
            {"reasoning_content": "先看地形", "tool_calls": [call("terrain", {}, "c1")]},
            {"tool_calls": [call("done", {"summary": "好"}, "c2")]},
        ]
    )
    seen = []

    def chat(messages):
        seen.append(messages)
        return {"choices": [{"message": {"role": "assistant", **next(replies)}}]}

    loop.play("g", "", chat, FakeGame(), 5, lambda r: None, lambda s: None)
    assert seen[1][-2]["reasoning_content"] == "先看地形"  # sent back with its tool call


def test_render_floor_marks_walls_floor_and_entities():
    view = {"center": [2, 1], "rows": ["####", "#...", "#.##"]}
    text = prompt.render_floor(view, 4, {(3, 1): "!", (1, 2): "T"})
    lines = text.splitlines()
    assert lines[0].startswith("地图:左上角是格子 (0,0),@ 是你 (2,1)")
    assert lines[2:5] == ["    0 ####", "    1 #.@!", "    2 #T##"]
    assert "! 事件触发点" in lines[-1] and ". 你这一层能走" in lines[-1]


def test_atlas_marks_exits_visited_or_not(tmp_path):
    from ffpr_agent.ds.atlas import Atlas

    path = tmp_path / "atlas.json"
    atlas = Atlas(path)
    exits = [{"cell": [22, 15], "to": 212, "name": "沈没船1"}, {"cell": [47, 10], "to": 1}]
    atlas.visit(211, "船舶墓场", exits, [{"cell": [13, 54], "name": "フレイル"}])
    atlas.visit(212, "沈没船1", [{"cell": [3, 3], "to": 213, "name": "沈没船2"}], [])
    again = Atlas(path)  # kept across runs
    text = again.describe(around=212)
    assert text.splitlines()[0].startswith(
        "地图 212 沈没船1(你在这里):出口 (3, 3)→地图 213 沈没船2(没去过)"
    )
    assert "→地图 212 沈没船1(去过)" in text and "(世界地图)" in text and "フレイル" in text


def test_atlas_keeps_jump_links_across_visits(tmp_path):
    from ffpr_agent.ds.atlas import Atlas

    atlas = Atlas(tmp_path / "atlas.json")
    atlas.visit(211, "船舶墓场", [], [])
    atlas.link(211, [17, 34], [13, 51], "调查后跳")
    atlas.link(211, [17, 34], [13, 51], "调查后跳")  # once only
    atlas.visit(211, "船舶墓场", [{"cell": [22, 15], "to": 212}], [])  # a later look keeps it
    assert atlas.maps["211"]["links"] == [{"from": [17, 34], "to": [13, 51], "how": "调查后跳"}]
    assert "走法 在 (17, 34) 调查后跳 到 (13, 51)" in atlas.describe(211)


def test_new_gear_is_put_on_and_reported(monkeypatch):
    game = ds_game.Game(laptop=None)
    bags = iter(
        [
            {"恢复药": 3, "宽刃剑": 1},
            {"恢复药": 2, "宽刃剑": 1},  # a potion used: nothing new to wear
            {"恢复药": 2, "宽刃剑": 1, "秘银头盔": 1},  # a chest gave a helmet
            {"恢复药": 2, "宽刃剑": 1},  # after 最强装备 it is worn, out of the bag
        ]
    )

    def query(laptop, op):
        bag = next(bags)
        kinds = {"恢复药": "Item"}
        normal = [{"name": n, "count": c, "type": kinds.get(n, "Armor")} for n, c in bag.items()]
        return {"items": {"normal": normal}}

    worn = []
    monkeypatch.setattr(ds_game.pilot, "query", query)
    monkeypatch.setattr(ds_game.pilot, "send", lambda *a, **k: {"pos": {"state": "Player"}})
    monkeypatch.setattr(
        ds_game.menu,
        "optimize_equipment",
        lambda laptop: worn.append(1) or (True, "巴兹:无→秘银头盔"),
    )
    assert game.check_gear() == ""  # first look
    assert game.check_gear() == ""
    assert game.check_gear() == "得到新装备「秘银头盔」,已检查最强装备:巴兹:无→秘银头盔"
    assert worn == [1] and game.gear == {"宽刃剑": 1}


def test_an_unfinished_goal_is_played_once_more():
    rounds = iter([False, False, True, False, False])  # done or not, round by round

    def chat(messages):
        finished = next(rounds)
        tool = call("done", {"summary": "完成"}, "c") if finished else call("look_around", {}, "c")
        return {"choices": [{"message": {"role": "assistant", "tool_calls": [tool]}}]}

    opened = []
    summaries = loop.play_rounds(
        ["甲", "乙", "丙"],
        "",
        chat,
        FakeGame(),
        1,  # one step: a round without done runs out of steps
        lambda goal, hint: opened.append((goal, hint)) or (lambda r: None),
        say=lambda s: None,
        next_hint="接着玩",
    )
    # 甲 twice (then given up), 乙 done on its first try, 丙 twice.
    assert [g for g, _ in opened] == ["甲", "甲", "乙", "丙", "丙"]
    assert opened[1][1].startswith(loop.UNFINISHED) and opened[2][1] == "接着玩"
    assert summaries == ["步数用完", "步数用完", "完成", "步数用完", "步数用完"]

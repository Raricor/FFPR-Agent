from ffpr_agent.logs import key_log, probe_report


def rec(seq, sec, type_, **body):
    return {"seq": seq, "t": f"2026-10-19T17:00:{sec:02d}Z", "type": type_, **body}


def sample(sec, seq, *, gil, chests=0, lv=5, battle=None, area="风之神殿"):
    party = [{"name": "巴兹", "lv": lv, "hp": 50}, {"name": "蕾娜", "lv": 5, "hp": 40}]
    user = {"mapId": 203, "areaText": area, "gil": gil, "chests": chests}
    return rec(seq, sec, "sample", user=user, party=party, battle=battle or {"active": False})


def test_build_extracts_key_events():
    b = key_log.Builder("20261020-0100")
    for r in [
        rec(1, 0, "hello", product="FINAL FANTASY V", gameVersion="1.2.0", plugin="0.3.0"),
        sample(1, 2, gil=100),
        rec(3, 2, "dialog.play", ids=["T0001_01_01"], lines=["宝箱中发现了", "【帐篷】！"]),
        sample(3, 4, gil=100, chests=5),
        sample(4, 5, gil=100, chests=5, battle={"active": True, "enemies": [{"name": "翼龙"}]}),
        sample(5, 6, gil=100, chests=5, lv=6),  # won, no gil: likely a boss; Bartz levelled up
        sample(6, 7, gil=100, chests=5, battle={"active": True, "enemies": [{"name": "杀人蜂"}]}),
        sample(7, 8, gil=260, chests=5),  # a normal battle: gil gained, no entry
        rec(9, 8, "dialog.play", ids=["E0017_a"], lines=["得到了【水晶碎片】！"]),
        rec(10, 9, "save.write", slot=3, result="Success"),
    ]:
        b.feed(r)
    kinds = [(e["type"], e["text"], e["progress"]) for e in b.entries]
    assert kinds == [
        ("run", "开始:FINAL FANTASY V 1.2.0,桥插件 0.3.0", "—"),
        ("place", "首次到达「风之神殿」", "—"),
        ("chest", "地图 203:帐篷", "本作已开 5 个"),
        ("boss", "击败「翼龙」(推测为首领:战后没有金钱)", "—"),
        ("level", "巴兹 5→6", "全员最低 Lv5"),
        ("item", "得到「水晶碎片」", "—"),
        ("save", "存档到 3 号位", "—"),
    ]
    assert b.entries[0]["ts"] == "2026-10-20T01:00:00+08:00"


def test_render_markdown_table():
    entries = [{"ts": "2026-10-20T01:05:00+08:00", "type": "chest", "text": "a|b", "progress": "—"}]
    md = key_log.render("ff5", [("run1", entries)])
    assert "# 关键日志 · FF5" in md and "## 2026-10-20 运行 run1" in md
    assert "| 01:05 | 宝箱 | a\\|b | — |" in md


def test_level_ups_from_one_result_screen_merge():
    b = key_log.Builder("r")
    b.feed(sample(0, 1, gil=0, lv=4))
    b.feed(sample(1, 2, gil=0, lv=5))
    later = sample(2, 3, gil=0, lv=5)
    later["party"][1]["lv"] = 6  # Lenna's level shows up a second later
    b.feed(later)
    levels = [e for e in b.entries if e["type"] == "level"]
    assert [e["text"] for e in levels] == ["巴兹 4→5、蕾娜 5→6"]


def test_level_ups_from_separate_battles_stay_separate():
    b = key_log.Builder("r")
    b.feed(sample(0, 1, gil=0, lv=4))
    b.feed(sample(1, 2, gil=0, lv=5))
    b.feed(sample(2, 3, gil=0, lv=5, battle={"active": True, "enemies": []}))
    b.feed(sample(3, 4, gil=10, lv=6))
    assert [e["text"] for e in b.entries if e["type"] == "level"] == ["巴兹 4→5", "巴兹 5→6"]


def test_boss_flag_beats_the_gil_guess():
    b = key_log.Builder("r")
    b.feed(sample(0, 1, gil=100))
    fight = {"active": True, "boss": True, "enemies": [{"name": "卡拉波斯", "boss": 1}]}
    b.feed(sample(1, 2, gil=100, battle=fight))
    b.feed(sample(2, 3, gil=400))  # this boss dropped gil: still a boss
    b.feed(sample(3, 4, gil=400, battle={"active": True, "boss": False, "enemies": []}))
    b.feed(sample(4, 5, gil=400))  # flagged as no boss: no entry even without gil
    assert [e["text"] for e in b.entries if e["type"] == "boss"] == ["击败「卡拉波斯」"]


def test_probe_report_summarises_a_session():
    def rec(seq, sec, type_, **body):
        return {
            "seq": seq,
            "t": f"2026-10-19T15:00:{sec:02d}Z",
            "frame": seq,
            "type": type_,
            **body,
        }

    sample = {
        "scene": {"name": "MainGame", "sub": "SubSceneManagerMainGame", "state": "Player"},
        "user": {"mapId": 12, "areaText": "风之神殿", "gil": 100, "steps": 3, "boost": {"exp": 4}},
        "party": [{"name": "巴兹", "job": 1, "lv": 2, "hp": 30, "maxHp": 35, "mp": 0, "maxMp": 0}],
        "field": {"pos": [1, 2, 0]},
        "battle": {"active": False},
        "dialog": {"error": "NullReferenceException: x"},
    }
    later = {**sample, "user": {**sample["user"], "gil": 160, "steps": 9}}
    records = [
        rec(1, 0, "hello", product="FINAL FANTASY V", gameVersion="1.2.0", plugin="0.1.0"),
        rec(2, 1, "sample", **sample),
        rec(
            3,
            2,
            "dialog.play",
            state="Event",
            speaker="蕾娜",
            lines=["", "父亲……"],
            ids=["E0001_a"],
        ),
        rec(4, 2, "dialog.play", state="Event", lines=["是锁着的。"], ids=["S9999_999_a_06"]),
        rec(4, 3, "choice.open", kind="select", default=0, options=["是", "否"]),
        rec(5, 4, "sysmsg", id="S_9", text="得到了 药水"),
        rec(6, 5, "achievement.unlock", api="scenario_1"),
        rec(6, 5, "achievement.unlock", api="scenario_1"),
        rec(7, 6, "sample", **later),
    ]
    text = probe_report.render(records, "x.jsonl")
    assert "FINAL FANTASY V 1.2.0" in text
    assert "00:02  [剧情] 【蕾娜】父亲……  · E0001_a" in text
    assert "00:02  [系统] 是锁着的。" in text
    assert "去掉重复后 1 条,原始 2 条" in text
    assert "00:01  MainGame  地图 12 风之神殿" in text
    assert "select 默认 0:是 / 否" in text
    assert "S_9:得到了 药水" in text and '"api": "scenario_1"' in text
    assert "gil 100→160" in text and "steps 3→9" in text
    assert "巴兹 职业 1 Lv2 HP 30/35" in text
    assert "dialog × 2:NullReferenceException: x" in text

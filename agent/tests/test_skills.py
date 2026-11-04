from ffpr_agent import nav, view
from ffpr_agent.skills import cursor, move, save


def test_pilot_renders_cells_and_summarises_state():
    grid = nav.render_cells(
        {"origin": [9, 4], "center": [10, 5], "attr": [[0, 1, 0], [3, 7, None]]}
    )
    assert grid.splitlines() == ["      9 10 11", "   4  0  1  0", "   5  3  @  ?"]

    sample = {
        "scene": {"name": "MainGame", "state": "Player"},
        "user": {"mapId": 198, "areaText": "海盗船", "gil": 1360},
        "field": {"cell": [20, 10]},
        "battle": {"active": False},
        "dialog": {"open": True, "speaker": "巴兹", "lines": ["好，我们出发吧！！"]},
    }
    events = [
        {"seq": 1, "type": "dialog.play", "ids": ["E0012"], "speaker": "巴兹", "lines": ["好"]}
    ]
    text = view.summarize(sample, events)
    assert "MainGame/Player · 地图 198 海盗船 · 格子 20,10 · 非战斗 · 金钱 1360" in text
    assert "对话框打开 【巴兹】好，我们出发吧！！" in text
    assert "+ 对话 E0012 【巴兹】好" in text


def test_find_path_by_ship_and_on_foot():
    # ~ sea (16), ^ mountain (19), . grass (3); player at (1, 1) on a ship.
    cells = {
        "origin": [0, 0],
        "center": [1, 1],
        "attr": [
            [19, 19, 19, 19, 19],
            [19, 16, 16, 16, 19],
            [19, 19, 19, 16, 19],
            [3, 3, 3, 16, 3],
        ],
    }
    path = nav.find_path(cells, (3, 3), by_ship=True)
    assert path == [(1, 1), (2, 1), (3, 1), (3, 2), (3, 3)]
    assert nav.corners(path) == [(3, 1), (3, 3)]
    # The goal may be a shore cell the ship cannot enter; on foot the sea blocks.
    assert nav.find_path(cells, (4, 3), by_ship=True)[-1] == (4, 3)
    assert nav.find_path(cells, (0, 3), by_ship=False) is None


def test_path_toward_stops_at_the_nearest_reachable_cell():
    cells = {"origin": [0, 0], "center": [0, 0], "attr": [[16, 16, 16, 19, 3]]}
    # (4, 0) is behind a mountain: the ship gets as close as the sea allows.
    ship = nav.terrain_rule(by_ship=True)
    assert nav.path_toward(cells, (4, 0), ship) == [(0, 0), (1, 0), (2, 0)]
    assert nav.path_toward(cells, (2, 0), ship)[-1] == (2, 0)


def test_indoor_grid_walls_and_occupied_cells():
    # A corner of the Wind Shrine 1F collision layer (bridge 0.2.5), player at (2, 1).
    collision = {
        "playerCell": [2, 1],
        "searchLayer": 1,
        "layers": [{"rows": ["#####", "#...#", "#.#.#", "#...#"]}],
    }
    collision["layers"][0]["rows"] = [
        r.replace("#", "1").replace(".", "0") for r in collision["layers"][0]["rows"]
    ]
    grid = nav.indoor_grid(collision, blocked={(1, 1)})
    assert grid["center"] == [2, 1]
    # (1, 1) holds a chest, so the way to (1, 3) goes round the right-hand side.
    path = nav.path_toward(grid, (1, 3), nav.floor_rule)
    assert path == [(2, 1), (3, 1), (3, 2), (3, 3), (2, 3), (1, 3)]


def test_highlighted_slot_maps_cursor_through_display_order():
    # Recorded on the FF5 load list (bridge 0.3.0): cursor 12 showed "数据 11".
    ui = {"open": True, "current": None, "cursor": 12, "slots": [21, 22, *range(1, 21)]}
    assert save.highlighted_slot(ui) == 11
    assert save.highlighted_slot({"cursor": None, "current": 3, "slots": []}) == 3


def test_pick_matches_exactly_then_by_containment():
    names = ["攻击", "黑魔法", "道具", None]
    assert cursor.pick(names, "攻击") == 0
    assert cursor.pick(names, "魔法") == 1
    assert cursor.pick(["火", "冰", "雷"], "雷") == 2
    assert cursor.pick(names, "召唤") is None


class FakeMenu:
    """A menu cursor over `count` entries laid out in rows of `columns`; `keys` say which
    keys the menu answers to."""

    def __init__(self, count: int, columns: int = 1, keys=("Up", "Down", "Left", "Right")):
        self.at, self.count, self.columns, self.keys = 0, count, columns, keys
        self.pressed: list[str] = []

    def press(self, key: str) -> None:
        self.pressed.append(key)
        if key not in self.keys:
            return
        step = {"Down": self.columns, "Up": -self.columns, "Right": 1, "Left": -1}[key]
        self.at = (self.at + step) % self.count


def test_steer_walks_lists_rows_and_grids():
    column = FakeMenu(8, keys=("Up", "Down"))
    assert cursor.steer(lambda: column.at, column.press, 5)
    assert column.pressed == ["Down"] * 5

    row = FakeMenu(5, keys=("Left", "Right"))  # Down does nothing: switch to Right
    assert cursor.steer(lambda: row.at, row.press, 3)
    assert row.at == 3 and row.pressed[0] == "Down"

    grid = FakeMenu(12, columns=2)  # Down jumps two entries
    assert cursor.steer(lambda: grid.at, grid.press, 5)
    assert grid.at == 5

    stuck = FakeMenu(4, keys=())
    assert not cursor.steer(lambda: stuck.at, stuck.press, 2)
    assert not cursor.steer(lambda: None, stuck.press, 2)


def test_summarize_shows_choice_labels_with_the_cursor():
    sample = {
        "choice": {"select": {"open": True, "options": [], "labels": ["是", "否"], "cursor": 1}}
    }
    assert "选项(select):是 / [否]" in view.summarize(sample, [])


def test_navigate_goes_on_past_the_planning_window(monkeypatch):
    # 10-20: sailing to Tule, the first leg ended at the window's edge and navigate gave up.
    at = [(182, 59)]
    legs = {(182, 59): [(182, 59), (160, 83)], (160, 83): [(160, 83), (146, 100)]}
    monkeypatch.setattr(move, "send", lambda *a, **k: {"pos": {"map": 1, "cell": at[0]}})
    monkeypatch.setattr(
        move, "plan", lambda laptop, goal, ship, cut: (at[0], legs.get(at[0], [at[0]]))
    )

    def walk(laptop, x, y, say):
        at[0] = (x, y)
        return {"ok": True}

    monkeypatch.setattr(move, "walk_leg", walk)
    assert move.navigate(None, (146, 100), True, say=lambda *_: None) == (True, "到达 (146, 100)")

    at[0] = (182, 59)
    legs[(160, 83)] = [(160, 83)]  # nothing closer from there
    reached, message = move.navigate(None, (146, 100), True, say=lambda *_: None)
    assert not reached and "最近" in message


def test_named_objects_keep_doors_and_drop_props():
    found = {
        "total": 4,
        "entities": [
            {"kind": "DefaultEntity", "cell": [17, 18], "name": "トルナ運河の開錠_右扉"},
            {"kind": "DefaultEntity", "cell": [39, 32], "name": "x", "active": False},
            {"kind": "DefaultEntity", "cell": [4, 0], "name": "【汎用】海賊船"},
            {"kind": "DefaultEntity", "cell": [128, 128], "name": ""},
        ],
    }
    kept = view.named_objects(found)
    assert kept["total"] == 1 and kept["entities"][0]["cell"] == [17, 18]


def test_navigate_goes_around_a_cell_that_turned_out_blocked(monkeypatch):
    # 10-20, Torna Canal: the gate's cells read as open water; the old loop walked into the
    # same gate eight times.
    at = (17, 19)
    plans = []

    def plan(laptop, goal, ship, cut):
        plans.append(set(cut))
        if ((17, 19), (17, 18)) in cut:
            return at, [at]  # nothing else leads there
        return at, [at, (17, 18), (17, 17)]

    monkeypatch.setattr(move, "send", lambda *a, **k: {"pos": {"map": 210, "cell": list(at)}})
    monkeypatch.setattr(move, "plan", plan)
    monkeypatch.setattr(
        move, "walk_leg", lambda *a: {"ok": False, "error": "blocked", "pos": {"cell": [17, 19]}}
    )
    reached, message = move.navigate(None, (17, 17), True, say=lambda *_: None)
    assert not reached and "最近" in message
    assert plans == [set(), {((17, 19), (17, 18))}]


def test_route_cells_from_the_games_pixel_points():
    # 10-20, map 215: from the stairs at (16,23) down and round to (13,23).
    route = {
        "from": [16, 23],
        "cells": [
            [16, -128, 249],
            [16, -144, 249],
            [16, -160, 249],
            [0, -160, 249],
            [0, -144, 249],
            [0, -128, 249],
            [-16, -128, 249],
            [-32, -128, 249],
        ],
    }
    assert move.route_cells(route) == [
        (16, 23),
        (16, 24),
        (16, 25),
        (15, 25),
        (15, 24),
        (15, 23),
        (14, 23),
        (13, 23),
    ]
    assert move.route_cells({"from": [1, 1], "cells": []}) == []


def test_a_blocked_step_closes_that_step_not_the_cell():
    # (2,1) cannot be entered from the left, but from below it can.
    cells = {"origin": [0, 0], "center": [0, 1], "attr": [[1, 1, 1], [0, 0, 0], [0, 0, 1]]}
    open_ = nav.floor_rule
    assert nav.path_toward(cells, (2, 1), open_) == [(0, 1), (1, 1), (2, 1)]
    cut = frozenset({((1, 1), (2, 1))})
    cells["attr"][2][2] = 0
    assert nav.path_toward(cells, (2, 1), open_, cut) == [(0, 1), (1, 1), (1, 2), (2, 2), (2, 1)]


def test_indoor_grid_merges_heights_and_marks_stairs():
    # Carwen, 10-20: the street on the bottom layer, a shop terrace on the ground layer.
    collision = {
        "playerCell": [0, 2],
        "layers": [
            {"name": "BottomCollision", "rows": ["111", "111", "000"]},
            {"name": "GroundCollision", "rows": ["110", "113", "111"]},
        ],
    }
    grid = nav.indoor_grid(collision, set())
    assert grid["attr"] == [[1, 1, 0], [1, 1, 0], [0, 0, 0]]
    assert grid["stairs"] == {(2, 1)}
    path = nav.path_toward(grid, (2, 0), nav.floor_rule)
    assert path == [(0, 2), (1, 2), (2, 2), (2, 1), (2, 0)]  # up the stairs to the terrace


def test_stairs_are_climbed_up_or_down_only():
    cells = {"origin": [0, 0], "center": [0, 1], "attr": [[0, 0, 0], [0, 0, 0], [0, 0, 0]]}
    cells["stairs"] = {(1, 1)}
    path = nav.path_toward(cells, (2, 1), nav.floor_rule)
    assert (1, 1) not in path and path[-1] == (2, 1)  # around the stairs, not across them
    up = nav.path_toward(dict(cells, center=[1, 2]), (1, 0), nav.floor_rule)
    assert up == [(1, 2), (1, 1), (1, 0)]  # straight up the stairs


def test_landing_spots_connect_to_the_entrance_on_foot():
    # Tycoon, 10-21: plains west of the castle are cut off by mountains (19); those south of
    # it connect over hills (7).
    attr = [
        [4, 19, 7, 10],  # 10 at (3,0): the castle entrance
        [19, 19, 7, 7],
        [4, 4, 7, 6],
    ]
    cells = {"origin": [0, 0], "center": [3, 0], "attr": attr}
    assert move.landing_spots(cells, (3, 0)) == [(1, 2), (0, 2)]
    assert (0, 0) not in move.landing_spots(cells, (3, 0))
    assert move.landing_spots(cells, None)[0] == (0, 0)  # without an entrance: nearest


def test_gear_is_bought_only_for_members_it_helps(monkeypatch):
    from ffpr_agent.skills import shop

    rows = [
        {"name": "巴兹", "canEquip": True, "up": True},
        {"name": "加拉夫", "canEquip": True, "up": False, "equipped": True},
        {"name": "蕾娜", "canEquip": False},
        {"name": "法利斯", "canEquip": True, "up": True},
    ]
    products = [{"name": "<IC_HEAD>铁盔", "buy": 350, "type": "Armor"}]
    state = {"open": True, "state": "SelectProduct", "listCursor": 0, "products": products}
    keys = []
    gil = iter([5000, 4300])
    monkeypatch.setattr(shop, "shop_state", lambda laptop: dict(state, party=rows))
    monkeypatch.setattr(shop, "open_products", lambda laptop, s: s)
    monkeypatch.setattr(shop, "move_cursor", lambda *a: None)
    monkeypatch.setattr(shop, "gil", lambda laptop: next(gil))
    monkeypatch.setattr(shop, "send", lambda laptop, op, **k: keys.append(k.get("keys")) or {})
    # The quantity window: count starts at 1 and Right raises it.
    trade = {"count": 1}

    def shop_state(laptop):
        if keys and keys[-1] == ["Right"]:
            trade["count"] += 1
            keys.append(None)
        return dict(state, party=rows, trade=dict(trade))

    monkeypatch.setattr(shop, "shop_state", shop_state)
    ok, text = shop.buy(None, "铁盔", 4)
    assert ok and "×2" in text and "只买 2 件" in text and "巴兹、法利斯" in text

    rows[0]["up"] = rows[3]["up"] = False
    ok, text = shop.buy(None, "铁盔", 1)
    assert (
        not ok and "没有人用得上" in text and "蕾娜 不能装备" in text and "加拉夫 已经装着" in text
    )


def test_layered_path_changes_height_only_by_stairs():
    # Street (bottom, z 0) along row 2; a terrace (ground, z 1) on row 0 with stairs at (2,1).
    # The terrace cell (0,1) sits right above the street's (0,2) but there is no way up there.
    collision = {
        "playerCell": [0, 2],
        "searchLayer": 0,
        "layers": [
            {"name": "BottomCollision", "rows": ["111", "111", "000"]},
            {"name": "GroundCollision", "rows": ["000", "013", "111"]},
        ],
    }
    grid = nav.layered_grid(collision, set())
    assert grid["z"] == 0 and set(grid["heights"]) == {0, 1}
    assert nav.layered_path(grid, (0, 0)) == [
        (0, 2),
        (1, 2),
        (2, 2),
        (2, 1),
        (2, 0),
        (1, 0),
        (0, 0),
    ]
    # Merged into one layer, (0,1) would have been a short cut from (0,2): not here.
    assert (0, 1) not in nav.layered_path(grid, (0, 0))
    # No stairs, no way up: the nearest reachable cell.
    collision["layers"][1]["rows"] = ["000", "011", "111"]
    assert nav.layered_path(nav.layered_grid(collision, set()), (0, 0))[-1] == (0, 2)


def test_find_row_scrolls_the_sell_list(monkeypatch):
    from ffpr_agent.skills import shop

    bag = ["恢复药", "帐篷", "皮帽", "皮衣", "宽刃剑", "铁盔", "青铜铠", "不死鸟之尾"]
    view = {"top": 0, "focus": 0}  # 4 rows in view

    def state(laptop):
        rows = [
            {"name": f"<IC_X>{n}", "focus": view["top"] + i == view["focus"]}
            for i, n in enumerate(bag[view["top"] : view["top"] + 4])
        ]
        return {"rows": rows}

    def send(laptop, op, **k):
        step = {"Down": 1, "Up": -1}[k["keys"][0]]
        view["focus"] = max(0, min(len(bag) - 1, view["focus"] + step))
        view["top"] = min(max(view["top"], view["focus"] - 3), view["focus"])

    monkeypatch.setattr(shop, "shop_state", state)
    monkeypatch.setattr(shop, "send", send)
    assert shop.find_row(None, "青铜铠")["name"] == "<IC_X>青铜铠" and view["focus"] == 6
    assert shop.find_row(None, "帐篷")["name"] == "<IC_X>帐篷" and view["focus"] == 1
    assert shop.find_row(None, "没有的东西") is None

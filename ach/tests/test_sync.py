from dataclasses import replace

from conftest import NOW
from ffpr_ach import categories, db
from ffpr_ach.sync import sync_game
from ffpr_common.games import by_key

FF5 = by_key("ff5")


def test_first_sync_stores_definitions_and_unlocks(conn, client, fake):
    fake.unlocked[FF5.app_id] = {"scenario_1": 1_700_000_000, "monster_hunt_100": 1_700_001_000}
    r = sync_game(conn, client, FF5, NOW)
    assert (r.total, r.unlocked) == (39, 2)
    assert sorted(r.new_unlocks) == ["monster_hunt_100", "scenario_1"]
    assert r.warnings == [] and r.player_error is None
    row = conn.execute(
        "SELECT unlocked_at, source FROM unlock WHERE api_name = 'scenario_1'"
    ).fetchone()
    assert row["unlocked_at"] == "2023-11-14T22:13:20+00:00"
    assert row["source"] == "steam_api"


def test_definitions_keep_both_languages_and_order(conn, client):
    sync_game(conn, client, FF5, NOW, include_player=False)
    rows = db.game_rows(conn, FF5.app_id)
    assert [r["ord"] for r in rows] == list(range(39))
    assert rows[0]["name_zh"] == "成就 1" and rows[0]["name_en"] == "Achievement 1"


def test_resync_is_idempotent(conn, client, fake):
    fake.unlocked[FF5.app_id] = {"scenario_1": 1_700_000_000}
    sync_game(conn, client, FF5, NOW)
    again = sync_game(conn, client, FF5, NOW)
    assert again.new_unlocks == [] and again.unlocked == 1
    assert conn.execute("SELECT COUNT(*) FROM achievement_def").fetchone()[0] == 39


def test_account_layer_only_grows(conn, client, fake):
    fake.unlocked[FF5.app_id] = {"scenario_1": 1_700_000_000}
    sync_game(conn, client, FF5, NOW)
    fake.unlocked[FF5.app_id] = {}
    assert sync_game(conn, client, FF5, NOW).unlocked == 1


def test_private_profile_still_syncs_definitions(conn, client, fake):
    fake.private = True
    r = sync_game(conn, client, FF5, NOW)
    assert r.total == 39 and r.unlocked == 0
    assert "公开" in r.player_error
    assert db.game_summary(conn, FF5.app_id)["player_error"] == r.player_error


def test_count_mismatch_is_flagged(conn, client):
    r = sync_game(conn, client, replace(FF5, achievement_count=40), NOW, include_player=False)
    assert r.warnings and "40" in r.warnings[0]


def test_categories_from_api_names(conn, client):
    assert categories.classify("treasure_box_21") == "宝箱"
    assert categories.classify("scenario_12") == "剧情"
    assert categories.classify("job_master_1") == "职业"
    assert categories.classify("piano_master") == categories.OTHER
    sync_game(conn, client, FF5, NOW, include_player=False)
    got = dict(conn.execute("SELECT api_name, category FROM achievement_def").fetchall())
    assert got["monster_hunt_100"] == "击杀"
    assert got["ultimate_omega"] == categories.OTHER

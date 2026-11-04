from conftest import NOW
from ffpr_ach import report
from ffpr_ach.sync import sync_game
from ffpr_common.games import by_key

FF5 = by_key("ff5")


def test_report_summarises_all_games_and_lists_synced_ones(conn, client, fake):
    fake.unlocked[FF5.app_id] = {"scenario_1": 1_700_000_000, "monster_hunt_100": 1_700_001_000}
    sync_game(conn, client, FF5, NOW)
    text = report.render(conn, NOW)
    assert "| FF5 | 2 | 39 | 5.1% |" in text
    assert "| FF1 | 0 | 24 | 0.0% | 未同步 |" in text
    assert "| 合计 | 2 | 189 | 1.1% | |" in text
    assert "## FF5 FINAL FANTASY V(2/39)" in text
    assert "## FF1" not in text
    hidden_row = next(line for line in text.splitlines() if "| 成就 1 |" in line)
    assert "Steam 未提供说明" in hidden_row and hidden_row.endswith("| 隐藏 |")
    # Unlocks from past years must keep the year (2023-11-14/15 depending on the local zone).
    assert hidden_row.startswith("| 已解锁 2023-11-1")


def test_report_mentions_private_profile(conn, client, fake):
    fake.private = True
    sync_game(conn, client, FF5, NOW)
    assert "> 读不到解锁状态" in report.render(conn, NOW)


def test_cells_escape_markdown_pipes():
    assert report._cell("a|b\nc") == "a\\|b c"
    assert report._cell("") == "—"


def test_write_replaces_file_atomically(conn, client, tmp_path):
    sync_game(conn, client, FF5, NOW, include_player=False)
    out = tmp_path / "sub" / "achievements.md"
    report.write(conn, out, NOW)
    assert out.read_text(encoding="utf-8").startswith("# 成就记录")
    assert not list(out.parent.glob("*.tmp"))

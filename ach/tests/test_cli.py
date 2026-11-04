import pytest

from conftest import KEY, NOW, STEAM_ID
from ffpr_ach.cli import main


@pytest.fixture
def secrets(tmp_path):
    f = tmp_path / "secrets.env"
    f.write_text(f"STEAM_WEB_API_KEY={KEY}\nSTEAM_ID64={STEAM_ID}\n", encoding="utf-8")
    f.chmod(0o600)
    return f


@pytest.fixture
def run(tmp_path, fake, monkeypatch):
    monkeypatch.delenv("STEAM_WEB_API_KEY", raising=False)
    monkeypatch.delenv("STEAM_ID64", raising=False)

    def _run(*args):
        return main(
            ["--data-dir", str(tmp_path / "data"), *args], http=fake.http(), now=lambda: NOW
        )

    return _run


def test_sync_then_status_and_show(run, secrets, fake, tmp_path, capsys):
    fake.unlocked[1173810] = {"scenario_1": 1_700_000_000}
    assert run("--secrets", str(secrets), "sync", "--game", "ff5") == 0
    out = capsys.readouterr().out
    assert "FF5:成就定义 39 个,已解锁 1 个,本次新增 1 个" in out
    assert (tmp_path / "data" / "achievements.md").exists()

    assert run("status") == 0
    status = capsys.readouterr().out
    assert "FF5" in status and "合计" in status and "未同步" in status

    assert run("show", "ff5") == 0
    show = capsys.readouterr().out
    assert show.startswith("FF5 FINAL FANTASY V(1/39)")
    assert "✓" in show and "2023-11-1" in show


def test_unknown_game_is_a_clean_error(run, capsys):
    assert run("show", "ff9") == 1
    assert "未知的作品 'ff9'" in capsys.readouterr().err


def test_missing_key_points_to_secrets_file(run, tmp_path, capsys):
    empty = tmp_path / "empty.env"
    empty.write_text("", encoding="utf-8")
    assert run("--secrets", str(empty), "sync") == 1
    err = capsys.readouterr().err
    assert "STEAM_WEB_API_KEY" in err and str(empty) in err


def test_private_profile_fails_but_keeps_definitions(run, secrets, fake, capsys):
    fake.private = True
    assert run("--secrets", str(secrets), "sync", "--game", "ff5") == 1
    out = capsys.readouterr().out
    assert "FF5:成就定义 39 个" in out and "公开" in out


def test_verify_counts_needs_no_secrets(run, capsys):
    assert run("verify-counts") == 0
    out = capsys.readouterr().out
    assert out.count("一致") == 6


def test_key_never_reaches_output(run, secrets, fake, capsys):
    fake.fail_next = [401]
    assert run("--secrets", str(secrets), "-v", "sync", "--game", "ff5") == 1
    captured = capsys.readouterr()
    assert KEY not in captured.out + captured.err

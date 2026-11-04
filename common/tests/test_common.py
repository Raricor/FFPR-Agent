import logging

import pytest

from ffpr_common import games, paths
from ffpr_common.redact import MASK, RedactingFilter, Redactor
from ffpr_common.secrets import MissingSecret, Secrets, parse_env_file


def test_registry_matches_steam_total():
    assert games.TOTAL_ACHIEVEMENTS == 189
    assert games.by_key("FF5").app_id == 1173810
    assert games.by_app_id(1173820).key == "ff6"
    with pytest.raises(games.UnknownGame):
        games.by_key("ff7")


def test_parse_env_file_handles_comments_quotes_and_bom_free_text():
    text = '# comment\n\nSTEAM_WEB_API_KEY = "abc123"\nSTEAM_ID64=7656\nnot a pair\n'
    assert parse_env_file(text) == {"STEAM_WEB_API_KEY": "abc123", "STEAM_ID64": "7656"}


def test_secrets_prefers_environment_and_reports_missing(tmp_path):
    f = tmp_path / "secrets.env"
    f.write_text("A=from_file\nB=only_file\n", encoding="utf-8")
    f.chmod(0o600)
    s = Secrets.load(f, environ={"A": "from_env"})
    assert s.get("A") == "from_env"
    assert s.get("B") == "only_file"
    assert not s.has("C")
    with pytest.raises(MissingSecret) as err:
        s.get("C")
    assert "C" in str(err.value) and str(f) in str(err.value)


def test_secrets_file_with_utf8_bom(tmp_path):
    f = tmp_path / "secrets.env"
    f.write_bytes("﻿KEY=value\n".encode())
    f.chmod(0o600)
    assert Secrets.load(f, environ={}).get("KEY") == "value"


def test_secrets_warns_when_file_is_world_readable(tmp_path, caplog):
    f = tmp_path / "secrets.env"
    f.write_text("KEY=value\n", encoding="utf-8")
    f.chmod(0o644)
    with caplog.at_level(logging.WARNING):
        Secrets.load(f, environ={})
    assert "chmod 600" in caplog.text


def test_redactor_masks_long_values_only():
    r = Redactor()
    r.add("SECRETKEY123456")
    r.add("abc")
    assert r("url?key=SECRETKEY123456&x=abc") == f"url?key={MASK}&x=abc"


def test_redacting_filter_rewrites_formatted_message():
    r = Redactor()
    r.add("SECRETKEY123456")
    record = logging.LogRecord(
        "t", logging.INFO, __file__, 1, "GET %s", ("k=SECRETKEY123456",), None
    )
    RedactingFilter(r).filter(record)
    assert record.getMessage() == f"GET k={MASK}"


def test_paths_respect_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("FFPR_DATA_DIR", str(tmp_path / "d"))
    monkeypatch.setenv("FFPR_CONFIG_DIR", str(tmp_path / "c"))
    monkeypatch.delenv("FFPR_SECRETS", raising=False)
    assert paths.data_dir() == tmp_path / "d"
    assert paths.secrets_path() == tmp_path / "c" / "secrets.env"


def test_store_replaces_a_value_and_keeps_the_file_private(tmp_path):
    import stat

    from ffpr_common.secrets import Secrets, store

    path = tmp_path / "secrets.env"
    path.write_text("# 注释\nDEEPSEEK_API_KEY=sk-one\nBRIDGE_TOKEN=old\n", encoding="utf-8")
    store(path, "BRIDGE_TOKEN", "new-token")
    store(path, "STEAM_ID64", "7656")
    text = path.read_text(encoding="utf-8")
    assert text.count("BRIDGE_TOKEN=") == 1 and "# 注释" in text
    secrets = Secrets.load(path, environ={})
    assert (
        secrets.get("BRIDGE_TOKEN") == "new-token" and secrets.get("DEEPSEEK_API_KEY") == "sk-one"
    )
    assert stat.S_IMODE(path.stat().st_mode) == 0o600

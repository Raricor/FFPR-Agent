import base64
import json

import pytest

from ffpr_agent import laptop


def test_encoded_command_round_trips_chinese_and_quotes():
    script = "Write-Host '你好' \"x\""
    decoded = base64.b64decode(laptop.encode_ps(script)).decode("utf-16-le")
    assert decoded == laptop.PS_PRELUDE + script


def test_ps_quote_doubles_single_quotes():
    assert laptop.ps_quote("C:/ffpr/it's") == "'C:/ffpr/it''s'"


def test_session_request_shape():
    req = laptop.session_request("steam://rungameid/1173810", [], None, False)
    assert set(req) == {"id", "file", "args", "cwd", "wait"}
    assert len(req["id"]) == 12
    json.dumps(req)


def test_laptop_config_errors_and_defaults(tmp_path):
    with pytest.raises(laptop.ConfigError, match=r"laptop\.env\.example"):
        laptop.Laptop.load(tmp_path / "missing.env")
    f = tmp_path / "laptop.env"
    f.write_text("LAPTOP_HOST=10.0.0.2\n", encoding="utf-8")
    with pytest.raises(laptop.ConfigError, match="LAPTOP_USER"):
        laptop.Laptop.load(f)
    f.write_text("LAPTOP_HOST=10.0.0.2\nLAPTOP_USER=me\n", encoding="utf-8")
    lp = laptop.Laptop.load(f)
    assert lp.target == "me@10.0.0.2" and lp.root == "C:/ffpr"
    assert lp.key.name == "ffpr_laptop_ed25519"
    assert lp.ssh()[-1] == "me@10.0.0.2" and "BatchMode=yes" in lp.ssh()
    assert "IdentitiesOnly=yes" in lp.ssh()


def test_decode_clixml_recovers_errors_and_warnings():
    # Shape recorded from powershell.exe 5.1 over SSH on the laptop (2026-10-19).
    raw = (
        "#< CLIXML\r\n"
        '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
        '<S S="Error">Get-Service : 找不到任何服务名称为“sshd”的服务。_x000D__x000A_</S>'
        '<S S="Error">+ Get-Service sshd &amp; more_x000D__x000A_</S>'
        '<S S="warning">注意一下_x000D__x000A_</S></Objs>'
    )
    assert laptop.decode_clixml(raw) == (
        "Get-Service : 找不到任何服务名称为“sshd”的服务。\n"
        "+ Get-Service sshd & more\n"
        "警告:注意一下\n"
    )
    assert laptop.decode_clixml("plain text\n") == "plain text\n"


def test_deploy_locks_the_root_to_known_accounts(tmp_path):
    f = tmp_path / "laptop.env"
    f.write_text("LAPTOP_HOST=h\nLAPTOP_USER=ffpr\n", encoding="utf-8")
    with pytest.raises(laptop.ConfigError, match="LAPTOP_DESKTOP_USER"):
        laptop.secure_root_script(laptop.Laptop.load(f))

    f.write_text(
        "LAPTOP_HOST=h\nLAPTOP_USER=ffpr\nLAPTOP_DESKTOP_USER=MIFEITECH\\yangwt\n", encoding="utf-8"
    )
    script = laptop.secure_root_script(laptop.Laptop.load(f))
    assert "[Security.Principal.NTAccount]'MIFEITECH\\yangwt'" in script
    assert "/inheritance:r" in script and "*S-1-5-18:(OI)(CI)F" in script

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_ps_scripts


def test_bom_check_and_fix(tmp_path):
    good = tmp_path / "good.ps1"
    bad = tmp_path / "bad.psm1"
    good.write_bytes(check_ps_scripts.BOM + "Write-Host '好'".encode())
    bad.write_bytes("Write-Host '坏'".encode())
    scripts = check_ps_scripts.find_scripts(tmp_path)
    assert check_ps_scripts.missing_bom(scripts) == [bad]
    check_ps_scripts.main([str(tmp_path), "--fix"])
    assert check_ps_scripts.missing_bom(scripts) == []


def test_repo_scripts_have_bom():
    root = Path(__file__).resolve().parents[2] / "deploy" / "laptop"
    assert check_ps_scripts.missing_bom(check_ps_scripts.find_scripts(root)) == []

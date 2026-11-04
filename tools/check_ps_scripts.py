"""Check the laptop PowerShell scripts: each starts with a UTF-8 BOM and parses cleanly.

Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page, which garbles Chinese text.
Parsing needs pwsh on the dev box; without it only the BOM check runs.

    python tools/check_ps_scripts.py deploy/laptop          # check
    python tools/check_ps_scripts.py deploy/laptop --fix    # add missing BOMs
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BOM = b"\xef\xbb\xbf"

PARSE_SCRIPT = r"""
foreach ($path in $args) {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
    foreach ($e in $errors) { '{0}:{1}: {2}' -f $path, $e.Extent.StartLineNumber, $e.Message }
}
"""


def find_scripts(root: Path) -> list[Path]:
    return sorted([*root.rglob("*.ps1"), *root.rglob("*.psm1")])


def missing_bom(scripts: list[Path]) -> list[Path]:
    return [s for s in scripts if not s.read_bytes().startswith(BOM)]


def parse_errors(scripts: list[Path]) -> list[str] | None:
    pwsh = shutil.which("pwsh")
    if not pwsh or not scripts:
        return None
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8") as f:
        f.write(PARSE_SCRIPT)
    try:
        out = subprocess.run(
            [pwsh, "-NoProfile", "-NonInteractive", "-File", f.name, *map(str, scripts)],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    finally:
        Path(f.name).unlink()
    return [line for line in out.splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("root", type=Path)
    parser.add_argument("--fix", action="store_true", help="给缺少 BOM 的脚本补上 BOM")
    args = parser.parse_args(argv)

    scripts = find_scripts(args.root)
    failed = False
    for script in missing_bom(scripts):
        if args.fix:
            script.write_bytes(BOM + script.read_bytes())
            print(f"已补 BOM:{script}")
        else:
            print(f"{script}: 缺少 UTF-8 BOM(加 --fix 自动补上)")
            failed = True

    errors = parse_errors(scripts)
    if errors is None:
        print("未安装 pwsh,跳过语法检查")
    for line in errors or []:
        print(line)
        failed = True
    if not failed:
        print(f"{len(scripts)} 个 PowerShell 脚本检查通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

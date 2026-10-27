"""API keys come from secrets.env (KEY=VALUE lines) or the process environment.

Values never appear in error messages; callers register them with a Redactor before logging.
"""

import logging
import os
import stat
from collections.abc import Mapping
from pathlib import Path

from ffpr_common.paths import secrets_path

log = logging.getLogger(__name__)


class MissingSecret(KeyError):
    def __init__(self, name: str, path: Path):
        super().__init__(name)
        self.name = name
        self.path = path

    def __str__(self) -> str:
        return f"缺少 {self.name}:请写进 {self.path},或者设置同名环境变量"


def parse_env_file(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name.strip()] = value
    return values


class Secrets:
    def __init__(self, file_values: Mapping[str, str], path: Path, environ: Mapping[str, str]):
        self._file = dict(file_values)
        self._environ = environ
        self.path = path

    @classmethod
    def load(cls, path: Path | None = None, environ: Mapping[str, str] | None = None) -> "Secrets":
        path = path or secrets_path()
        file_values: dict[str, str] = {}
        if path.exists():
            _warn_if_readable_by_others(path)
            file_values = parse_env_file(path.read_text(encoding="utf-8-sig"))
        return cls(file_values, path, os.environ if environ is None else environ)

    def get(self, name: str) -> str:
        # The environment wins, so a one-off override needs no file edit.
        value = self._environ.get(name) or self._file.get(name, "")
        if not value:
            raise MissingSecret(name, self.path)
        return value

    def has(self, name: str) -> bool:
        return bool(self._environ.get(name) or self._file.get(name))


def store(path: Path, name: str, value: str) -> None:
    """Set NAME=value in a secrets file (replacing an existing line), readable only by us."""
    lines = path.read_text(encoding="utf-8-sig").splitlines() if path.exists() else []
    kept = [line for line in lines if line.partition("=")[0].strip() != name]
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join([*kept, f"{name}={value}"]) + "\n")
    if os.name != "nt":
        os.chmod(path, 0o600)


def _warn_if_readable_by_others(path: Path) -> None:
    if os.name == "nt":
        return
    mode = path.stat().st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        log.warning("%s 对其他用户可读,建议执行 chmod 600 %s", path, path)

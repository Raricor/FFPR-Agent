"""Where FFPR-Agent keeps its data and configuration on each machine.

Windows (the laptop): data in %LOCALAPPDATA%\\FFPR-Agent, config in %APPDATA%\\FFPR-Agent.
Linux (the dev box): data in $XDG_DATA_HOME/ffpr-agent, config in $XDG_CONFIG_HOME/ffpr-agent.
FFPR_DATA_DIR and FFPR_CONFIG_DIR override both.
"""

import os
from pathlib import Path


def _windows_dir(env_var: str) -> Path:
    base = os.environ.get(env_var)
    if not base:
        raise RuntimeError(f"环境变量 {env_var} 未设置")
    return Path(base) / "FFPR-Agent"


def _xdg_dir(env_var: str, fallback: str) -> Path:
    base = os.environ.get(env_var) or str(Path.home() / fallback)
    return Path(base) / "ffpr-agent"


def data_dir() -> Path:
    if override := os.environ.get("FFPR_DATA_DIR"):
        return Path(override)
    if os.name == "nt":
        return _windows_dir("LOCALAPPDATA")
    return _xdg_dir("XDG_DATA_HOME", ".local/share")


def config_dir() -> Path:
    if override := os.environ.get("FFPR_CONFIG_DIR"):
        return Path(override)
    if os.name == "nt":
        return _windows_dir("APPDATA")
    return _xdg_dir("XDG_CONFIG_HOME", ".config")


def secrets_path() -> Path:
    if override := os.environ.get("FFPR_SECRETS"):
        return Path(override)
    return config_dir() / "secrets.env"

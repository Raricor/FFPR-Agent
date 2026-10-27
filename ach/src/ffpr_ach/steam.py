"""The Steam Web API calls the recorder needs.

The key travels in the query string, so URLs never go into exceptions or log lines.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

BASE_URL = "https://api.steampowered.com"
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


class SteamError(Exception):
    pass


class PrivateProfileError(SteamError):
    pass


@dataclass(frozen=True)
class AchievementDef:
    api_name: str
    name: str
    description: str  # Empty when Steam withholds it, as it does for some hidden achievements.
    hidden: bool


@dataclass(frozen=True)
class PlayerAchievement:
    api_name: str
    achieved: bool
    unlock_time: int  # Unix seconds; 0 while locked.


class SteamClient:
    def __init__(
        self,
        http: httpx.Client,
        key: str | None = None,
        steam_id: str | None = None,
        *,
        retries: int = 3,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._http = http
        self._key = key
        self._steam_id = steam_id
        self._retries = retries
        self._sleep = sleep

    @classmethod
    def create(cls, key: str | None = None, steam_id: str | None = None) -> "SteamClient":
        http = httpx.Client(base_url=BASE_URL, timeout=15.0, headers={"User-Agent": "ffpr-ach/0.1"})
        return cls(http, key, steam_id)

    def schema(self, app_id: int, lang: str) -> list[AchievementDef]:
        data = self._get(
            "/ISteamUserStats/GetSchemaForGame/v2/",
            {"key": self._require_key(), "appid": app_id, "l": lang},
            what=f"读取 {app_id} 的成就定义",
        )
        items = data.get("game", {}).get("availableGameStats", {}).get("achievements", [])
        return [
            AchievementDef(
                api_name=item["name"],
                name=item.get("displayName", ""),
                description=item.get("description", ""),
                hidden=bool(item.get("hidden", 0)),
            )
            for item in items
        ]

    def player_achievements(self, app_id: int, lang: str) -> list[PlayerAchievement]:
        if not self._steam_id:
            raise SteamError("没有配置 STEAM_ID64")
        what = f"读取 {app_id} 的解锁状态"
        data = self._get(
            "/ISteamUserStats/GetPlayerAchievements/v1/",
            {"key": self._require_key(), "steamid": self._steam_id, "appid": app_id, "l": lang},
            what=what,
        )
        stats = data.get("playerstats", {})
        if not stats.get("success", False):
            raise _player_error(what, stats.get("error", ""))
        return [
            PlayerAchievement(
                api_name=item["apiname"],
                achieved=bool(item.get("achieved", 0)),
                unlock_time=int(item.get("unlocktime", 0)),
            )
            for item in stats.get("achievements", [])
        ]

    def public_achievement_names(self, app_id: int) -> list[str]:
        """Every achievement's API name, from an endpoint that needs no key."""
        data = self._get(
            "/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
            {"gameid": app_id},
            what=f"读取 {app_id} 的公开成就列表",
        )
        items = data.get("achievementpercentages", {}).get("achievements", [])
        return [item["name"] for item in items]

    def _require_key(self) -> str:
        if not self._key:
            raise SteamError("没有配置 STEAM_WEB_API_KEY")
        return self._key

    def _get(self, path: str, params: dict[str, Any], *, what: str) -> dict[str, Any]:
        reason = ""
        for attempt in range(self._retries + 1):
            try:
                resp = self._http.get(path, params=params)
            except httpx.TransportError as exc:
                reason = f"网络错误({type(exc).__name__})"
            else:
                if resp.status_code == 200:
                    return resp.json()
                if resp.status_code not in RETRY_STATUS:
                    raise _http_error(what, resp)
                reason = f"HTTP {resp.status_code}"
            if attempt < self._retries:
                self._sleep(2.0**attempt)
        raise SteamError(f"{what}失败:{reason},已重试 {self._retries} 次")


def _http_error(what: str, resp: httpx.Response) -> SteamError:
    if resp.status_code in (400, 403):
        try:
            message = resp.json().get("playerstats", {}).get("error", "")
        except ValueError:
            message = ""
        if message:
            return _player_error(what, message)
    if resp.status_code in (401, 403):
        return SteamError(f"{what}失败:key 无效或没有权限(HTTP {resp.status_code})")
    return SteamError(f"{what}失败:HTTP {resp.status_code}")


def _player_error(what: str, message: str) -> SteamError:
    if "not public" in message.lower():
        return PrivateProfileError(
            f"{what}失败:Steam 个人资料的游戏详情不是公开的。"
            "请在 Steam 的隐私设置里把「游戏详情」设为公开"
        )
    return SteamError(f"{what}失败:{message or '未知错误'}")

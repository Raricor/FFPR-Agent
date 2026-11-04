import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from ffpr_ach import db
from ffpr_ach.steam import BASE_URL, SteamClient

FIXTURES = Path(__file__).parent / "fixtures"
KEY = "TESTKEY0123456789ABCDEF"
STEAM_ID = "76561190000000000"
NOW = datetime(2026, 10, 19, 12, 0, tzinfo=UTC)


def public_names(app_id: int) -> list[str]:
    """Real API names, recorded from Steam's keyless endpoint on 2026-10-19."""
    data = json.loads((FIXTURES / "public" / f"{app_id}.json").read_text(encoding="utf-8"))
    return [a["name"] for a in data["achievementpercentages"]["achievements"]]


class FakeSteam:
    """Serves the three Steam endpoints from memory, in the real response shapes."""

    def __init__(self) -> None:
        self.unlocked: dict[int, dict[str, int]] = {}  # app_id -> api_name -> unlock time
        self.private = False
        self.fail_next: list[int] = []  # HTTP statuses returned before normal answers
        self.calls: list[httpx.Request] = []

    @staticmethod
    def schema(app_id: int, lang: str) -> dict:
        zh = lang == "schinese"
        items = []
        for i, name in enumerate(public_names(app_id), start=1):
            hidden = name.startswith("scenario")
            item = {
                "name": name,
                "defaultvalue": 0,
                "displayName": f"{'成就' if zh else 'Achievement'} {i}",
                "hidden": int(hidden),
                "icon": "",
                "icongray": "",
            }
            if not hidden:  # Steam omits descriptions of hidden achievements.
                item["description"] = f"{'说明' if zh else 'Description'} {i}"
            items.append(item)
        return {
            "game": {
                "gameName": "x",
                "gameVersion": "1",
                "availableGameStats": {"achievements": items},
            }
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.fail_next:
            return httpx.Response(self.fail_next.pop(0))
        q = request.url.params
        path = request.url.path
        app_id = int(q.get("appid") or q.get("gameid"))
        if path.endswith("/GetSchemaForGame/v2/"):
            return httpx.Response(200, json=self.schema(app_id, q["l"]))
        if path.endswith("/GetPlayerAchievements/v1/"):
            if self.private:
                return httpx.Response(
                    403, json={"playerstats": {"error": "Profile is not public", "success": False}}
                )
            got = self.unlocked.get(app_id, {})
            items = [
                {"apiname": n, "achieved": int(n in got), "unlocktime": got.get(n, 0)}
                for n in public_names(app_id)
            ]
            return httpx.Response(
                200,
                json={
                    "playerstats": {
                        "steamID": STEAM_ID,
                        "gameName": "x",
                        "achievements": items,
                        "success": True,
                    }
                },
            )
        if path.endswith("/GetGlobalAchievementPercentagesForApp/v2/"):
            return httpx.Response(
                200, content=(FIXTURES / "public" / f"{app_id}.json").read_bytes()
            )
        return httpx.Response(404)

    def http(self) -> httpx.Client:
        return httpx.Client(base_url=BASE_URL, transport=httpx.MockTransport(self.handler))


@pytest.fixture
def fake() -> FakeSteam:
    return FakeSteam()


@pytest.fixture
def client(fake: FakeSteam) -> SteamClient:
    return SteamClient(fake.http(), KEY, STEAM_ID, sleep=lambda _: None)


@pytest.fixture
def conn():
    c = db.connect(":memory:")
    yield c
    c.close()

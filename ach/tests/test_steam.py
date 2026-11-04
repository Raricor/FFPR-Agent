import httpx
import pytest

from conftest import KEY, STEAM_ID
from ffpr_ach.steam import BASE_URL, PrivateProfileError, SteamClient, SteamError

FF5 = 1173810


def test_schema_keeps_hidden_achievements_without_description(client):
    defs = client.schema(FF5, "schinese")
    assert len(defs) == 39
    hidden = [d for d in defs if d.hidden]
    assert hidden and all(d.description == "" for d in hidden)
    assert all(d.description for d in defs if not d.hidden)


def test_player_achievements(client, fake):
    fake.unlocked[FF5] = {"scenario_1": 1_700_000_000}
    got = {p.api_name: p for p in client.player_achievements(FF5, "schinese")}
    assert got["scenario_1"].achieved and got["scenario_1"].unlock_time == 1_700_000_000
    assert not got["monster_hunt_100"].achieved


def test_private_profile_is_reported_as_such(client, fake):
    fake.private = True
    with pytest.raises(PrivateProfileError, match="公开"):
        client.player_achievements(FF5, "schinese")


def test_retries_transient_errors_then_succeeds(client, fake):
    fake.fail_next = [500, 503]
    assert len(client.schema(FF5, "english")) == 39
    assert len(fake.calls) == 3


def test_gives_up_after_configured_retries(fake):
    c = SteamClient(fake.http(), KEY, STEAM_ID, retries=2, sleep=lambda _: None)
    fake.fail_next = [500] * 5
    with pytest.raises(SteamError, match="已重试 2 次"):
        c.schema(FF5, "english")
    assert len(fake.calls) == 3


def test_rejected_key_error_does_not_leak_the_key(client, fake):
    fake.fail_next = [401]
    with pytest.raises(SteamError) as err:
        client.schema(FF5, "english")
    assert "key 无效" in str(err.value)
    assert KEY not in str(err.value)


def test_network_errors_are_retried():
    attempts = []

    def flaky(request):
        attempts.append(request)
        if len(attempts) < 2:
            raise httpx.ConnectError("boom", request=request)
        return httpx.Response(
            200, json={"achievementpercentages": {"achievements": [{"name": "a"}]}}
        )

    http = httpx.Client(base_url=BASE_URL, transport=httpx.MockTransport(flaky))
    assert SteamClient(http, sleep=lambda _: None).public_achievement_names(FF5) == ["a"]
    assert len(attempts) == 2


def test_key_and_steam_id_are_required_where_needed(fake):
    c = SteamClient(fake.http())
    with pytest.raises(SteamError, match="STEAM_WEB_API_KEY"):
        c.schema(FF5, "english")
    with pytest.raises(SteamError, match="STEAM_ID64"):
        SteamClient(fake.http(), KEY).player_achievements(FF5, "english")


def test_public_names_need_no_key(fake):
    names = SteamClient(fake.http()).public_achievement_names(FF5)
    assert len(names) == 39
    assert "key" not in fake.calls[0].url.params

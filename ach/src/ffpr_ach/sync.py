"""Pull achievement definitions and unlock state from Steam into achievements.db."""

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ffpr_ach import categories, db
from ffpr_ach.steam import PrivateProfileError, SteamClient
from ffpr_common.games import Game


@dataclass
class SyncResult:
    game: Game
    total: int
    unlocked: int
    new_unlocks: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    player_error: str | None = None


def iso(ts: datetime) -> str:
    return ts.astimezone(UTC).isoformat(timespec="seconds")


def sync_game(
    conn: sqlite3.Connection,
    client: SteamClient,
    game: Game,
    now: datetime,
    *,
    include_player: bool = True,
) -> SyncResult:
    # All network calls happen before the write transaction starts.
    zh = client.schema(game.app_id, "schinese")
    en = {d.api_name: d for d in client.schema(game.app_id, "english")}
    player = None
    player_error = None
    if include_player:
        try:
            player = client.player_achievements(game.app_id, "schinese")
        except PrivateProfileError as exc:
            player_error = str(exc)

    warnings = []
    if len(zh) != game.achievement_count:
        warnings.append(
            f"{game.label}:Steam 返回 {len(zh)} 个成就,登记的是 {game.achievement_count} 个"
        )

    stamp = iso(now)
    new_unlocks = []
    with conn:
        for ord, d in enumerate(zh):
            english = en.get(d.api_name)
            db.upsert_def(
                conn,
                app_id=game.app_id,
                api_name=d.api_name,
                ord=ord,
                name_zh=d.name,
                desc_zh=d.description,
                name_en=english.name if english else "",
                desc_en=english.description if english else "",
                hidden=d.hidden,
                category=categories.classify(d.api_name),
                now=stamp,
            )
        for p in player or []:
            if not p.achieved:
                continue
            unlocked_at = iso(datetime.fromtimestamp(p.unlock_time, UTC)) if p.unlock_time else None
            if db.record_unlock(
                conn,
                app_id=game.app_id,
                api_name=p.api_name,
                unlocked_at=unlocked_at,
                source="steam_api",
                now=stamp,
            ):
                new_unlocks.append(p.api_name)
        db.record_sync(conn, app_id=game.app_id, now=stamp, player_error=player_error)

    summary = db.game_summary(conn, game.app_id)
    return SyncResult(
        game=game,
        total=summary["total"],
        unlocked=summary["unlocked"],
        new_unlocks=new_unlocks,
        warnings=warnings,
        player_error=player_error,
    )

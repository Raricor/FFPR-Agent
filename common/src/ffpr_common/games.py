"""The six Pixel Remaster titles on Steam."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Game:
    key: str
    app_id: int
    title: str
    # Checked against Steam's public achievement list on 2026-10-19.
    achievement_count: int

    @property
    def label(self) -> str:
        return self.key.upper()


GAMES: tuple[Game, ...] = (
    Game("ff1", 1173770, "FINAL FANTASY", 24),
    Game("ff2", 1173780, "FINAL FANTASY II", 28),
    Game("ff3", 1173790, "FINAL FANTASY III", 31),
    Game("ff4", 1173800, "FINAL FANTASY IV", 30),
    Game("ff5", 1173810, "FINAL FANTASY V", 39),
    Game("ff6", 1173820, "FINAL FANTASY VI", 37),
)

TOTAL_ACHIEVEMENTS = sum(g.achievement_count for g in GAMES)


class UnknownGame(LookupError):
    pass


def by_key(key: str) -> Game:
    for game in GAMES:
        if game.key == key.lower():
            return game
    known = ", ".join(g.key for g in GAMES)
    raise UnknownGame(f"未知的作品 {key!r},可选:{known}")


def by_app_id(app_id: int) -> Game:
    for game in GAMES:
        if game.app_id == app_id:
            return game
    raise UnknownGame(f"未知的 App ID {app_id}")

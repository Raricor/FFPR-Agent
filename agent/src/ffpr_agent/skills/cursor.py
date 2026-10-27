"""Finding menu entries by name and moving a menu cursor onto them."""

from ffpr_agent import laptop as lp
from ffpr_agent.pilot import send


def pick(names: list[str | None], wanted: str) -> int | None:
    """Index of the entry whose name matches `wanted` (exact first, then containment)."""
    for i, name in enumerate(names):
        if name == wanted:
            return i
    for i, name in enumerate(names):
        if name and wanted and (wanted in name or name in wanted):
            return i
    return None


def move_cursor(laptop: lp.Laptop, at: int, to: int) -> None:
    if to != at:
        key = "Down" if to > at else "Up"
        send(laptop, "keys", keys=[f"{key}*{abs(to - at)}"], gap=110)


def steer(read, press, target: int, tries: int = 40) -> bool:
    """Move a menu cursor to `target` one key at a time, reading the cursor after each press.
    Lists go Up/Down; when Down does not move the cursor (a row of commands) or jumps past
    the target (a two-column grid), Right/Left take over. False if the cursor gets stuck."""
    keys = ("Down", "Up")
    for _ in range(tries):
        at = read()
        if at is None:
            return False
        if at == target:
            return True
        forward = at < target
        press(keys[0] if forward else keys[1])
        now = read()
        stuck = now == at
        overshot = now is not None and (now > target if forward else now < target)
        if stuck and keys == ("Right", "Left"):
            return False
        if stuck or overshot:
            keys = ("Right", "Left")
    return read() == target

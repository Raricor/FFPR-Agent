"""Saving and loading, checked against the save list the bridge reads (0.3.0+)."""

import time

from ffpr_agent import laptop as lp
from ffpr_agent.pilot import query, send
from ffpr_agent.skills.cursor import steer
from ffpr_agent.skills.menu import leave_menu, menu_state, wait_menu


def highlighted_slot(ui: dict) -> int | None:
    """The slot id under the cursor. `slots` lists slot ids in display order (the first two are
    special slots, 21 and 22); `cursor` indexes it. CurrentSlotData is unset in the load list."""
    slots, cursor = ui.get("slots") or [], ui.get("cursor")
    if cursor is not None and 0 <= cursor < len(slots):
        return slots[cursor]
    return ui.get("current")


def move_to_slot(laptop: lp.Laptop, ui: dict, slot: int) -> dict | None:
    """Move the list cursor onto `slot` by display position; returns the final ui or None."""
    slots = ui.get("slots") or []
    if slot not in slots:
        return None
    for _ in range(len(slots) + 2):
        here = highlighted_slot(ui)
        if here == slot:
            return ui
        target, at = slots.index(slot), ui.get("cursor") or 0
        key = "Down" if target > at else "Up"
        send(laptop, "keys", keys=[f"{key}*{abs(target - at)}"], gap=150)
        ui = query(laptop, "saveui").get("saveui") or {}
    return None


def save_ui(laptop: lp.Laptop, ok=lambda ui: ui.get("open"), timeout: float = 3.0) -> dict:
    """Polls the save list until `ok(ui)` holds or the time is up; returns the last read."""
    deadline = time.monotonic() + timeout
    while True:
        ui = query(laptop, "saveui").get("saveui") or {}
        if ok(ui) or time.monotonic() > deadline:
            return ui
        time.sleep(0.15)


def save_game(laptop: lp.Laptop, slot: int = 3, say=print) -> tuple[bool, str]:
    """Save to `slot` from the main menu, checking every step through the bridge: the Save
    command and whether it is enabled (0.4.1+), the highlighted slot id before confirming
    (0.3.0+), and the save counter afterwards. Waits for each screen to open: on the LAN link
    the readings come faster than the menus open (10-20: a world-map save read as greyed)."""
    before = send(laptop, "pos")["pos"]
    if before.get("state") != "Player":
        return False, f"现在不能打开菜单(状态 {before.get('state')})"
    try:
        return _save(laptop, slot, before.get("saves") or 0)
    finally:
        leave_menu(laptop)


def _save(laptop: lp.Laptop, slot: int, saves: int) -> tuple[bool, str]:
    send(laptop, "keys", keys=["Tab"], gap=100)
    menu = wait_menu(laptop, lambda m: m.get("open") and m.get("commands"))
    commands = menu.get("commands") or []
    ids = [c.get("id") for c in commands]
    if "Save" not in ids:
        return False, f"菜单没有打开:{menu}"
    if commands[ids.index("Save")].get("enabled") is False:
        return False, "这里不能存档(「保存」是灰的),要到世界地图或存档点"

    def cursor():
        return menu_state(laptop).get("cursor")

    if not steer(cursor, lambda key: send(laptop, "keys", keys=[key], gap=110), ids.index("Save")):
        return False, "光标没能移到「保存」"
    send(laptop, "keys", keys=["Enter"], gap=100)
    ui = save_ui(laptop, lambda u: u.get("open") and u.get("slots"))
    if not ui.get("open"):
        return False, "存档列表没有打开"
    if move_to_slot(laptop, ui, slot) is None:
        return False, f"光标没能移到存档位 {slot}"
    send(laptop, "keys", keys=["Enter"], gap=100)
    # An occupied slot asks "overwrite?" with the cursor on No; an empty one saves at once.
    for confirm in ([], ["Left", "Enter"]):
        if confirm:
            send(laptop, "keys", keys=confirm, gap=300)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            after = send(laptop, "pos")["pos"]
            if (after.get("saves") or 0) > saves:
                send(laptop, "keys", keys=["Enter"], gap=300)  # the "saved" message
                return True, f"已存到 {slot} 号位(第 {after.get('saves')} 次存档)"
            time.sleep(0.2)
    return False, "存档计数没有增加,可能没存上"


def load_game(laptop: lp.Laptop, slot: int = 3, timeout: float = 150) -> tuple[bool, str]:
    """From the title screen: press Enter until the load list opens (the title menu starts on
    Load Game when saves exist), highlight `slot`, confirm, and wait until the player moves."""
    deadline = time.monotonic() + timeout
    while True:
        ui = query(laptop, "saveui").get("saveui") or {}
        if ui.get("open"):
            break
        if time.monotonic() > deadline:
            return False, "等不到读档列表"
        pos = send(laptop, "pos")["pos"]
        if pos.get("state") == "Player":
            return False, "已经在游戏里了,不在标题画面"
        send(laptop, "keys", keys=["Enter"], gap=100)
        time.sleep(2)
    if move_to_slot(laptop, ui, slot) is None:
        return False, f"光标没能移到存档位 {slot}"
    # "Load this data?" starts on No.
    send(laptop, "keys", keys=["Enter", "Left", "Enter"], gap=600)
    result = send(laptop, "wait", _wait=80, timeout=60000)
    if not result.get("ok"):
        return False, f"读档后没有进入可操作状态:{result.get('pos')}"
    return (
        True,
        f"已读取 {slot} 号位,现在在地图 {result['pos'].get('map')} {result['pos'].get('cell')}",
    )

"""Buying in an open shop, checked against the shop the bridge reads (0.4.0+)."""

import re
import time

from ffpr_agent import laptop as lp
from ffpr_agent.pilot import query, send
from ffpr_agent.skills.cursor import move_cursor, pick

ICON = re.compile(r"^<[^>]+>")


def shop_state(laptop: lp.Laptop) -> dict:
    return query(laptop, "shop").get("shop") or {}


GEAR = {"Weapon", "Armor"}  # product types worn by someone


def wait_party(laptop: lp.Laptop, seconds: float = 1.0) -> list[dict] | None:
    """The members' marks for the highlighted product, once the shop has drawn them; None
    when the bridge does not read them (before 0.7.0)."""
    deadline = time.monotonic() + seconds
    rows = None
    while time.monotonic() < deadline:
        rows = shop_state(laptop).get("party")
        if rows:
            return rows
        time.sleep(0.15)
    return rows


def who_can(rows: list[dict]) -> str:
    """「巴兹 更强、加拉夫 已装备、蕾娜 不能装备」 from the shop's marks."""

    def mark(r: dict) -> str:
        if not r.get("canEquip"):
            return "不能装备"
        if r.get("equipped"):
            return "已经装着"
        if r.get("up"):
            return "更强"
        return "更弱" if r.get("down") else "差不多"

    return "、".join(f"{r.get('name')} {mark(r)}" for r in rows)


def gear_report(laptop: lp.Laptop) -> tuple[bool, str]:
    """Every weapon and piece of armour in the open shop, with who can wear it and who would
    be stronger, read off the shop as each one is highlighted."""
    shop = shop_state(laptop)
    if not shop.get("open"):
        return False, "商店没有打开:先和店员说话"
    shop = open_products(laptop, shop)
    if shop is None:
        return False, "没能打开购买列表"
    lines, at = [], shop.get("listCursor") or 0
    for i, product in enumerate(shop.get("products") or []):
        if product.get("type") not in GEAR:
            continue
        move_cursor(laptop, at, i)
        at = i
        rows = wait_party(laptop)
        if rows is None:
            return False, "桥插件早于 0.7.0,读不到谁能装备"
        name = ICON.sub("", product.get("name") or "")
        lines.append(f"{name} {product.get('buy')} 金币:{who_can(rows)}")
    return True, "\n".join(lines) or "这家店没有武器和防具"


def gil(laptop: lp.Laptop) -> int | None:
    return ((query(laptop, "sample").get("sample") or {}).get("user") or {}).get("gil")


def buy(laptop: lp.Laptop, product: str, count: int = 1) -> tuple[bool, str]:
    """In an open shop: Buy → the product (by name) → quantity → confirm. Every step is checked
    against the shop state the bridge (0.4.0+) reads, and the result against the gil."""
    shop = shop_state(laptop)
    if not shop.get("open"):
        return False, "商店没有打开:先和店员说话"
    names = [p.get("name") for p in shop.get("products") or []]
    index = pick(names, product)
    if index is None:
        return False, f"这家店没有「{product}」,有:{'、'.join(n for n in names if n)}"
    gear = shop["products"][index].get("type") in GEAR
    shop = open_products(laptop, shop)
    if shop is None:
        return False, "没能打开购买列表"
    move_cursor(laptop, shop["listCursor"], index)
    note = ""
    if gear:
        # Weapons and armour: as many as members who can wear it and would be stronger
        # (bridge 0.7.0 reads the shop's own marks; 10-21: four of each bought, some for
        # nobody).
        rows = wait_party(laptop)
        if rows is not None:
            useful = [r["name"] for r in rows if r.get("canEquip") and r.get("up")]
            if not useful:
                return False, f"不买「{names[index]}」:{who_can(rows)},没有人用得上"
            if count > len(useful):
                note = f"(只买 {len(useful)} 件:用得上的只有 {'、'.join(useful)})"
                count = len(useful)
    price = (shop["products"][index].get("buy") or 0) * count
    before = gil(laptop)
    if before is not None and price > before:
        return False, f"钱不够:{product}×{count} 要 {price},只有 {before}"
    send(laptop, "keys", keys=["Enter"], gap=300)
    after_enter = shop_state(laptop)
    trade = after_enter.get("trade") or {}
    if not trade and after_enter.get("state") == "SelectProduct":
        # Nothing opened: a spell the party has already learned (or one it cannot afford)
        # takes no quantity (10-20: three spells bought again and again, reported as maybe
        # not bought).
        return False, f"买不了「{names[index]}」:魔法已经学会了(魔法只能买一次),或者钱不够"
    for _ in range(20):
        now = trade.get("count")
        if now is None or now == count:
            break
        send(laptop, "keys", keys=["Right" if now < count else "Left"], gap=120)
        trade = shop_state(laptop).get("trade") or {}
    send(laptop, "keys", keys=["Enter"], gap=500)
    # A confirmation or "thank you" line may follow; one more Enter clears it.
    after = gil(laptop)
    if after is not None and before is not None and after == before:
        send(laptop, "keys", keys=["Enter"], gap=500)
        after = gil(laptop)
    # The shop goes back to its list by itself: stay there, ready for the next purchase.
    if after is not None and before is not None and after < before:
        return True, f"买了「{names[index]}」×{count},花了 {before - after},剩 {after}{note}"
    return False, f"金钱没有变化({before}),可能没买成"


def open_products(laptop: lp.Laptop, shop: dict) -> dict | None:
    """Get the keys onto the product list; returns the shop then, None if that fails.

    The list is on screen (with a cursor) while the command menu has the keys too, so the
    shop's state (bridge 0.5.2+) decides. Older bridges have only the list cursor to go by."""
    if shop.get("state") is None:
        if shop.get("listCursor") is None:
            enter_buy(laptop, shop)
            shop = shop_state(laptop)
        return shop if shop.get("listCursor") is not None else None
    for _ in range(4):
        state = shop.get("state")
        if state == "SelectProduct" and shop.get("listCursor") is not None:
            return shop
        if state == "SelectCommand":
            enter_buy(laptop, shop)
        else:  # a quantity window or a confirmation left open: back out of it
            send(laptop, "keys", keys=["Backspace"], gap=300)
        shop = shop_state(laptop)
    return None


def enter_buy(laptop: lp.Laptop, shop: dict) -> None:
    commands = shop.get("commands") or []
    if "Buy" in commands:
        move_cursor(laptop, shop.get("commandCursor") or 0, commands.index("Buy"))
        send(laptop, "keys", keys=["Enter"], gap=300)


def to_command_menu(laptop: lp.Laptop, shop: dict) -> dict | None:
    """Back out of a list, quantity window or confirmation until the command menu has the
    keys (bridge 0.5.2+ reads the shop's state)."""
    for _ in range(4):
        if shop.get("state") == "SelectCommand":
            return shop
        send(laptop, "keys", keys=["Backspace"], gap=300)
        shop = shop_state(laptop)
    return None


def sell(laptop: lp.Laptop, item: str, count: int = 1) -> tuple[bool, str]:
    """In an open shop with a Sell command: Sell → the bag's item (by name, scrolling the list
    as drawn, bridge 0.7.3+) → quantity → confirm; checked against the gil. For gear nobody
    wears any more (10-21: surplus helmets and armour bought four at a time)."""
    shop = shop_state(laptop)
    if not shop.get("open"):
        return False, "商店没有打开:先和店员说话"
    shop = to_command_menu(laptop, shop)
    commands = (shop or {}).get("commands") or []
    if "Sell" not in commands:
        return False, "这家店不收东西(没有「卖出」;魔法店只卖不收)"
    move_cursor(laptop, shop.get("commandCursor") or 0, commands.index("Sell"))
    send(laptop, "keys", keys=["Enter"], gap=300)
    shop = shop_state(laptop)
    if shop.get("state") != "SelectSellItem" or shop.get("rows") is None:
        return False, "没能打开卖出列表(或桥插件早于 0.7.3)"
    row = find_row(laptop, item)
    if row is None:
        held = "、".join(ICON.sub("", r["name"]) for r in shop_state(laptop).get("rows") or [])
        to_command_menu(laptop, shop_state(laptop))
        return False, f"背包里没有「{item}」可卖;卖出列表开头是:{held}"
    if not row.get("canSelect", True):
        to_command_menu(laptop, shop_state(laptop))
        return False, f"「{ICON.sub('', row['name'])}」不能卖"
    before = gil(laptop)
    send(laptop, "keys", keys=["Enter"], gap=300)
    trade = shop_state(laptop).get("trade") or {}
    count = min(count, trade.get("max") or count)
    for _ in range(60):
        now = trade.get("count")
        if now is None or now == count:
            break
        send(laptop, "keys", keys=["Right" if now < count else "Left"], gap=110)
        trade = shop_state(laptop).get("trade") or {}
    send(laptop, "keys", keys=["Enter"], gap=500)
    after = gil(laptop)
    if after is not None and before is not None and after == before:
        send(laptop, "keys", keys=["Enter"], gap=500)  # a "sell this?" confirmation
        after = gil(laptop)
    to_command_menu(laptop, shop_state(laptop))
    name = ICON.sub("", row["name"])
    if after is not None and before is not None and after > before:
        return True, f"卖了「{name}」×{count},得到 {after - before},现在 {after}"
    return False, f"金钱没有变化({before}),可能没卖成"


def find_row(laptop: lp.Laptop, item: str, tries: int = 120) -> dict | None:
    """Move the sell list's cursor onto `item`, scrolling down then up through the list as
    drawn; the row, or None when the list does not have it."""
    seen_bottom = False
    for _ in range(tries):
        rows = shop_state(laptop).get("rows") or []
        names = [ICON.sub("", r.get("name") or "") for r in rows]
        focus = next((i for i, r in enumerate(rows) if r.get("focus")), None)
        target = pick(names, item)
        if target is not None and focus is not None and target == focus:
            return rows[target]
        if target is not None and focus is not None:
            key = "Down" if target > focus else "Up"
        else:
            key = "Up" if seen_bottom else "Down"
        before = (names, focus)
        send(laptop, "keys", keys=[key], gap=110)
        after_rows = shop_state(laptop).get("rows") or []
        after = (
            [ICON.sub("", r.get("name") or "") for r in after_rows],
            next((i for i, r in enumerate(after_rows) if r.get("focus")), None),
        )
        if after == before:  # the cursor did not move: the end of the list
            if seen_bottom or key == "Up":
                return None
            seen_bottom = True
    return None

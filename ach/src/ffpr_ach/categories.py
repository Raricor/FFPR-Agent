"""Achievement category, inferred from the Steam API name (e.g. "treasure_box_21" -> 宝箱).

The six games share one naming scheme; anything game-specific falls into 专项.
"""

import re

_TRAILING_NUMBER = re.compile(r"_?\d+$")

CATEGORIES = {
    "scenario": "剧情",
    "monster_hunt": "击杀",
    "total_gil": "金钱",
    "picture_book": "图鉴",
    "treasure_box": "宝箱",
    "area_visit": "地点",
    "get_hidden_item": "隐藏道具",
    "level_all": "全员等级",
    "job_master": "职业",
    "all_achievement": "全成就",
}
OTHER = "专项"


def classify(api_name: str) -> str:
    return CATEGORIES.get(_TRAILING_NUMBER.sub("", api_name), OTHER)

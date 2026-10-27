"""ffpr-guide: the walkthrough knowledge base (control plan §4.11).

uv run ffpr-guide fetch            # download the guides into .deps/knowledge (once)
uv run ffpr-guide show 沃尔斯城     # what the guides say about an area, monster or boss
uv run ffpr-guide show 30          # a monster by bestiary number
uv run ffpr-guide show 沃尔斯 --kind shop        # what the town's shops sell
uv run ffpr-guide show 沃尔斯塔 --kind treasure   # the area's chests and hidden items
"""

import argparse
import sys

from ffpr_agent.guide.kb import HOME, Guide, fetch


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="攻略知识库")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("fetch", help="下载并解析攻略(已下载的页面不重复下载)")
    p.add_argument("--refresh", action="store_true", help="重新下载全部页面")
    p = sub.add_parser("show", help="查地区、怪物、首领(中文、日文、英文名或图鉴编号)")
    p.add_argument("query")
    p.add_argument(
        "--kind", choices=["area", "shop", "treasure"], default="area", help="全部、商店或宝箱"
    )
    args = parser.parse_args(argv)
    if args.cmd == "fetch":
        out = fetch(HOME, refresh=args.refresh)
        print(f"已写入 {out}")
        return 0
    guide = Guide.load()
    if guide is None:
        print("还没有知识库:先运行 uv run ffpr-guide fetch")
        return 1
    print(guide.lookup(args.query, kind=args.kind) or f"攻略里没有找到「{args.query}」")
    return 0


if __name__ == "__main__":
    sys.exit(main())

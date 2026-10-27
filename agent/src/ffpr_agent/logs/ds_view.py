"""Read what DeepSeek decided: a run log (.deps/ds/run-*.jsonl) as one block per step, with
its thinking, what it said, the tool it called and what came back.

    uv run ffpr-ds-log                    # the newest run
    uv run ffpr-ds-log -f                 # follow it live (and the runs after it)
    uv run ffpr-ds-log --think 0          # the whole of each thought, not the first 300 chars
    uv run ffpr-ds-log .deps/ds/run-20261020-213522.jsonl
"""

import argparse
import json
import sys
import time
from pathlib import Path

from ffpr_agent.repo import DEPS

RUNS = DEPS / "ds"


def newest(after: Path | None = None) -> Path | None:
    runs = sorted(RUNS.glob("run-*.jsonl"))
    if after is not None:
        runs = [r for r in runs if r.name > after.name]
    return runs[-1] if runs else None


def clip(text: str, chars: int) -> str:
    text = " ".join(text.split())
    return text if chars <= 0 or len(text) <= chars else text[:chars] + "……"


def render(record: dict, think: int = 300, result_lines: int = 6) -> str:
    if "goal" in record:
        hint = f"\n已知:{record['hint']}" if record.get("hint") else ""
        effort = record.get("effort")
        return f"\n==== 目标:{record['goal']}{hint}\n     ({record.get('model')},思考强度 {effort})"
    step = record.get("step")
    if "message" in record:
        message = record["message"]
        usage = record.get("usage") or {}
        seconds = record.get("model_ms", 0) / 1000
        out = [f"\n[{step}] 模型 {seconds:.1f} 秒,输入 {usage.get('prompt_tokens')} tokens"]
        if message.get("reasoning_content"):
            out.append(f"  思考:{clip(message['reasoning_content'], think)}")
        if message.get("content"):
            out.append(f"  说:{message['content'].strip()}")
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            out.append(f"  → {fn.get('name')} {fn.get('arguments')}")
        return "\n".join(out)
    if "tool" in record:
        lines = str(record.get("result") or "").splitlines()
        shown = lines[:result_lines] + (["  ……"] if len(lines) > result_lines else [])
        body = "\n".join("    " + x for x in shown)
        return f"  结果({record.get('tool_ms', 0) / 1000:.1f} 秒):\n{body}"
    return ""


def show(path: Path, start: int, think: int) -> int:
    """Print the records from line `start`; returns how many lines the file has now."""
    lines = path.read_text(encoding="utf-8").splitlines()
    for line in lines[start:]:
        try:
            text = render(json.loads(line), think)
        except json.JSONDecodeError:
            return start  # mid-write: read this line again next time
        if text:
            print(text, flush=True)
        start += 1
    return start


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="查看 DeepSeek 每一步的思考和决定")
    parser.add_argument("file", nargs="?", type=Path, help="运行记录,默认最新的一个")
    parser.add_argument("-f", "--follow", action="store_true", help="一直跟着看,新的一轮也接着看")
    parser.add_argument("--think", type=int, default=300, help="思考内容显示多少字,0 为全部")
    args = parser.parse_args(argv)
    path = args.file or newest()
    if path is None:
        print(f"{RUNS} 里还没有运行记录")
        return 1
    print(f"运行记录:{path}")
    seen = show(path, 0, args.think)
    while args.follow:
        time.sleep(1)
        seen = show(path, seen, args.think)
        later = newest(after=path)
        if later is not None:
            path, seen = later, 0
            print(f"\n运行记录:{path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

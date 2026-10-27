"""DeepSeek's decisions as a web page: the newest runs (.deps/ds/run-*.jsonl), each step with
what it thought, said and did, and what came back. Republished as an artifact after each run.

    uv run ffpr-ds-report --out /path/report.html          # the last 6 runs
    uv run ffpr-ds-report --runs 3 --out report.html
"""

import argparse
import html
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ffpr_agent.repo import DEPS

RUNS = DEPS / "ds"
SHANGHAI = ZoneInfo("Asia/Shanghai")

STYLE = """
<title>FF5 试玩决策记录</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
/* Layout: one reading column; each run a section, each step a row; the FF menu-window blue
   marks what the AI did (the tool call), quiet greys for what came back. */
:root {
  --bg: #f6f7fb; --panel: #ffffff; --fg: #1d2233; --muted: #5d6478; --line: #dde1ec;
  --window: #23308f; --window-fg: #ffffff; --window-edge: #c9d0ff;
  --ok: #1f7a4d; --warn: #9a5b00; --bad: #b3261e;
  --sans: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12141c; --panel: #1a1d28; --fg: #e6e8f0; --muted: #9aa1b5; --line: #2c3142;
  --window: #2c3aa8; --window-fg: #ffffff; --window-edge: #6f7cf0;
  --ok: #5fcf97; --warn: #f0b25a; --bad: #ff8a80; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #12141c; --panel: #1a1d28; --fg: #e6e8f0; --muted: #9aa1b5; --line: #2c3142;
  --window: #2c3aa8; --window-fg: #ffffff; --window-edge: #6f7cf0;
  --ok: #5fcf97; --warn: #f0b25a; --bad: #ff8a80; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font-family: var(--sans); font-size: 15px;
  line-height: 1.6; padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 48px; }
main { max-width: 860px; margin: 0 auto; display: grid; gap: 28px; }
h1 { font-size: 1.6rem; margin: 0; text-wrap: balance; }
h2 { font-size: 1.15rem; margin: 0; text-wrap: balance; }
.sub { color: var(--muted); font-size: 0.9rem; }
.run { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 18px; display: grid; gap: 14px; min-width: 0; }
.goal { margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { font-size: 0.8rem; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted); font-variant-numeric: tabular-nums; }
.chip.ok { color: var(--ok); border-color: var(--ok); }
.chip.warn { color: var(--warn); border-color: var(--warn); }
.steps { display: grid; gap: 10px; }
.step { display: grid; grid-template-columns: 2.6em 1fr; gap: 10px; min-width: 0; }
.no { color: var(--muted); font-family: var(--mono); font-size: 0.8rem; padding-top: 3px;
  font-variant-numeric: tabular-nums; }
.body { display: grid; gap: 6px; min-width: 0; }
.say { margin: 0; }
.call { font-family: var(--mono); font-size: 0.82rem; background: var(--window);
  color: var(--window-fg); border: 2px solid var(--window-edge); border-radius: 6px;
  padding: 4px 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.events { border-left: 3px solid var(--warn); padding-left: 10px; font-size: 0.86rem;
  white-space: pre-wrap; }
details { font-size: 0.85rem; color: var(--muted); min-width: 0; }
details summary { cursor: pointer; }
details summary:focus-visible { outline: 2px solid var(--window-edge); outline-offset: 2px; }
details pre { font-family: var(--mono); font-size: 0.78rem; white-space: pre-wrap;
  word-break: break-word; margin: 6px 0 0; overflow-x: auto; }
.time { font-family: var(--mono); font-size: 0.75rem; color: var(--muted); }
</style>
"""


def load(path: Path) -> list[dict]:
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def esc(text) -> str:
    return html.escape(str(text or ""))


def news_of(result: str) -> str:
    """The key events a tool result carried, if any."""
    if "新的重要事件:" not in result:
        return ""
    tail = result.split("新的重要事件:", 1)[1]
    return tail.split("当前状态:", 1)[0].strip()


def run_html(path: Path) -> str:
    records = load(path)
    head = next((r for r in records if "goal" in r), {})
    models = [r for r in records if "message" in r]
    tools = {(r["step"], r.get("tool")): r for r in records if "tool" in r}
    model_s = sum(r.get("model_ms", 0) for r in models) / 1000
    tool_s = sum(r.get("tool_ms", 0) for r in tools.values()) / 1000
    done = next(
        (
            json.loads(c["function"].get("arguments") or "{}").get("summary")
            for r in models
            for c in r["message"].get("tool_calls") or []
            if c["function"]["name"] == "done"
        ),
        None,
    )
    started = datetime.strptime(path.stem.removeprefix("run-"), "%Y%m%d-%H%M%S")
    outcome = (
        f'<span class="chip ok">完成:{esc(done)}</span>'
        if done
        else '<span class="chip warn">没有调用 done(步数用完或被中断)</span>'
    )
    out = [
        '<section class="run">',
        f"<h2>{started:%m-%d %H:%M} 开始的一轮</h2>",
        f'<p class="goal"><b>目标</b> {esc(head.get("goal"))}</p>',
        '<div class="chips">',
        outcome,
        f'<span class="chip">{len(models)} 步</span>',
        f'<span class="chip">模型 {model_s:.0f} 秒</span>',
        f'<span class="chip">工具 {tool_s:.0f} 秒</span>',
        f'<span class="chip">思考强度 {esc(head.get("effort"))}</span>',
        "</div>",
        '<div class="steps">',
    ]
    for r in models:
        step, message = r["step"], r["message"]
        body = []
        if message.get("content"):
            body.append(f'<p class="say">{esc(message["content"].strip())}</p>')
        for call in message.get("tool_calls") or []:
            fn = call["function"]
            body.append(f'<div class="call">{esc(fn["name"])} {esc(fn.get("arguments"))}</div>')
            tool = tools.get((step, fn["name"]))
            if tool is not None:
                result = str(tool.get("result") or "")
                news = news_of(result)
                if news:
                    body.append(f'<div class="events">{esc(news)}</div>')
                body.append(
                    f"<details><summary>结果({tool.get('tool_ms', 0) / 1000:.1f} 秒)</summary>"
                    f"<pre>{esc(result)}</pre></details>"
                )
        if message.get("reasoning_content"):
            body.append(
                f"<details><summary>思考({r.get('model_ms', 0) / 1000:.1f} 秒)</summary>"
                f"<pre>{esc(message['reasoning_content'])}</pre></details>"
            )
        inner = "".join(body)
        out.append(
            f'<div class="step"><div class="no">{step}</div><div class="body">{inner}</div></div>'
        )
    out += ["</div>", "</section>"]
    return "\n".join(out)


def report(runs: int = 6) -> str:
    paths = sorted(RUNS.glob("run-*.jsonl"))[-runs:][::-1]
    now = datetime.now(SHANGHAI)
    parts = [
        STYLE,
        "<main>",
        "<header>",
        "<h1>FF5 试玩决策记录</h1>",
        f'<p class="sub">DeepSeek(deepseek-flash)每一步说了什么、做了什么、结果如何。'
        f"最新的一轮在最前;点开「思考」「结果」看详情。更新于 {now:%m-%d %H:%M}。</p>",
        "</header>",
        *(run_html(p) for p in paths),
        "</main>",
    ]
    return "\n".join(parts)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="把 DeepSeek 的运行记录做成网页")
    parser.add_argument("--runs", type=int, default=6, help="最近几轮")
    parser.add_argument("--out", type=Path, default=RUNS / "report.html")
    args = parser.parse_args(argv)
    args.out.write_text(report(args.runs), encoding="utf-8")
    print(f"已写入 {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

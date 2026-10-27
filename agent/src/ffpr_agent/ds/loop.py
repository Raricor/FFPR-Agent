"""The agent loop: model call, tool calls, results back; stops at a deadline and makes
no model call while keys cannot reach the game."""

import json
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from datetime import time as clock_time
from zoneinfo import ZoneInfo

from ffpr_agent.ds.prompt import SYSTEM_PROMPT

SHANGHAI = ZoneInfo("Asia/Shanghai")


def wait_until_ready(
    game,
    say: Callable[[str], None],
    deadline: datetime | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(SHANGHAI),
    wait: Callable[[float], None] = time.sleep,
    label: str = "",
) -> str | None:
    """Wait while keys cannot reach the game (the laptop is locked, another window is in
    front), checking once a minute and calling no model. Returns None once the game is ready,
    or why it still is not when the deadline passes."""
    blocked = getattr(game, "ready", lambda: None)()
    if not blocked:
        return None
    say(f"{label}游戏收不到按键({blocked}),暂停调用模型,等待恢复")
    while blocked and (deadline is None or now() < deadline):
        wait(60)
        blocked = game.ready()
    if not blocked:
        say(f"{label}已恢复,继续")
    return blocked


def play(
    goal: str,
    hint: str,
    chat: Callable[[list[dict]], dict],
    game,
    max_steps: int,
    log: Callable[[dict], None],
    say: Callable[[str], None] = print,
    keep: int = 16,
    deadline: datetime | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(SHANGHAI),
    wait: Callable[[float], None] = time.sleep,
) -> str:
    """The agent loop. Keeps the system prompt, the goal and the last `keep` messages.
    No model call is made once `deadline` has passed."""
    system = SYSTEM_PROMPT.format(goal=goal, hint=f"\n已知信息:{hint}" if hint else "")
    # Strategy's window (control plan §4.8): what happened in the last hours, story included.
    window = getattr(game, "window", lambda layer: "")(1)
    opening = {
        "role": "user",
        "content": "开始。当前状态:\n"
        + game.observe()
        + (f"\n\n最近几小时的重要事件:\n{window}" if window else ""),
    }
    history: list[dict] = []
    for step in range(1, max_steps + 1):
        if deadline is not None and now() >= deadline:
            say(f"[{step}] 已到截止时间 {deadline:%H:%M},不再调用模型")
            return "到达截止时间"
        blocked = wait_until_ready(game, say, deadline, now, wait, f"[{step}] ")
        if blocked:
            return f"等到截止时间也没恢复({blocked})"
        notes = "\n".join(f"{i}. {n}" for i, n in enumerate(game.notes, start=1))
        context = [
            {"role": "system", "content": system + (f"\n\n你记下的:\n{notes}" if notes else "")}
        ]
        context += [opening, *trim(history, keep)]
        started = time.perf_counter()
        reply = chat(context)
        model_ms = round((time.perf_counter() - started) * 1000)
        message = reply["choices"][0]["message"]
        log({"step": step, "message": message, "usage": reply.get("usage"), "model_ms": model_ms})
        if message.get("content"):
            say(f"[{step}] DeepSeek:{message['content'].strip()}")
        calls = message.get("tool_calls") or []
        # With tools, the API wants each earlier turn's reasoning back (thinking mode docs).
        kept = ("role", "content", "reasoning_content", "tool_calls")
        history.append({k: message[k] for k in kept if k in message})
        if not calls:
            history.append({"role": "user", "content": "请调用一个工具继续。"})
            continue
        for call in calls:
            name = call["function"]["name"]
            try:
                args = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            if name == "done":
                say(f"[{step}] 结束:{args.get('summary')}")
                return args.get("summary", "")
            say(f"[{step}] → {name} {json.dumps(args, ensure_ascii=False)}")
            started = time.perf_counter()
            try:
                result = game.run(name, args)
            except Exception as e:  # report to the model instead of dying mid-run
                result = f"工具出错:{e}"
            tool_ms = round((time.perf_counter() - started) * 1000)
            log({"step": step, "tool": name, "args": args, "result": result, "tool_ms": tool_ms})
            say("    " + result.replace("\n", "\n    "))
            history.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    return OUT_OF_STEPS


NEXT_HINT = (
    "接着上一轮的进度继续。先用 look_around 和 terrain 看清自己在哪。你记下的笔记里有之前的发现。"
)


def play_rounds(
    goals: list[str],
    hint: str,
    chat: Callable[[list[dict]], dict],
    game,
    max_steps: int,
    open_log: Callable[[str, str], Callable[[dict], None]],
    say: Callable[[str], None] = print,
    deadline: datetime | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(SHANGHAI),
    next_hint: str = NEXT_HINT,
) -> list[str]:
    """Play the goals one after another, each with a fresh conversation (the notes carry
    over), `hint` for the first and `next_hint` after. A goal whose round ran out of steps is
    played once more before the next: the next goal assumes it done, and a player put on it
    early spent its steps working out where the story stood (10-21). Stops at the deadline.
    `open_log(goal, hint)` returns the log function for one round. Returns each round's
    summary."""
    summaries = []
    queue = [(goal, 0) for goal in goals]
    while queue:
        if deadline is not None and now() >= deadline:
            break
        goal, tries = queue.pop(0)
        say(f"== 第 {len(summaries) + 1} 轮:{goal}")
        round_hint = hint if not summaries else next_hint
        if tries:
            round_hint = UNFINISHED + round_hint
        log = open_log(goal, round_hint)
        summary = play(
            goal, round_hint, chat, game, max_steps, log, say, deadline=deadline, now=now
        )
        summaries.append(summary)
        if summary == OUT_OF_STEPS and tries < RETRIES:
            queue.insert(0, (goal, tries + 1))
    return summaries


OUT_OF_STEPS = "步数用完"
RETRIES = 1
UNFINISHED = "上一轮这个目标没做完(步数用完),接着做;先用 look_around、atlas 看清现在在哪。"


def trim(history: list[dict], keep: int) -> list[dict]:
    """The last `keep` messages, never starting on a tool result cut off from its call."""
    cut = history[-keep:]
    while cut and cut[0]["role"] == "tool":
        cut = cut[1:]
    return cut


def next_deadline(hhmm: str, now: datetime) -> datetime:
    """The next occurrence of HH:MM in Shanghai time (today, or tomorrow if already past)."""
    hour, minute = (int(x) for x in hhmm.split(":"))
    at = datetime.combine(now.date(), clock_time(hour, minute), tzinfo=SHANGHAI)
    return at if at > now else at + timedelta(days=1)

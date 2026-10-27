# 任务 04:关键事件、地图记录、战术、攻略库

先读 `CLAUDE.md` 和 `tasks/port-rules.md`。和任务 02、03 同时进行。

## 你负责(只写这些文件和它们的测试)

| TS 文件 | 从 Python 移植(`agent/src/ffpr_agent/` 下) |
| --- | --- |
| `src/engine/keylog.ts` | `logs/key_log.py`:`Builder`、`LABEL`、`load`、`local_time`、`counters`、`scene_of`、`party_levels` 和 Builder 用到的一切。命令行部分(`render`、`main`、`build`)不移 |
| `src/engine/events.ts` | `events.py`:`KeyEvents`(`seed`、`feed`、`window`、`news`、`note`、`live_sample`、`take_recent`、`last_save_minutes`、`enemies`、`books`)、`WINDOWS`、`describe`、`shorten`、`version`、`Watcher` |
| `src/engine/atlas.ts` | `ds/atlas.py` |
| `src/engine/tactics.ts` | `ds/tactics.py` |
| `src/engine/guide/ludo.ts`、`steam.ts`、`kb.ts` | `guide/` 下三个文件 |

## 要点

- **时间**:
  - 上海时间固定 +08:00;
  - `KeyEvents` 的 `now` 照 Python 作为参数注入;
  - `live_sample` 的「新鲜」用注入的单调时钟。
- **`Watcher` 不依赖 `bridge.ts`**:构造时接收 `stream: (signal) => AsyncIterable<Json>`,断了等 `retry` 再连，直到传入的 signal 中断。线程改成一个异步循环。
- **`threading.Lock`**:JS 单线程，`KeyEvents` 不需要锁(注释说明)。
- **文件读写一律异步。** 地图记录、战术、攻略缓存都是。
  - 构造函数里不能 await:改成 `static async load(path)`,或者构造后调 `load()`,二选一，在回报里说明。
  - 写文件的格式照 Python 的 `json.dumps(..., ensure_ascii=False, indent=1)` 输出，Python 和 TS 写出的文件要能互读。
- **攻略库的抓取**(`kb.fetch`)用全局 `fetch`,带 signal。**测试不上网**,用缓存 `.deps/knowledge/ff5/` 里的页面。

## 对照测试

- **事件**:用 2–3 个真实探针文件(`.deps/ff5/probe/*.jsonl`,挑有剧情、战斗、存档、入队离队的),逐条喂给 Python 的 Builder 和 KeyEvents,导出 entries 和几个时刻的 `window(1)`、`window(2)`、`news()` 文字。
- **攻略**:对 `.deps/knowledge/ff5/` 的缓存，导出 ludo 和 steam 的解析结果(章节、宝箱、商店、图鉴)和一批 `lookup`(地区、商店、宝箱、图鉴编号、中文地名)的文字。
- **地图记录和战术**:用 `.deps/ds/` 里的真文件，导出 `describe` 的文字，以及 `visit`、`link`、`record` 序列之后的结果。
- **要移的 Python 测试**:
  - `test_events.py`:除了 `test_the_player_sees_the_window_first_and_news_after_each_tool`(用到 Game 和 loop,留到后面);
  - `test_logs.py`:key_log 的那几个(`probe_report` 不移);
  - `test_guide.py`:全部;
  - `test_ds.py` 的两个 atlas 测试;
  - `test_gambit.py` 的 `test_tactics_rotate_after_a_bad_battle`。

## 回报

照 `tasks/port-rules.md` 的格式。

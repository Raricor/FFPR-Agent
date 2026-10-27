# 移植规矩(任务 02 起每个移植任务都照这份)

先读 `CLAUDE.md`。下面是从 Python 移到 TS 时额外要守的。

## 原则

- **照搬行为，不改设计。** Python 版(`/root/data/mediaflow/FFPR-Agent/agent/src/ffpr_agent/`)是基准。看到 bug 或怪写法也先照搬，在回报里列出来，由 Claude 决定改不改。
- **给模型和给人看的中文一字不改**:提示词、工具说明、工具结果、报错。这些是产品的一部分。
- **注释的内容保留。** Python 的 docstring 和注释翻成 JSDoc 或行注释，意思不变;带日期的经过(「10-21: …」)原样保留。
- 文件名、函数名照搬，改成 TS 的命名风格(`find_path` → `findPath`,`DEFAULT_RULES` 不变)。

## 已经有的，直接用，不要重写

| 文件 | 内容 |
| --- | --- |
| `src/engine/pilot.ts` | `Pilot` 接口：引擎碰游戏的唯一通道(`send`、`query`、`runPs`、`sleep`、`now`)。Python 里 `send(laptop, …)` 的地方，TS 里是 `pilot.send(…)` |
| `src/engine/values.ts` | 读松散 JSON:`record`(`x or {}`)、`list`(`x or []`)、`records`、`text`、`num`、`truthy`(Python 真值)、`pyRound`(Python 的 round)、`floorDiv`、`floorMod` |
| `src/engine/paths.ts` | `REPO`、`DEPS`、`configDir`、`secretsPath` |
| `src/engine/env.ts`、`errors.ts`、`lock.ts`、`bridge.ts` | 小样里写好的 |

## Python 和 JS 不一样的地方(逐条核对)

- **真值**:`[]`、`{}` 在 Python 是假，在 JS 是真。`reply.get("x") or {}` 写成 `record(reply.x)`,`... or []` 写成 `list(...)`;拿列表或字典做条件时用 `truthy()`。字符串和数字上的 `a or b` 写成 `a || b`(lint 已允许)。
- **round**:用 `pyRound`,不要用 `Math.round`。
- **`//` 和 `%`**:负数时不一样，用 `floorDiv`、`floorMod`。
- **对象的键顺序**:JS 对象会把像整数的键(`"64"`、`"238"`)排到前面，Python 的 dict 按插入顺序。键是地图编号、格子这类时用 `Map`。
- **正则**:
  - `re.match` 只从开头匹配，要加 `^`;`re.fullmatch` 要加 `^…$`;
  - `(?P<name>…)` 改成 `(?<name>…)`;`re.S` 对应 `s` 标志，`re.M` 对应 `m` 标志;
  - 有中文或 `\u` 的加 `u` 标志;
  - `re.sub` 传函数时，参数顺序不同，要看清。
- **字符串**:
  - `str.strip()` 用 `trim()`(ASCII 场景够了);
  - `str.split()` 不带参数时按任意空白切、丢掉空串，JS 要写 `.trim().split(/\s+/)`,还要处理空串;
  - 切片 `s[:n]` 用 `slice(0, n)`。注意中文和 emoji:Python 按码点数，JS 按 UTF-16。遇到 emoji 用 `[...s]`。
- **`json.dumps`**:Python 默认分隔符是 `", "` 和 `": "`,JS 的 `JSON.stringify` 没有空格;`ensure_ascii=False` 时中文原样输出。只要输出会进工具结果或日志对比，就要照 Python 的格式写。
- **浮点格式**:`f"{x:.1f}"` 用 `x.toFixed(1)`;`f"{x}"` 打出的浮点数，Python 是 `1.0`,JS 是 `1`,要核对。
- **整数和浮点**:Python 的 `int(x)` 是向零截断，用 `Math.trunc`。
- **排序**:`sorted(key=…)` 用比较函数;元组作键时逐项比较;两边都是稳定排序。
- **dataclass**:用 `interface` 加工厂函数，或者普通 class。`frozen=True` 用 `readonly`。
- **线程和锁**:JS 是单线程。Python 里护线程的锁，除非是在护异步交错，否则去掉，并在注释里说一句为什么。
- **时间**:
  - 轮询里的 `time.sleep` / `time.monotonic` 用 `pilot.sleep` / `pilot.now`;
  - 不经过 pilot 的模块，时钟作为参数注入;
  - 上海时间固定 +08:00(没有夏令时)。

## 对照测试

- 每个移植的模块写一个导出脚本 `scripts/fixtures/<模块>.py`:
  - 导入 Python 模块，跑一批输入，把输入和输出写进 `test/fixtures/<模块>/*.json`;
  - 用这个命令运行:`PYTHONDONTWRITEBYTECODE=1 /root/data/mediaflow/FFPR-Agent/.venv/bin/python scripts/fixtures/<模块>.py`。
- 输入尽量用真实数据(下面这些只读):
  - `/root/data/mediaflow/FFPR-Agent/.deps/ff5/probe/*.jsonl`:探针记录，桥插件的真实回复;
  - `/root/data/mediaflow/FFPR-Agent/.deps/knowledge/ff5/`:攻略缓存;
  - `/root/data/mediaflow/FFPR-Agent/.deps/ds/`:地图记录、战术、笔记、试玩日志;
  - Python 测试 `/root/data/mediaflow/FFPR-Agent/agent/tests/` 里的例子。
- 对照数据**不要太大**:每个模块总共几百 KB 以内，挑有代表性的。
- TS 测试读这些 JSON,逐个比较，输出必须一模一样。
- **Python 测试也要移过来**:`agent/tests/` 里覆盖这些模块的测试，逐个改写成 TS(名字照搬意思)。

## 分工

几个任务同时在做，每个任务**只写自己名下的文件**(见各任务的「你负责」)。别的文件只读;觉得要改，写进回报。不改 `package.json`、`tsconfig*.json`、`eslint.config.js`、`cordis.patch.yml`、`src/index.ts`、`src/plugin/`。

## 回报

不超过 40 行:
- 写了哪些文件;
- `npm run check` 的结尾输出;
- 对照了多少个用例;
- 照搬下来的可疑之处(Python 的 bug 或怪写法);
- 拿不准的地方。

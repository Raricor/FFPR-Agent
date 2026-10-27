# 任务 06:`Game` 和 dsh 胶水：让 dsh 版能玩

先读 `CLAUDE.md` 和 `tasks/port-rules.md`。任务 02–05 已经合进来了。

做完以后,dsh 版要能和 Python 版 `ffpr-ds` 一样玩：同样的 24 个工具，同样的系统提示词，同样的工具结果。

## 你负责

| 文件 | 内容 |
| --- | --- |
| `src/engine/game.ts` | 移植 `agent/src/ffpr_agent/ds/game.py` 全部:`Game.run` 的每个工具、`settle`、`chart`、`keep_drake`、`check_gear`、各种提示、`observe`、`floor`、`note_jump`、笔记(`remember`、`forget`,写回同一个笔记文件，和 Python 版互读) |
| `src/plugin/player.ts` 等 | 新的胶水(下面几条) |
| `src/index.ts` | 改成接上 `player.ts`;去掉小样的 `where_am_i` 和 `deny: ["working_directory"]` |
| `src/plugin/where-am-i.ts`、`notes-prompt.ts`、`config.ts` | 按需要改或删 |
| `cordis.patch.yml` | 去掉 `dsh-persona` 那一行(人设改由插件自己注册，见第 3 条) |

## 05 留下的接口

- `Game` 持有一个 `MoveState`(`skills/move.ts`,飞龙位置和战斗钩子)。
- `Game` 持有一个 `BattleHooks`(`skills/battle.ts`):`tableFor`、`report` 接到 `Tactics` 的 `current`、`record`,对应 Python `Game.__init__` 里 `battle.table_for = self.tactics.current` 那两行。
- 测试用 `test/fake-pilot.ts`。

## 胶水要做的事(这些是定好的设计)

### 1. 引擎在插件启动时建好，整个插件共用一份

- `Laptop.load`、`BridgeLink.load`;
- `KeyEvents`:像 `cli/ds.py` 的 `follow_events` 那样，先取回最近 3 个探针文件作为种子，再用 `Watcher` 跟随 `link.stream()`。Watcher 随插件卸载而停;
- `Game` 的地图记录、战术、笔记文件路径和 Python 版相同(`DEPS/ds/` 下)。

### 2. 工具注册在每个智能体自己那一层

- 在 `agent/created` 里，用 `agent.ctx.tools.register` 注册工具，再 `agent.ctx.tools.restrict({ allow: [] })` 去掉所有全局工具。
- **原因**:restrict 只放过智能体自己那一层(`dsh-tools` 的 `view()` 注释)。小样把工具注册在预设那一层，`allow: []` 会把自己的工具也藏掉。
- 智能体销毁时清理;按 `references/practices.md` 的做法，用 `agent.ctx.effect`,再在插件自己的 effect 里留一份 disposer。
- **工具从 `prompt.ts` 的 `TOOLS` 数据转换**,去掉 `done`(dsh 里模型直接回答就是结束)。
  - OpenAI 的 JSON Schema 转成 `defineTool` 的参数写法;
  - 如果 `dsh-tools` 能直接接受原始 JSON Schema(MCP 工具就是这么进来的),优先用那条路，在回报里说明。
- **每个工具的 `execute`**:
  - 建一个绑定 `exec.signal` 的 `Pilot`(`createPilot`);
  - 调 `game.run(name, args, pilot)`,整个调用串行(游戏只有一个);
  - 异常转成文字结果「工具出错:…」,和 `loop.py` 一样，不让它变成 dsh 的错误。
- **时限**(`timeoutMs`):
  - `advance_story` 650 秒;
  - `fight` 900 秒;
  - `walk_to`、`go_to`、`interact`、`land`、`board` 600 秒;
  - 其余 120 秒。

### 3. 系统提示词只有一份：插件自己注册

- 不再用 `cordis.patch.yml` 里的 `dsh-persona` 那一行。插件照 `dsh-persona` 的 `lib/index.js`(只有 50 行)自己注册:
  - `section({ name, order: getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"), text, complete: true })`;
  - 加上 `suppressRuntimeContext()`;
  - 在预设(智能体)作用域里注册。
- 文字来自 `prompt.ts` 的 `SYSTEM_PROMPT`,两处占位符这样处理:
  - `目标:{goal}` 换成「目标:用户在对话里给你的目标;用户没说就接着之前的进度玩。」;
  - `{hint}` 换成空串。
- 这样 Python 版和 dsh 版的提示词出自同一份文字。

### 4. 每一轮的开局简报

- Python 版每轮的第一条消息是「开始。当前状态:… 最近几小时的重要事件:…」(`loop.py` 的 `opening`)。
- dsh 里：在 `agent/pre-step` 中，**每轮第 1 步**(`step === 1`)在 `next()` 返回的消息后面加一条用户消息，内容和 Python 的 opening 相同(`observe()` 和 `window(1)`);其他步不加。
- 消息的 source 照 `dsh-time-context` 的写法。

### 5. 步前

- 保留小样的「等桥插件」。
- 笔记改用内存里的 `game.notes`(remember、forget 会更新它),不用每步读文件;动态上下文照旧。

### 6. 本任务不做

截止时间(你在网页上停就行)、重启游戏的命令(继续用 Python 的 `ffpr-pilot restart`)、网页面板。

## 测试

- 用 `test/fake-pilot.ts` 测 `game.run` 的每个工具。
- 移植 Python 测试:
  - `test_ds.py`:`test_notes_persist_and_can_be_forgotten`、`test_every_tool_has_a_handler`、`test_new_gear_is_put_on_and_reported`;
  - `test_events.py`:`test_the_player_sees_the_window_first_and_news_after_each_tool`,改成测开局简报和工具结果里的新事件。
- 胶水的测试：工具清单和 `TOOLS` 对得上(少 `done`);时限;异常变成「工具出错」;开局简报只在第 1 步。

## 回报

照 `tasks/port-rules.md` 的格式，外加：工具是怎么转换和注册的、人设注册的出处。

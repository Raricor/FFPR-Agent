# 任务 03:寻路、规则表、画面描述、提示词

先读 `CLAUDE.md` 和 `tasks/port-rules.md`。和任务 02、04 同时进行。这些模块都是纯逻辑，不碰网络。

## 你负责(只写这些文件和它们的测试)

| TS 文件 | 从 Python 移植(`agent/src/ffpr_agent/` 下) |
| --- | --- |
| `src/engine/nav.ts` | `nav.py`(全部:世界地图寻路、室内格子、分层格子和楼梯规则、`layered_view`) |
| `src/engine/skills/gambit.ts` | `skills/gambit.py`(全部：词汇表、条件求值、目标、`check`、`normalize`、默认规则、`CURES`、`FAMILIES`、`ability_candidates`) |
| `src/engine/view.ts` | `view.py`,**除了** `state_script` 和 `parse_state`(归任务 02) |
| `src/engine/prompt.ts` | `ds/prompt.py`(全部:`SYSTEM_PROMPT` 原文、`TOOLS` 原样作为数据、`TERRAIN`、`render_terrain`、`render_floor`、`FLOOR_MARKS`、`describe_battle`) |

## 要点

- **`gambit.py` 的条件求值**:先看清 Python 怎么解析条件(是不是用了 `eval`)。TS 里**不许用 `eval` 或 `new Function`**,要写一个只认词汇表里的词、比较符和 and/or/not 的小解析器。所有对照用例的结果必须和 Python 一样，`check()` 给出的中文报错也要一样。
- **`TOOLS`**:保持 Python 里的 OpenAI 函数定义格式，原样作为数据导出(`as const`)。dsh 的工具注册由后面的任务从这份数据转换，你不用管。
- **`SYSTEM_PROMPT`**:原文照搬，里面的 `{goal}`、`{hint}` 占位符保留。
- **寻路结果要逐格一致**:同样的格子表、同样的起终点，路径必须一模一样(BFS 的邻居顺序照搬)。

## 对照测试

- **寻路**:
  - 用真实的格子和碰撞表(探针文件里的 `cells`、`collision` 回复;`.deps/ds/` 里有没有存下来的也看看);
  - 每张表挑几组起终点，导出路径、`corners`、`layered_view`;
  - 世界地图(坐船、步行、飞龙)和室内(分层、楼梯)都要有。
- **规则表**:
  - 用 `agent/tests/test_gambit.py` 的队伍和敌人，再造一批局面(各种 HP、状态、道具、倒下的人);
  - 导出 `choose` 的结果，以及 `check`、`normalize`、`ability_candidates`、`statuses` 的输出。
- **画面和提示词**:用探针文件里的真实 `sample`、`entities`、`items`、`battle`,导出 `summarize`、`describe_entities`、`named_objects`、`describe_items`、`render_terrain`、`render_floor`、`describe_battle` 的文字。
- **要移的 Python 测试**:
  - `test_gambit.py`:除了 `test_tactics_rotate_after_a_bad_battle`(归任务 04)和用到 `battle` 的那三个(`test_items_ordered_this_battle_count_as_used`、`test_judge_reads_the_party_after_a_battle`,以及任何 import battle 的);
  - `test_skills.py` 里只用 `nav` 和 `view` 的那些;
  - `test_ds.py` 的 `test_render_terrain_marks_player_and_special_cells`、`test_render_floor_marks_walls_floor_and_entities`。

## 回报

照 `tasks/port-rules.md` 的格式。另外说明 gambit 的条件解析器是怎么做的。

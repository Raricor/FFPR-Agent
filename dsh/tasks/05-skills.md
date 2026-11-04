# 任务 05:技能(光标、菜单、存档、商店、移动、战斗)

先读 `CLAUDE.md` 和 `tasks/port-rules.md`。任务 02–04 已经合进来了，它们的模块直接用。

## 你负责(只写这些文件和它们的测试)

| TS 文件 | 从 Python 移植(`agent/src/ffpr_agent/skills/` 下) |
| --- | --- |
| `src/engine/skills/cursor.ts` | `cursor.py` |
| `src/engine/skills/menu.ts` | `menu.py` |
| `src/engine/skills/save.ts` | `save.py` |
| `src/engine/skills/shop.ts` | `shop.py` |
| `src/engine/skills/move.ts` | `move.py` |
| `src/engine/skills/battle.ts` | `battle.py` |
| `test/fake-pilot.ts` | 新写：按脚本回答的假 `Pilot`(见下) |

## 要点

- **技能都接收一个 `Pilot`**(`src/engine/pilot.ts`),不接收 laptop:
  - Python 的 `send(laptop, op, …)` 写成 `pilot.send(op, {…})`;
  - `query(laptop, q)` 写成 `pilot.query(q)`;
  - `time.sleep` 写成 `pilot.sleep`,`time.monotonic` 写成 `pilot.now`(秒和毫秒要换算对)。
- **模块级的可变状态改成显式参数**(这是唯一允许的设计改动):
  - `battle.py` 的 `table_for`、`report` 是 Game 往模块上挂的钩子;
  - `move.py` 的 `drake` 是模块变量。
  - TS 里改成一个由调用方传入的对象(比如 `BattleHooks { tableFor, report }`、`MoveState { drake }`),Game 持有它。在回报里说明你怎么做的。
- `say` 回调(Python 的 `say=lambda _: None`)保留成可选参数。
- 中文的结果和报错原样照搬(「已经学会了」「没人用得上就不买」之类)。

## `test/fake-pilot.ts`

- 按 op 注册回答:固定值、按次序的一串值，或者函数;
- 记下每一次调用(op、字段);
- 自带假时钟:`sleep` 只推进 `now`,不真的等;
- 某个 op 没有注册回答时直接报错，把 op 名字说出来，免得测试悄悄走错路。

## 对照测试

- 这一层大多在和游戏来回，对照数据怎么做:
  - 从探针文件里找真实的 `shop`、`menu`、`battlemenu`、`items`、`saveui`、`collision`、`route` 回复，作为假 pilot 的回答;
  - 在 Python 那边用同样的假回答跑同一个技能函数，导出它发出的按键序列和返回值;
  - TS 版必须发出同样的序列、返回同样的结果。
- 做法提示：Python 的测试是用 monkeypatch 换掉 `query`、`send`;导出脚本可以照样做。
- **要移的 Python 测试**:
  - `test_skills.py` 里用到 `cursor`、`move`、`save`、`shop` 的那些;
  - `test_gambit.py` 里用到 `battle` 的(`test_items_ordered_this_battle_count_as_used`、`test_judge_reads_the_party_after_a_battle`)。

## 回报

照 `tasks/port-rules.md` 的格式。

# 任务 86:战术官不再挡路——路上的触发在后台写表、同一张图不重复叫

工作目录 `dsh/`。只许改 `src/engine/facts.ts`、`src/engine/game.ts`、`src/plugin/tactician.ts`、`src/plugin/config.ts`、`src/plugin/player.ts` 和 `test/` 下相关文件。另一个任务 87 同时在新建 `src/engine/route/execute.ts` 等新文件，不要碰 `src/engine/route/`。不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,不连真的笔记本。

## 起因(11-10 真机数据)

- 01:48 到 03:08 一共叫了 **30 次**战术官，每次 31–133 秒(平均约 45 秒),**合计约 23 分钟**。走路、开宝箱的工具要停下来等它写完(`Game.afterTool` → `chooseTrigger` → `runTactician(..., true)` 同步等)。
- 同一张图反复叫:271 叫了 7 次、100 叫了 4 次、99 叫了 3 次(多是 `new-monster`)。
- 卡纳克城限时逃脱(10 分钟倒计时)里叫了 11 次，开宝箱的 `interact` 平均 73 秒，倒计时到点、城爆炸、游戏结束。AI 自己思考整段只有 35 秒。
- 用户：寻路和行动太慢，“每个地图都在思考”。

## 做法

触发种类见 `src/engine/facts.ts` 的 `chooseTrigger`:`party-changed`、`new-map`、`new-monster`、`bad-battle`、`blocked`、`conveyor`;首领相关的 `boss-prep`、首领战、全灭复盘在 `game.ts` 别处。

1. **路上的触发改成后台**(`new-map`、`new-monster`、`blocked`、`conveyor`、`party-changed`):
   - `afterTool` 发起战术官调用后**不等**,立刻返回;工具结果写一行「战术官在后台写地图 N 的规则表，写好之前按现有表 / 默认规则打」;
   - 写好后装上规则表，并在下一次工具结果里附上战术官的说明(和现在同步时给的内容一样);
   - 同一游戏同时最多一个后台调用;同一张图已经在写，就不再发;最多排 1 个待办(新的覆盖旧的);
   - 先查 dsh 子智能体能不能在发起它的那次工具调用结束后继续跑(`callTactician` 用的是当次调用的 `binding.agent` 和 `binding.signal`;接口查装好的 dsh 的 `README.zh.md` 和 `lib/types`)。**如果 dsh 不允许子智能体活过那次工具调用**,就不做后台，改做第 2、3 条，并在回报里说明查到的依据。
2. **同一张图不重复叫**:
   - 已经有表的图，遇到新怪不再叫，只记下这只怪(下一次因别的原因叫战术官时一起交给它);例外：新怪是首领，或者这张图上一场战斗评为 hard / lost;
   - 同一张图两次路上触发至少间隔 N 分钟(`Config`,默认 10)。
3. **首领不变**:`boss-prep`、首领战写表、首领战全灭后的复盘，照旧同步(开打前必须有表)。
4. 战后复盘(`bad-battle`)也走后台。

## 测试

- 用替身 tactician(可控延迟的 Promise):路上触发时工具立即返回、结果里有“在后台写”;写好后下一次工具结果里有说明、表已装上;
- 同一张图写的过程中再触发不发第二个;新怪在已有表的图上不叫，首领新怪照叫;间隔内不叫;
- `boss-prep` 仍然同步;
- `npm run check` 全部通过。

## 回报

不超过 30 行:dsh 子智能体能否活过工具调用(依据)、改了哪些文件、各种触发现在怎么处理、`npm run check` 结尾、拿不准的地方。

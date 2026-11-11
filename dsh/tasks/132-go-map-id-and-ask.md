# 任务 132:`go` 按地图号时 57 秒不动;`ask.mjs` 等满 15 分钟就报错

工作目录 `dsh/`。可以改 `src/engine/skills/travel.ts`、`scripts/ask.mjs`、`test/` 下相关测试。不碰 `src/engine/game.ts`、`src/engine/stage/`、`src/engine/route/`、`src/engine/prompt.ts`、`src/plugin/config.ts`(任务 131 同时在改),不碰 `../bridge/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**,**不用 docker、不绕开沙箱**。

## 起因(11-11 真机)

1. 人骑陆行鸟在世界地图 (156,139),模型调 `go {"to":"194"}`(洞窟 3 层),57.3 秒后回「跳数:0」,人没动。同一档里 `go {"to":"30"}`(图尔村)在门口时回「跳数:0」是对的(已经在 30),但 194 不是。另外 `go {"to":1}` 在 189 出口旁回「跳数:0(0.4 秒)」也是对的(人其实已经在世界地图)。查清 `travelToMap` 在什么情况下返回 0 跳却 `reached`/不报错，为什么花了 57 秒(很可能在世界地图连通块或碰撞读取上，任务 123/127 改过);目标图到不了时要说清“到不了”和原因，而不是「跳数:0」。
2. `scripts/ask.mjs` 等一轮超过 `FFPR_ASK_MINUTES`(默认 15)分钟就抛「no turn/end within 15 minutes」退出码 1;目标模式下一轮常常超过 15 分钟，这一轮本身没事。改成：超时只打印一行“还在跑，ask.mjs 不再等(会话 X、轮次 Y)”并以退出码 0 结束(或加 `--wait-forever`);默认分钟数调到 60。

## 测试

- 假桥插件复现“`go` 地图号、目标到不了 → 立即说清原因，不报 0 跳”;已经在目标图 → 0 跳且写明“已经在地图 N”;
- `ask.mjs` 的超时分支(用假的会话事件);
- `npm run check` 全过。

## 回报

不超过 10 行：57 秒和 0 跳的原因(引代码行)、改法、`ask.mjs` 的新行为、`npm run check` 结尾。

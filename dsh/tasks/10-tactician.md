# 任务 10:第二层「战术官」(《分层控制方案》§4.12 A2、A3)

先读 `CLAUDE.md` 和《分层控制方案》§4.12(`/root/data/mediaflow/MyDesign/FFPR-Agent/ffpr-agent-分层控制方案.md`)。新功能，只改 TS 版。任务 07–09 已经合进来。

## 目标

战术由代码在固定时机叫第二层来写，不再靠第一层(FF5 玩家)想起来调 `set_tactics`。

第二层是 dsh 子智能体「FF5 战术官」:
- 读代码拼好的事实单;
- 交回结构化结果：规则表、走法说明、往上的建议;
- 网页上能看到它的会话。

## 设计(定好的)

### 1. 两个角色，一个插件

- 插件的 `Config` 加 `role: "player" | "tactician"`(默认 `player`)。`cordis.patch.yml` 加一个预设:
  - `id: ffpr-tactician`,`name: FF5 战术官`,`order: 1`;
  - plugins 里是本插件一行(`config: { role: tactician }`),加上压缩那组。
- **`tactician` 角色**:
  - 不启动引擎(不连笔记本、不跟随事件流);
  - 只注册两个只读工具:`guide`、`atlas`(各自从文件加载 `Guide`、`Atlas`);
  - 人设是 `prompt.ts` 里新写的 `TACTICIAN_PROMPT`;
  - 同样在 `agent.ctx` 上注册，`restrict({ allow: [] })`,`suppressRuntimeContext()`;
  - `structured_output` 工具由 `dsh-subagent` 自动挂上，不用管。
- **`player` 角色**:照旧，外加第 3–5 条。

### 2. `TACTICIAN_PROMPT`(中文，放 `prompt.ts`)

- **身份**:你是战术官，只管这一张地图;不走路、不按键，只读事实单、按需查攻略，然后交结果。
- **规则表的写法**:照搬 `SYSTEM_PROMPT` 和 `fight`、`set_tactics` 工具说明里讲规则表的部分(词汇、目标、「最强」、「X+」、属性词汇),写成一份完整的。
- **原则**:
  - 每个人最后一条是无条件的兜底;
  - 复活、回复、治状态写在前面;
  - 用敌人的弱点，不用它吸收的属性(事实单里有);
  - 治状态要的道具包里没有，就写进 `ask_up`。
- **走法说明**:从攻略里找这张图的那一段，写清楚：机关和开关的顺序、传送带、先拿哪些宝箱、出口在哪。300 字以内。

### 3. 事实单 `src/engine/facts.ts`(引擎，不 import dsh)

`buildFacts(game, trigger)` 拼一段中文文字，几节:

- **起因**:为什么叫你(进新地图 / 新怪物 / 打得不好 / 被挡 / 首领战)和细节;
- **地图**:编号、名字、出口和去向、宝箱、带名字的事件格(用任务 09 的说明)、地图记录里的走法;
- **攻略**:这一带整章原文(用 `game.ts` 的 `guide_hint` 找地区的办法，取整章;太长就截到 6000 字，先保留讲这张图的部分);
- **怪物**:这张图见过的怪。每只写图鉴号、HP(有的话)、弱点和吸收(`elements.ts`)、攻略里的说明(`monster_note`);
- **队伍**:每人的职业、等级、HP/MP、状态异常、会的法术和 MP(从 `sample`、`menu` 能读到的);
- **背包**:回复、复活、治状态的道具和数量;
- **上次战斗**:这张图最近几场的结果(`Tactics` 里的 `results`)。

### 4. 结构化结果

- `outputSchema`(JSON Schema),三个字段都必填:
  - `tactics`:1–3 套规则表，每套 `{角色名: [规则…]}`,规则 `{if?, do, target?}`;
  - `walker_notes`:字符串;
  - `ask_up`:字符串，没有建议就是空串。
- 拿到以后，每套表跑 `gambit.check()`:
  - 有问题，就再叫一次战术官，把问题附在事实单后面;最多再试 2 次;
  - 还不行，就装上能通过的那几套，并在结果里说明。

### 5. 触发(代码强制，写在 `game.ts` 每个工具之后那段)

- `Game` 构造时接收一个可选的 `tactician: (facts: string) => Promise<TacticianPlan>`;引擎不知道它背后是 dsh。
- **何时叫**:
  1. 进了一张 `tactics.current(map)` 为空的地图;
  2. 这张图出现了写战术时没见过的怪(`Tactics` 的条目里记下写表时见过的怪);
  3. `tactics.record` 判 hard 或 lost;
  4. 同一处被挡 3 次，或者被传送带带走(任务 09 的记录);
  5. 首领战开始，且 `Config.tacticianBoss` 为真(默认真)。这时战术官写首领战的表，代码直接 `battle.fight` 打，结果接在工具结果里;为假时照旧停下让第一层用 `fight`。
- **叫完以后**:
  - 装上规则表(`tactics.set`,首领战除外);
  - 工具结果里接一段「战术官(地图 X):<walker_notes>」,`ask_up` 不空时再接一句「战术官建议:…」;
  - 一次工具调用最多叫一次战术官。

### 6. 胶水(`src/plugin/`)

- `tactician` 函数在每次工具调用时绑定 `exec.agent` 和 `exec.signal`,调用:

  ```
  ctx.subagents.startActivation({
    provider: "spawn",
    label: "战术官 地图 X",
    request: { agentPreset: "ffpr-tactician", prompt: [事实单], parent: exec.agent, signal, outputSchema },
    delivery: "caller",
  })
  ```

  等 `result` 回来，读 `structured`(先查清服务名、provider 名和这些字段，看 `dsh-subagent`、`dsh-subagent-spawn-in-process` 的 README 和 `lib/types`)。
- 战术官单次时限 180 秒。所有可能触发战术官的工具，时限各加 200 秒。
- 当前地图战术官的 `walker_notes` 和 `ask_up` 作为动态上下文给第一层(写法和笔记那段一样),换地图时更新。

### 7. 第一层的提示词(`SYSTEM_PROMPT`,这次允许改)

- 讲「进新地图先写策略」「首领战用 fight 交规则表」的那几句，改成:
  - 普通战斗的策略由战术官自动写好;
  - 工具结果里「战术官」开头的是它的说明和建议，照走法说明走，它建议回城买东西时认真考虑;
  - 首领战由战术官写表、代码打完(`tacticianBoss` 为真时);
  - `set_tactics` 和 `fight` 只在要手动改的时候用。
- 其余原文不动。

## 测试

- `buildFacts`:用 `fake-pilot` 和真实形状的数据拼一份，检查各节都在、属性和攻略说明进去了、太长时截断。
- 触发：五种情况各一次，用假的 `tactician` 函数。同一次工具调用只叫一次;check 不过就重试，最多 2 次。
- 胶水：用假的 `subagents` 服务，检查请求的字段(preset、parent、schema、delivery)和结果的读取。
- `role: tactician`:不启动引擎;只有 `guide`、`atlas` 两个工具。

## 回报

不超过 40 行:
- 改了哪些文件、`npm run check` 结尾;
- `startActivation` 实际的服务名和字段(出处);
- 拿不准的地方。

不要编译、不要重启网页。

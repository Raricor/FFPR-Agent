# 任务 88(桥插件 0.14.3):读出倒计时;认出游戏结束和“返回标题”的选择框

工作目录 `bridge/`。只改 `bridge/src/`、`bridge/README.md`(和版本号 `src/Version.cs`)。不碰 `../dsh/`、`../deploy/`、`../agent/`,不碰 git,**不连笔记本**、不装插件(Claude 来装)。桥插件**只读**游戏状态，不改游戏数据(按键只走现有虚拟手柄，这个任务不加按键)。

编译只编 FF5 一次:`dotnet build -p:Game=ff5`(先确认没有别的 `dotnet build` 在跑;开发机内存有限，一次只跑一项重型检查)。再确认其他五作的条件编译不受影响(改动包在 FF5 专有的 `#if` 里，或者用的类六作都有)。

反编译的游戏代码在 `../.deps/ff5/decompiled/`(IL2CPP 外壳，有类、字段、方法名，没有方法体)。现有查询怎么写，看 `src/GameState.*.cs` 和 `README.md`。

## 起因(11-10 真机)

1. **限时逃脱看不到倒计时**:FF5 卡纳克城逃脱有 10 分钟倒计时，画面上显示(地图上左上角一个小框“08:07”,战斗中右上角“03:21”)。桥插件的 `sample`、`pos` 里没有任何计时器字段，AI 不知道还剩多少时间，倒计时到点城爆炸、游戏结束。
2. **认不出游戏结束的画面**:全灭或倒计时到点后，画面是
   - 「读取」窗口，上面一个“自动保存”的存档栏，下面问「要从最新的保存数据开始吗？」「是 / 否」(默认“是”);
   - 选“否”后是「返回标题画面。可以吗？」「是 / 否」(默认“否”)。
   - 这时桥插件报的是 `state: Event`,`dialog` 里还留着游戏结束前最后一句台词，`saveui.open` 是 false、`title.open` 是 false。代码和 AI 都以为在放剧情，`advance_story` 一直等，整个卡住。Claude 手动操作时也因为分不清这两个框按错过一次。

## 做法

1. **倒计时**:在反编译代码里找到游戏的倒计时(关键词:Timer、CountDown、LimitTime、TimeLimit 之类;它在战斗中也显示);只读地给出 `timer: { active: bool, seconds: number | null, paused: bool | null }`,放进 `sample`(也可以放进 `pos`,写明)。开始和结束时推送一个事件(名字照现有推送的风格)。
2. **游戏结束的选择框**:找到这两个窗口对应的控制器(游戏结束/继续、读取自动保存、返回标题确认)。在 `sample`(或新查询 `gameover`)里给出:
   - `gameover: { open: bool, prompt: "continue" | "to-title" | null, cursor: 0 | 1 | null, autosave: { map, label, time } | null }`;
   - `cursor` 0 是“是”、1 是“否”;读不到的写 null,不要猜。
   - 这时 `pos.state` 如果游戏自己有对应的状态名就照给;没有就在 README 里写明“看 `gameover.open`”。
3. README 写清新字段和推送，版本号改 0.14.3,更新记录里写一条。
4. 找不到的(类名、字段)写进回报，不要编造;推断的地方在注释里写“推断，待真机核对”。

## 回报

不超过 30 行：找到的类和字段(文件名)、新字段的形状、`dotnet build -p:Game=ff5` 的结尾输出(0 警告 0 错误)、拿不准要真机核对的地方。

# 任务 22:五作开局遇到的画面

先读 `dsh/CLAUDE.md` 和 `tasks/21-six-players.md`。只改 TS(`src/engine`、`src/plugin`、`test`)。不碰 git,不重启网页。

## 起因

10-28 晚，五作的 DeepSeek 玩家第一次跑起来，开局就卡在三种画面上。

- `advance_story` 遇到不认识的画面，一直按确定，一次调用跑了 15 分钟以上。

桥插件 0.10.0 已经加了这些(Claude 加的，已装):

| 新东西 | 是什么 |
| --- | --- |
| 查询 `textinput` | 屏幕上的文字输入框(起名框):`{open, fields: [{name, text, focused}]}` |
| 按键名 `TextEnter`(`keys` 带 `"via": "game"`) | 给正在输入的文字框按 Enter:保留框里的名字，结束输入。之后游戏会问「要使用这个名字吗?是 / 否」,光标默认在「是」,再按 Enter 确认 |
| 按键名 `PadStart`、`PadSelect`、`PadWest`、`PadL1`、`PadR1` | 手柄的其他按钮 |
| 查询 `shot` | 截图存到笔记本，回复里是文件路径(给 Claude 调试用，玩家用不上) |

## 1. 操作提示层(`FieldHelp`)

- 第一次进地图时，五作都会弹出操作说明，主状态是 `FieldHelp`。
  - 确定、取消都关不掉;`PadStart` 能关(10-28 FF3 实测)。
- `advance_story`、`walk_to` / `go_to`、`interact` 碰到 `FieldHelp`:
  - 按一次 `PadStart`(`via: "game"`)关掉，接着做原来的事;
  - 结果里写一句「关掉了操作提示」。
- 关不掉(按 3 次还在)就停下报告，不要一直按。

## 2. 起名框

- FF6 每个新角色入队都要起名，其他作品剧情里也可能有。
- `advance_story` 每一轮先查 `textinput`:有 `focused` 的框，就按 `TextEnter`,再按 Enter 确认「是」。
  - 用框里原有的名字，也就是默认名;
  - 结果里写「给 X 起名(默认名)」。
- 桥插件太旧、没有 `textinput`(回复报 unknown op)时跳过这一步。

## 3. `advance_story` 卡住就停

- 连续 8 次按确定，主状态、地图、对话文本、选项都没变，就停下返回：
  - 「画面没有变化，可能是工具认不出的界面」;
  - 附上当前状态。
- 不要再按。

## 4. 五作的玩家加一个 `press` 工具

给工具认不出的界面用。现在知道的有 FF2 的关键词菜单：对话旁出现「询问 / 记忆 / 贵重物品 / 离开」。

- **参数**:`keys`,1–6 个按键，从这些里选:
  - `Enter`(确定)、`Backspace`(取消)、`Up`、`Down`、`Left`、`Right`;
  - `Tab`(菜单)、`PadStart`、`PadWest`。
- **做法**:用 `via: "game"` 按完，等一下，返回当前状态。
- 只给 FF1–FF4、FF6 的玩家，FF5 不加。

工具说明:

```
按手柄键。只在其他工具都处理不了的界面上用(比如 FF2 对话旁的「询问/记忆/贵重物品/离开」菜单),按完会返回当前状态。
```

**FF2 的要点**(`prompt.ts`)加一行:

```
- 对话旁出现「询问 / 记忆 / 贵重物品 / 离开」菜单时，这是关键词菜单：用 press 选「记忆」([Down, Enter])记住对话里的红字关键词，再选「离开」退出;有人提到你记住的关键词时，用「询问」问他。
```

## 测试

- `FieldHelp`:假桥插件先回 `FieldHelp`,按 `PadStart` 后回 `Player`。
  - `advance_story` 关掉提示后接着翻页;
  - 按 3 次还关不掉就停下。
- 起名:`textinput` 有 focused 框时，发出 `TextEnter` 再发 Enter。
  - 没有这个查询时不报错。
- 卡住：状态连续 8 次不变时返回「画面没有变化」。
- `press`:
  - 五作有这个工具,FF5 没有;
  - 不在列表里的按键被拒绝;
  - 超过 6 个被拒绝。
- FF5 现有测试全过，FF5 的提示词、工具列表一字不差。

## 回报

不超过 30 行：改了哪些文件、`npm run check` 结尾、拿不准的地方。

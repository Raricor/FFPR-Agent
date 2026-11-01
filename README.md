# FFPR-Agent

让 AI 自动玩 Steam 版《FINAL FANTASY I–VI Pixel Remaster》,以 FF5、FF6 为主：通关、拿全成就。

**版本 v0.1.0**(2026-10-27),改动见 [CHANGELOG.md](CHANGELOG.md)。

## 现状

- **主线是 dsh 插件版**(`dsh/`,TypeScript):DeepSeek(只用 `deepseek-flash`)在 DeepSeek Harness(dsh)的网页里玩 FF5。代码多数由 dsh 写，规范和审查见 `dsh/CLAUDE.md`(本机文件，不进版本库)。
- **Python 版**(`agent/`)已冻结，作为移植时的对照基准，不再加功能。
- **游戏进度**:FF5 打到卡纳克，下一段是火力船。3 号档是第 26 次存档(卡纳克镇外，全员满状态)。
- **能做到的**:
  - 寻路、走格子、开宝箱、对话、住店、买东西、换职业、存读档;
  - 战斗按规则表自动打，规则可以针对具体敌人写;首领战由战术官写表、代码照表打;
  - 三层控制：玩家(第一层)、战术官(第二层，子智能体)、代码执行(第三层);
  - 网页右侧栏两个常驻面板:「FF5 成就」(成就、图鉴、宝箱)和「FF5 策略」(当前地图的规则表、遇敌表、每种敌人的推演);
  - 游戏可以最小化在后台玩，不抢焦点，不占用你的键盘。
- **还缺的**:跨好几张地图的迷宫会迷路(火力船);下一步是让代码负责地图之间的移动。见 `MyDesign/FFPR-Agent/ffpr-agent-待办.md`。

## 文档

设计文档在 `MyDesign/FFPR-Agent/`:

| 文档 | 写什么 |
| --- | --- |
| `ffpr-agent-设计方案.md` | 目标、架构和各部分的设计(以 P0 实测为准修订过) |
| `ffpr-agent-分层控制方案.md` | 三层控制、局域网直连、各层之间的约定(§4.12) |
| `ffpr-agent-dsh接入方案.md` | 为什么、怎样做成 dsh 原生插件(§10:全部 TS) |
| `ffpr-agent-阶段计划.md` | 分阶段的计划和每一步的状态 |
| `ffpr-agent-进展日志.md` | 按日期记录的试玩、运行和改动，最新的在最前面 |
| `ffpr-agent-待办.md` | 还没做的事 |
| `ffpr-agent-P0-结论.md` | P0 关口报告 |

代码仓库里:

| 文档 | 写什么 |
| --- | --- |
| 本文件 | 代码地图和常用命令 |
| `CHANGELOG.md` | 版本记录 |
| `dsh/CLAUDE.md` | dsh 插件的开发规范(dsh 和 Claude 共用;只在本机，不进版本库) |
| `dsh/tasks/` | 交给 dsh 的每个任务的说明 |
| `bridge/README.md` | 桥插件：记录格式、查询、按键、用到的游戏类。**「桥能读什么」以这里为准** |
| `deploy/laptop/README.md` | 笔记本端脚本、账号和计划任务 |

## 架构

```
开发机(Linux)                                         笔记本(Windows,你的桌面会话)
┌──────────────────────────────────────┐            ┌──────────────────────────────────────┐
│ dsh 网页 :3081(ffpr profile)          │  局域网     │ FF5 + BepInEx + FfprBridge 0.9         │
│   FF5 玩家     第一层(DeepSeek)        │  WebSocket  │   读游戏状态，推送事件                 │
│   FF5 战术官   第二层(子智能体)        │ ─────────► │   回答查询(地图、菜单、战斗、成就……)  │
│   引擎         第三层：寻路、技能、     │  查询、按键 │   虚拟手柄按键(不需要前台)           │
│                规则表执行             │ ◄───────── │                                        │
│   右侧栏面板 FF5 成就 / FF5 策略       │  事件流     │                                        │
│ ffpr-pilot / ffpr-laptop(Python 命令) │  SSH        │ pilot-agent.ps1 试玩助手               │
│   重启游戏、装插件、手动试玩           │ ─────────► │   走格子、普通战斗、翻剧情、截图       │
│ ffpr-ach 成就记录器                   │            │   (按键也交给桥插件的虚拟手柄)       │
└──────────────────────────────────────┘            └──────────────────────────────────────┘
```

| 目录 | 内容 |
| --- | --- |
| `dsh/` | dsh 原生插件(TS)。`src/engine/` 游戏引擎，不依赖 dsh;`src/plugin/` dsh 胶水(工具、提示词、战术官、命令、面板路由);`src/client/` 网页右侧栏面板;`scripts/` 开发脚本;`tasks/` 任务说明;`test/` 测试 |
| `bridge/` | 桥插件 `FfprBridge`(C#,BepInEx 6 IL2CPP),见 `bridge/README.md` |
| `deploy/laptop/` | 笔记本端 PowerShell:试玩助手 `pilot-agent.ps1`、等标题画面 `wait-title.ps1`、安装 BepInEx、开通 SSH 和计划任务的一次性脚本、公共模块 `FfprCommon.psm1` |
| `agent/` | Python 版(包 `ffpr_agent`,已冻结):笔记本操作、试玩助手客户端、寻路、技能、DeepSeek 玩家 `ffpr-ds`、攻略知识库、日志工具 |
| `ach/` | 成就记录器 `ffpr-ach`(设计方案 §13),独立的包，只依赖 `common/` |
| `common/` | 公共部分：六作登记表、数据和配置目录、密钥读取、日志脱敏 |
| `tools/` | 只服务开发:PowerShell 脚本检查、打包首次安装用的压缩包、局域网连接的测试替身 `link_harness` |
| `.deps/` | 不进版本库：程序集和反编译结果、探针日志、地图记录、战术和属性记录、攻略缓存、截图 |

## 规矩

- **密钥**只放在 `~/.config/ffpr-agent/secrets.env`(权限 600,不进版本库，不贴进聊天):`DEEPSEEK_API_KEY`、`BRIDGE_TOKEN`、`STEAM_WEB_API_KEY`、`STEAM_ID64`。dsh 自己的 key 在 `~/.dsh/.env`。
- **模型**只用 `deepseek-flash`。
- **存档**只写 3 号位。
- **桥插件**只读游戏状态，不改游戏数据和存档;唯一的例外是虚拟手柄按键。
- **笔记本**只在家里的局域网连;不远程解锁。

## 开发机环境

- Python 3.12,用 uv 管理:`uv sync`。工作区有三个包:`common`、`ach`、`agent`。
- Node 24 和 npm(dsh 插件)。dsh 装在 `/root/.npm-global`,`npm install` 时会把 `node_modules/@deepseek-ai` 链接过去。
- .NET 8 SDK 装在 `~/.dotnet`,反编译工具 `ilspycmd` 在 `~/.dotnet/tools`:

  ```bash
  export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$HOME/.dotnet/tools:$HOME/.local/bin:$PATH
  ```

- `pwsh` 装在 `~/.local/bin`,只用来检查 PowerShell 脚本的语法。

```bash
make check                                    # Python:ruff、pytest、PowerShell 脚本检查
cd dsh && npm run check                       # dsh:类型检查、eslint、prettier、测试
cd dsh && npm run build                       # 编译插件和网页面板(lib/)
~/.dotnet/dotnet build bridge -c Release -p:Game=ff5   # 编译桥插件
make laptop-bundle                            # 打包 deploy/laptop,首次开通 SSH 时手动拷到笔记本
```

## 操作笔记本

先按 `deploy/laptop/README.md` 开通 SSH,再复制 `agent/laptop.env.example` 为 `agent/laptop.env` 并填写。

```bash
uv run ffpr-laptop ping                          # 检查连接
uv run ffpr-laptop deploy                        # 同步 deploy/laptop 到 C:\ffpr\deploy\laptop
uv run ffpr-laptop install-plugin ff5            # 编译并安装桥插件(游戏需已退出)
uv run ffpr-laptop launch ff5                    # 在笔记本桌面上启动游戏
uv run ffpr-laptop fetch-assemblies ff5          # 取回程序集到 .deps/ff5
uv run ffpr-laptop probe-logs ff5 --last 12      # 取回探针日志到 .deps/ff5/probe
uv run ffpr-laptop logs ff5                      # 取回 BepInEx 日志
```

**局域网直连**(只需设置一次):

```bash
uv run ffpr-laptop deploy
# 你在笔记本上用管理员身份运行一次:
#   powershell -ExecutionPolicy Bypass -File C:\ffpr\deploy\laptop\allow-bridge-lan.ps1
uv run ffpr-laptop link                          # 生成令牌，写 C:\ffpr\bridge.json(重启游戏后生效)
uv run ffpr-pilot link                           # 检查连接，和 SSH 比较延迟
```

## 让 DeepSeek 玩(dsh 版)

1. **重启游戏**:退出游戏、装上最新桥插件、启动、等标题画面、启动试玩助手、读档。

   ```bash
   uv run ffpr-pilot restart --slot 3
   ```

   游戏启动后可以最小化，照样能玩。

2. **启动网页**(改了插件代码以后也要重启):

   ```bash
   dsh/scripts/web.sh          # 网页在 :3081,带令牌的链接在 ~/.dsh/logs/web-ffpr.log
   ```

   在网页里新建会话，默认就是「FF5 玩家」,直接下目标，比如「进入火力船，找到并打败首领」。

3. **从命令行下目标、看结果**(不用开网页):

   ```bash
   node dsh/scripts/ask.mjs "目标：……"                  # 新建会话，等这一轮结束，打印事件
   node dsh/scripts/ask.mjs --session <id> "继续"       # 在同一个会话里接着说
   node dsh/scripts/ask.mjs --brief <id>                # 每次工具调用和回复一行
   node dsh/scripts/ask.mjs --command "/ach"            # 跑一个斜杠命令
   ```

   `FFPR_ASK_MINUTES` 设等多久(默认 15 分钟)。

4. **看进度**:
   - 网页右侧栏的「FF5 成就」:成就(本档进度和 Steam 解锁)、图鉴(全账号，按地点，每只怪的介绍、会错过的)、宝箱(按地点，不可回收的);
   - 网页右侧栏的「FF5 策略」:当前地图的规则表和备用策略、遇敌表、每种敌人的第一招推演、最近的战斗、战术官的说明、其他地图的策略;
   - 会话里输入 `/ach`:成就进度的文字版。

## 手动试玩

同一套技能的命令行(Python 版):

```bash
uv run ffpr-pilot route 26 13                    # 寻路走到某格
uv run ffpr-pilot walk 90 76                     # 闭环走格子(试玩助手在笔记本本地做)
uv run ffpr-pilot open 28 17                     # 走到宝箱 / NPC 旁边，按确认并翻完对话
uv run ffpr-pilot story                          # 按阅读速度翻剧情，遇到选项、战斗、商店就停
uv run ffpr-pilot battle                         # 普通战斗：连按确认，打完就停
uv run ffpr-pilot save --slot 3                  # 存档，用存档计数核对
uv run ffpr-pilot entities --kind GotoMap        # 当前地图的入口、宝箱、NPC
uv run ffpr-pilot keys Down*3 Enter --shot       # 直接按键并截图
uv run ffpr-pilot status                         # 游戏在不在、在不在前台、锁没锁屏
uv run ffpr-pilot stop
```

## 攻略、日志与成就

```bash
uv run ffpr-guide fetch          # 下载 Steam 社区攻略、图鉴和 ludo.guide 到 .deps/knowledge(只在本地)
uv run ffpr-guide show 沃尔斯塔   # 查地区、怪物(图鉴编号或英文名)、首领

uv run ffpr-keylog ff5           # 关键日志 → .deps/ff5/key/
uv run ffpr-probe ff5            # 最新一份探针日志的汇总

uv run ffpr-ach verify-counts    # 不需要 key:核对六作成就数量(共 189)
uv run ffpr-ach sync             # 同步成就定义和解锁状态，并生成报告(需要 Steam key)
```

## 版本

- 整个项目一个版本号，记在根 `pyproject.toml`、三个 Python 包和 `dsh/package.json`,现在是 v0.1.0。改动记在 `CHANGELOG.md`。
- 桥插件另有自己的版本号(`bridge/src/Plugin.cs`,现在是 0.9.1)。引擎按它判断桥插件支持哪些功能，`restart` 也按它确认装上的是新版，所以和项目版本分开。

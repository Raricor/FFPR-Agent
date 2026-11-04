# 任务 38:策略语言 2.0 的核心：解析、求值、选目标、中文翻译、旧表转换、检查

方案在 MyDesign 的《ffpr-agent-战斗策略方案》§6,你读不到，规格都写在下面。这个任务**只做纯函数模块和测试**，不接进战斗执行(那是下一个任务)。

范围:
- 只在新目录 `src/engine/strategy/` 里写代码，测试放 `test/strategy-*.test.ts`;
- 不改 `src/engine/` 里别的文件，不改 `src/plugin/`、`src/client/`(另一个任务正在改);
- 可以 import `skills/gambit.ts`、`elements.ts`、`values.ts` 等，但不改它们;
- 不改 `package.json`、`tasks/`、`lib/`;不碰 git;不运行 `npm run build`、`scripts/web.sh`、`scripts/ask.mjs`;不连笔记本。
- **重型检查要排队**：另外几个任务在同时跑。`npm run check` 一律写成 `flock /tmp/ffpr-heavy.lock npm run check`。

## 起因

- 现在的规则语言(`skills/gambit.ts`)：每个角色一列 `{if, do, target}`;条件是 17 个固定的词，只能用 and 连;目标 7 种写死的;动作只有攻击、防御、指令:魔法、道具。
- 这样写不出下面这些规则:
  - “合翅膀(编号 282)时全员防御”;
  - “谁被沉默就用回音草”;
  - “玛基莎放了魔法就给还没有魔法护盾的人上魔法护盾”;
  - “弗扎出来以后先集火玛基莎”。
- 用户 11-03 定了:**结构用 JSON,表达式用函数式的英文写法，游戏里的词(人名、怪名、魔法、道具、状态、属性)用中文。**

## 规格

### 一份策略

```jsonc
{
  "version": 2,
  "summary": "一句话",
  "roles": {"蕾娜": "治疗", "加拉夫": "黑魔"},   // 可选;定位是自由文本，执行器的兜底会认「治疗」
  "reactions": [ /* 对策：规则 + "on" */ ],
  "phases": [{"name": "合翅膀", "when": "enemy(282).alive", "note": "…", "rules": [ … ]}],
  "rules": [ … ]                                  // 没有阶段时直接写规则;phases 和 rules 二选一
}
```

- 规则 `{who, if?, do, to?, once?, note?}`;对策多一个 `on`(表达式，语义同 `if`,只是先于阶段检查)。
- `who`:角色名 | 定位名 | `all` | `any`。

### 表达式文法(不用 eval)

```
expr    := or
or      := and ("or" and)*
and     := not ("and" not)*
not     := "not" not | cmp
cmp     := sum (op sum)?            op: < <= == != >= >
sum     := value                    (先不支持加减)
value   := number | "true" | "false" | path | "(" expr ")"
path    := head ("." member)*
head    := self | ally | enemy | item(词) | turn | battle
member  := 名字 | 名字(参数, …)
```

- 集合与单位:
  - `ally`、`enemy`:活着的我方 / 敌方全体，求值成“单位集合”;
  - `ally(蕾娜)`:按名字取一个人;`enemy(玛基莎)`:按名字;`enemy(282)`:参数是数字时按编号(形态);
  - `enemy.boss`:首领;
  - `self`:正在行动的人;
  - 名字取到的单位不存在或已倒下时：数值属性取 0,`alive` 为 false。
- 集合上的方法:
  - `.any(谓词)` / `.all(谓词)` / `.count(谓词)`;
  - `.lowest(属性)` / `.highest(属性)`:取一个单位;
  - `.first(谓词)`:第一个满足的单位;
  - `.alive`:集合里活着的个数。
  - 谓词里直接写单位属性，例如 `ally.any(hp_pct < 50)`、`enemy.any(has(反射))`;可以用 and/or/not。
  - `ally.any(not alive)` 这类判断要包含已倒下的人：集合方法里 `alive` 为 false 的单位也参与判断。写清楚：哪些写法只看活着的，哪些包括倒下的。
- 单位的属性:
  - 数值:`hp`、`max_hp`、`hp_pct`、`mp`、`max_mp`、`mp_pct`、`id`;
  - 真假:`alive`;
  - 判断:`has(状态)`(状态和增益都算，名字用 `STATUS_ZH` 那样的中文)、`weak(属性)`、`absorbs(属性)`、`immune(属性或状态)`、`used(能力)`、`used(any_magic)`、`countered`。
  - `used`、`countered` 用快照里的事件：从这个人上一次行动到现在(或者从开打到现在);可以带第二个参数，表示秒数窗口。
- 其他:`item(不死鸟之尾)` 背包数量;`turn` 这个人第几次行动;`battle.seconds`、`battle.boss`。
- 求值用一个**战斗快照**类型(在本模块里定义):
  - 我方、敌方单位(名字、编号、HP、MP、状态、属性抗性);
  - 背包;
  - 行动的人和 turn、开打秒数;
  - 最近的事件(谁对谁用了什么能力，是不是魔法，是不是反击)。
  - 下个任务会把战斗菜单的数据和桥插件的出招事件填进这个快照。

### 动作和目标

- `do`:
  - `攻击`、`防御`、`换列`;
  - `道具:名字`;
  - `<指令>:<能力>`:指令名不限，`白魔法`、`时空魔法`、`召唤`、`蓝魔法`、`偷盗`、`瞄准`、`跳跃`、`投掷` 都行，冒号后可省;
  - 保留 `X+`、`最强` 两种写法(本任务只解析，不展开)。
- `to`:
  - 和表达式同一套写法，求值成一个单位，例如 `self`、`ally.lowest(hp_pct)`、`ally(法利斯)`、`ally.first(has(毒))`、`ally.first(not alive)`、`enemy(弗扎)`、`enemy.lowest(hp)`、`enemy.first(weak(冰))`、`enemy.boss`;
  - `enemy.all`、`ally.all` 表示全体;
  - 不写就是游戏默认(敌人)。

### 本任务要交的函数

1. `parseStrategy(json)`:解析，返回策略对象或中文错误列表。错误要带位置，例如「阶段「合翅膀」第 2 条规则的 if 第 15 个字:不认识的方法 hass,是不是 has?」。
2. `evaluate(expr, snapshot)`、`resolveTarget(to, snapshot)`。
3. `describe(...)`:把条件、规则、阶段、对策翻成中文，给侧栏看。例如 `ally.any(hp_pct < 50)` →「有同伴 HP 低于 50%」，`enemy(282).alive` →「编号 282 的敌人还在」。
4. `fromLegacy(v1Table)`:把现在的 `{角色: [{if, do, target}]}` 换成 2.0。旧词按下表换，其余照 `gambit.ts` 的 `VOCABULARY` 一个个对上。

   | 旧写法 | 新写法 |
   | --- | --- |
   | `self.hp`、`self.hp_pct`、`self.mp` | `self.hp`、`self.hp_pct`、`self.mp`(不变) |
   | `ally.hp_pct` | `ally.lowest(hp_pct).hp_pct` |
   | `ally.dead` | `ally.count(not alive)` |
   | `party.alive` | `ally.alive` |
   | `enemy.count` | `enemy.alive` |
   | `enemy.name.X` | `enemy(X).alive` 或 `enemy.count(name == "X")`,二选一，写清楚 |
   | `enemy.id.282` | `enemy(282).alive` |
   | `item.X` | `item(X)` |
   | `ally.status.毒` | `ally.count(has(毒))` |
   | 目标 `hp最低的同伴` | `ally.lowest(hp_pct)` |
   | 目标 `倒下的同伴` | `ally.first(not alive)` |
   | 目标 `状态:毒` | `ally.first(has(毒))` |
   | 目标 `敌人:X` | `enemy(X)` |
   | 目标 `敌人:弱冰` | `enemy.first(weak(冰))` |

5. `checkStrategy(strategy, party?)`:静态检查(结构、词汇、`who` 里的名字在不在队伍里、阶段名不重复、`once` 只能是布尔)。覆盖面检查(有没有人能复活之类)是后面的任务，这里不做。

## 测试

- 解析：优先级(`not a and b or c`)、括号、各种错误及提示;
- 求值：每种属性和方法至少一例;名字取不到时的行为;倒下的人在 `any` / `count` 里的行为;
- 选目标：每种写法至少一例;
- 中文翻译：下面两份策略整体翻译的结果做成快照测试:
  - 巨翼猛禽：两个阶段。「合翅膀」(`enemy(282).alive`):蕾娜在有人低于 60% 时治疗，其余全员防御;「张开」:全员攻击首领。
  - 玛基莎 + 弗扎：两条对策——有人倒下用不死鸟之尾;玛基莎放了魔法，蕾娜给还没有魔法护盾的人上魔法护盾。两个阶段——「两只都在」:蕾娜回复，加拉夫用最强黑魔法打玛基莎，其余人攻击玛基莎;「收尾」:攻击 HP 最低的敌人。
- 旧表转换：把真实的 `.deps/ds/tactics-ff5.json` 里**每一套**表都转一遍，全部成功，转完再解析一遍也没错。文件读不到时跳过这个测试，并说明原因。

`flock /tmp/ffpr-heavy.lock npm run check` 全过，测试数不能比现在少(现在是 509 个)。

## 回报

不超过 30 行:
- 文件清单;
- 文法里你做的取舍(哪些写法只看活着的);
- 两份例子策略的中文翻译原文;
- 旧表转换的结果(多少套、有没有失败);
- `npm run check` 的结尾输出;
- 拿不准的地方。

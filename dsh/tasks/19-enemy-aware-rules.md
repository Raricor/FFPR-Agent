# 任务 19:战斗规则能针对敌人写

先读 `dsh/CLAUDE.md`、`dsh/tasks/port-rules.md`(规则引擎部分)和 `dsh/tasks/18-tactics-tab-enemies.md`。只改 TS。Python 版不动。

## 起因

用户问「为什么没法看见敌人是谁」,并允许调试。查下来，数据其实都有:
- 战斗中桥插件读得到每只敌人的名字、编号、HP;
- 桥插件 0.8.0 还能读当前位置的遇敌表(`encounters`)。

缺的是规则这一层:
- 条件只能写「弱冰的敌人有几只」「是不是首领战」,不能按怪物名字写;
- 目标只能写「敌人」,实际打的是游戏光标默认指着的那只;
- 「最强」只看第一只活着的敌人(`battle.ts` 的 `resistanceOf`)。

10-27 的例子：火力船机房的喧嚣鬼对火、雷免疫，还吸收冰，可是规则对它和别的怪一视同仁。

## 1. 规则语言(`src/engine/skills/gambit.ts`)

- **新条件 `enemy.name.<怪名>`**:有几只活着的敌人叫这个名字(和桥插件的 `name` 完全相等)。
  - 加进 `VOCABULARY` 和 `OPEN_ENDED`,`Situation.value` 照现有的 `enemy.weak.` 写。
- **新目标**(写在规则的 `target` 里):

  | 写法 | 意思 | 找不到时 |
  | --- | --- | --- |
  | `敌人:<怪名>` | 第一只活着的、叫这个名字的敌人 | 这条规则不成立，换下一条 |
  | `敌人:hp最低` | HP 百分比最低的活着的敌人(一样低就取 HP 少的) | 同上 |
  | `敌人:弱<属性>` | 第一只活着的、弱这个属性的敌人(按 `situation.elements`) | 同上 |

  - `Action` 加 `enemy: number | null`:目标在**活着的敌人**里的下标(顺序照 `situation.enemies` 过滤掉 HP≤0 的)。别的目标都是 `null`。
  - 原来的「敌人」和空目标不变，还是交给游戏的默认光标(`enemy: null`)。
- **`check()`**:认这三种新目标;怪名不能空;`弱X` 的属性要认识(照现有的属性检查)。
- **说明文字**:规则写法的说明(模型看到的 `SYSTEM_PROMPT` 和 `TACTICIAN_PROMPT` 里列词表和目标的地方，或者生成它们的函数)补上新条件和新目标，各给一个例子。只加不改。

## 2. 执行(`src/engine/skills/battle.ts`)

- **瞄准**:`aim()` 里 `action.enemy !== null` 时，等目标光标打开，并且 state 是 `Enemys`。
  - 用 `steer` 把 `target.cursor` 移到 `action.enemy`。`castsFrom` 已经把 `target.cursor` 当成活着的敌人里的下标。
  - state 是 `EnemyAll`(全体法术)就不动。
  - 对不准就照常确认，结果里注明「没对准 X」。
  - 不要改瞄准同伴的那段。
- **「最强」挑法术**:`resistanceOf(situation)` 改成按 `action.enemy` 那只怪的抗性;`action.enemy` 为 `null` 时照旧用第一只。
- 出招记录(`used`)里写上打的是谁，比如「黑魔法:火炎→喧嚣鬼」。

## 3. 战术官看得到遇敌表(`src/engine/facts.ts`、`src/engine/game.ts`、`src/engine/prompt.ts`)

- 叫战术官时，如果触发的地图就是当前地图，多查一次 `encounters`(老桥插件会报未知 op,忽略)。
- 事实单加一节「这里的遇敌表」:
  - 用 `src/engine/encounters.ts` 的 `formationLines`;
  - 每只怪一行特性，用 `MonsterCache` 的资料(弱、吸收、无效、HP)。拿不到资料时只写名字。
- **`TACTICIAN_PROMPT` 补一段**(只加不改):
  - 遇敌表里各种怪的弱点、吸收不一样时，用 `enemy.name.X` 和 `敌人:X` 分开写;
  - 绝不用某只怪吸收的属性打它;
  - 某只怪什么法术都打不动，就写物理攻击或道具，目标写 `敌人:X`。

## 测试

- **gambit**:
  - `enemy.name.X` 的计数(死了的不算);
  - 三种新目标各自选中的下标;
  - 找不到时换下一条;
  - `check` 通过和报错;
  - 原来的「敌人」仍是 `enemy: null`。
- **battle**(fake-pilot):
  - 光标从 0 移到 2;
  - `EnemyAll` 不动;
  - 「最强」按目标那只的抗性挑法术(目标吸收冰，就不挑冰);
  - `used` 里有目标名。
- **facts**:有遇敌表时出现那一节;没有时不出现。
- 现有测试全过，Python 对照数据(`test/fixtures/`)不许改。

## 回报

不超过 40 行：改了哪些文件、`npm run build` 和 `npm run check` 的结尾、拿不准的地方。不要重启网页，不要开游戏(Claude 来实测)。

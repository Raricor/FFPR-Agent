# 任务 29:去掉写死的旧仓库路径

开始前先读 `dsh/CLAUDE.md`。

范围:
- 只改下面列出的文件，都在 `dsh/` 里;
- 不改 `package.json`、`package-lock.json`(Claude 已经改过 `engines.dsh`)、`dsh/tasks/`、`../agent/`;
- 不碰 git,不运行 `scripts/web.sh`、`scripts/ask.mjs`,也不运行 `scripts/fixtures/*.py`(会重写对照数据)。

## 起因

仓库换了位置，开发机上的 checkout 不再在原来的路径。有几处把旧 checkout 的绝对路径写死了，换位置后就坏:

- `src/plugin/config.ts:51` 的 `DEFAULT_LAPTOP_ENV`。AI 玩家启动时按它读 `laptop.env`,文件不在，FF5 玩家就加载失败。
- `scripts/ask.mjs:25` 的 `CWD`。`session/create` 用它当会话的工作目录，现在这个目录不存在。
- `scripts/fixtures/` 里 7 个导出脚本的 `REPO`:`kb.py`、`tactics.py`、`atlas.py`、`steam.py`、`events.py`、`keylog.py`、`ludo.py`。

另外，仓库是公开的，不能往里写本机的绝对路径。所以一律改成从文件自己的位置推算，不要换成新的绝对路径。

## 要改的

1. **`src/plugin/config.ts`**:`laptop.env` 的默认路径从仓库根推算。
   - `src/engine/laptop.ts:22` 已经有 `CONFIG = join(REPO, "agent", "laptop.env")`,两处要指向同一个值，不要再写一份;
   - 如果直接 import `laptop.ts` 会带进不该在配置模块里出现的东西，就把这个常量挪到 `src/engine/paths.ts`,两边都从那里取。
2. **`test/config.test.ts:14`**:改成和上面同一个常量比较，测试里不出现绝对路径。
3. **`scripts/ask.mjs`**:`CWD` 用脚本自己的位置推算出仓库根(`scripts/` 的上两级),不写死。顶部注释里有提到路径的，一起改对。
4. **`scripts/fixtures/` 的 7 个脚本**:
   - `REPO` 改成 `Path(__file__).resolve().parents[3]`;
   - 开头 docstring 里的运行说明改成在 `dsh/` 下运行:`PYTHONDONTWRITEBYTECODE=1 ../.venv/bin/python scripts/fixtures/<模块>.py`;
   - 「Run from dsh-port-0N」这类过时的说法，改成「Run from dsh/」。
   - 其他 fixtures 脚本里 `/home/dev/...` 是测试用的假值，不用动。
5. **`scripts/web.sh`**:写日志之前先 `mkdir -p` 日志所在的目录。新机器上 `~/.dsh/logs` 还不存在时，现在会直接失败。

## 检查

- 改完后在 `dsh/` 下运行 `grep -rn '/root/' src test scripts`,结果里不能再有旧路径(fixtures 里的 `/home/dev/` 假值除外)。
- Python 脚本的检查(在 `dsh/` 下运行):`../.venv/bin/ruff check --no-cache scripts/fixtures` 和 `../.venv/bin/ruff format --check --no-cache scripts/fixtures`,都要通过。
- `npm run check` 全过，测试数不能少于 448。

## 回报

不超过 15 行：改了哪些文件、上面的 grep 结果、ruff 和 `npm run check` 的结尾输出。

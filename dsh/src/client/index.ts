/**
 * FFPR achievement and strategy panels for the right sidebar (tasks 14–20). The server computes
 * every word and every title; this bundle only polls /api/ffpr/achievements and
 * /api/ffpr/tactics and lays the views out for a narrow column. It has no imports: React and the
 * client services come from the loader.
 */

const TAB_ID = "@local/ffpr-dsh";
const TAB_KIND = "ffpr-achievements";
const TACTICS_TAB_ID = "@local/ffpr-dsh/tactics";
const TACTICS_KIND = "ffpr-tactics";
const OVERVIEW_PANEL_ID = "ffpr";
const OPENED_PREFIX = "ffpr-dsh.achievements.opened.";
const TACTICS_OPENED_PREFIX = "ffpr-dsh.tactics.opened.";
const ONLY_MISSING_KEY = "ffpr-dsh.achievements.onlyMissing";
const PANEL_TAB_KEY = "ffpr-dsh.achievements.tab";
const SIDEBAR_GAME_KEY = "ffpr-dsh.game";
const OVERVIEW_GAME_KEY = "ffpr-dsh.overview.game";
const OVERVIEW_KINDS_KEY = "ffpr-dsh.overview.kinds";
const REFRESH_MS = 30_000;
const OVERVIEW_REFRESH_MS = 3000;
const GAME_KEYS: readonly string[] = ["ff1", "ff2", "ff3", "ff4", "ff5", "ff6"];
type PanelTab = "achievements" | "bestiary" | "treasure";
const PANEL_TABS: readonly { readonly key: PanelTab; readonly label: string }[] = [
  { key: "achievements", label: "成就" },
  { key: "bestiary", label: "图鉴" },
  { key: "treasure", label: "宝箱" },
];

interface AchievementViewRow {
  readonly name: string;
  readonly description: string;
  readonly save: string;
  readonly done: boolean;
  readonly steam: boolean | null;
}

interface AchievementViewPlace {
  readonly name: string;
  readonly chests: string;
  readonly hidden: string;
  readonly lost: string;
  readonly done: boolean;
}

interface AchievementBestiaryMonster {
  readonly label: string;
  readonly registered: boolean;
  readonly status: string | null;
  readonly details: readonly string[];
}

interface AchievementBestiaryPlace {
  readonly name: string;
  readonly count: string;
  readonly done: boolean;
  readonly monsters: readonly AchievementBestiaryMonster[];
}

type BestiaryView =
  | { readonly message: string }
  | {
      readonly header: string;
      readonly areas: readonly AchievementBestiaryPlace[];
    };

type TreasureView =
  | { readonly message: string }
  | {
      readonly header: string;
      /** FF1/FF2 have no hidden items, so their hidden column is absent. */
      readonly hidden: boolean;
      readonly warning?: string;
      readonly places: readonly AchievementViewPlace[];
    };

interface AchievementView {
  readonly title: string;
  readonly summary: readonly string[];
  readonly rows: readonly AchievementViewRow[];
  readonly notes: readonly string[];
  readonly bestiary: BestiaryView;
  readonly treasure: TreasureView;
}

interface RuleTableView {
  readonly title: string;
  readonly inUse: boolean;
  readonly members: readonly { readonly name: string; readonly rules: readonly string[] }[];
}

interface EnemyView {
  readonly label: string;
  readonly facts: string;
  readonly plan: readonly string[];
}

interface MapTacticsView {
  readonly mapId: number;
  readonly name: string;
  readonly summary: string;
  readonly tables: readonly RuleTableView[];
  readonly results: readonly string[];
  readonly notes: readonly string[];
  readonly enemies: readonly EnemyView[];
  readonly enemyNote: string;
  readonly formations: readonly string[];
}

interface TacticsPanelView {
  readonly title: string;
  readonly status: string;
  readonly current: MapTacticsView | null;
  readonly message: string | null;
  readonly boss: {
    readonly title: string;
    readonly table: RuleTableView;
    readonly result: string;
  } | null;
  readonly others: readonly MapTacticsView[];
}

type PanelReply =
  | { readonly ok: true; readonly view: AchievementView; readonly at: string }
  | { readonly ok: false; readonly error: string; readonly at: string };

const React = require("react");

const TABLE_STYLE: Record<string, string | number> = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
  fontSize: 12,
};
const CELL_STYLE: Record<string, string | number> = {
  padding: "3px 4px",
  borderBottom: "1px solid rgba(128, 128, 128, 0.3)",
  verticalAlign: "top",
  textAlign: "left",
  overflowWrap: "anywhere",
};
const HEADER_CELL_STYLE: Record<string, string | number> = {
  ...CELL_STYLE,
  fontWeight: 600,
  color: "inherit",
};

function h(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown {
  return React.createElement(type, props, ...children);
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or a full store: the panel still works, only the memory is lost.
  }
}

function storedGame(key: string, fallback: string): string {
  const saved = readStorage(key);
  return saved !== null && GAME_KEYS.includes(saved) ? saved : fallback;
}

/** The selected game shared by one panel, remembered across reloads (task 24). */
function useGame(key: string): [string, (game: string) => void] {
  const [game, setGame] = React.useState<string>(() => storedGame(key, "ff5"));
  return [
    game,
    (next: string) => {
      setGame(next);
      writeStorage(key, next);
    },
  ];
}

/** Small FF1 … FF6 button row above the sidebar pages. */
function gameSelector(game: string, select: (game: string) => void): unknown {
  return h(
    "div",
    { style: { display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" } },
    ...GAME_KEYS.map((key) =>
      h(
        "button",
        {
          key,
          type: "button",
          onClick: () => {
            select(key);
          },
          style: {
            fontSize: 11,
            padding: "1px 7px",
            font: "inherit",
            color: "inherit",
            cursor: "pointer",
            border: "1px solid rgba(128, 128, 128, 0.4)",
            borderRadius: 4,
            background: game === key ? "rgba(128, 128, 128, 0.18)" : "transparent",
            fontWeight: game === key ? 600 : 400,
          },
        },
        key.toUpperCase(),
      ),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isView(value: unknown): value is AchievementView {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    Array.isArray(value.summary) &&
    Array.isArray(value.rows) &&
    Array.isArray(value.notes) &&
    isRecord(value.bestiary) &&
    isRecord(value.treasure)
  );
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function fetchPanel(signal: AbortSignal, game: string): Promise<PanelReply> {
  // Relative on purpose: the web app may be mounted below the origin's root.
  const response = await fetch(`api/ffpr/achievements?game=${encodeURIComponent(game)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  // 401/403 mean the page's login expired or the request left this origin: the body is no view.
  if (!response.ok) throw new Error(`读不了成就进度(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("读不懂成就进度");
  const at = typeof body.at === "string" ? body.at : new Date().toISOString();
  if (body.ok === true && isView(body.view)) return { ok: true, view: body.view, at };
  const error = typeof body.error === "string" ? body.error : "读不了成就进度";
  return { ok: false, error, at };
}

function isTacticsView(value: unknown): value is TacticsPanelView {
  return (
    isRecord(value) &&
    typeof value.status === "string" &&
    (value.current === null || isRecord(value.current)) &&
    Array.isArray(value.others) &&
    (value.boss === null || isRecord(value.boss))
  );
}

async function fetchTactics(signal: AbortSignal, game: string): Promise<TacticsPanelView> {
  const response = await fetch(`api/ffpr/tactics?game=${encodeURIComponent(game)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了策略(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (!isRecord(body) || body.ok !== true || !isTacticsView(body.view)) {
    throw new Error("读不懂策略");
  }
  return body.view;
}

interface PollResult<T> {
  readonly value: T | null;
  readonly error: string | null;
  readonly at: string | null;
}

async function loadAchievements(
  signal: AbortSignal,
  game: string,
): Promise<PollResult<AchievementView>> {
  const reply = await fetchPanel(signal, game);
  return reply.ok
    ? { value: reply.view, error: null, at: reply.at }
    : { value: null, error: reply.error, at: reply.at };
}

async function loadTactics(
  signal: AbortSignal,
  game: string,
): Promise<PollResult<TacticsPanelView>> {
  return { value: await fetchTactics(signal, game), error: null, at: null };
}

/** One 30-second poll, shared by both sidebar tabs; errors keep the last good content. */
function usePolling<T>(
  load: (signal: AbortSignal, game: string) => Promise<PollResult<T>>,
  intervalMs: number,
  game: string,
): { data: T | null; error: string | null; at: string; reload: () => void } {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [at, setAt] = React.useState<string>("");
  const [tick, setTick] = React.useState<number>(0);
  React.useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: number | null = null;
    const fetchNow = async (): Promise<void> => {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await load(controller.signal, game);
        if (stopped) return;
        if (next.value !== null) setData(next.value);
        setError(next.error);
        setAt(next.at ?? new Date().toISOString());
      } catch (caught) {
        if (stopped || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    const reload = (): void => {
      void fetchNow();
    };
    reload();
    timer = window.setInterval(reload, intervalMs);
    document.addEventListener("visibilitychange", reload);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [tick, game]);
  return {
    data,
    error,
    at,
    reload: () => {
      setTick((value) => value + 1);
    },
  };
}

function th(text: string): unknown {
  return h("th", { style: HEADER_CELL_STYLE }, text);
}

function table(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  rowStyles?: readonly (Record<string, string | number> | undefined)[],
): unknown {
  const body = rows.map((cells, rowIndex) =>
    h(
      "tr",
      { key: rowIndex, style: rowStyles?.[rowIndex] },
      ...cells.map((cell, index) => h("td", { key: index, style: CELL_STYLE }, cell)),
    ),
  );
  return h(
    "table",
    { style: TABLE_STYLE },
    h("thead", null, h("tr", null, ...headers.map((header) => th(header)))),
    h("tbody", null, ...body),
  );
}

function statusColor(status: string | null): string {
  if (status === "不可再获得") return "#d64545";
  return status === null ? "inherit" : "#d9822b";
}

function bestiaryCount(count: string): unknown {
  const marker = " · 已错过";
  const at = count.indexOf(marker);
  if (at < 0) return count;
  return h(
    "span",
    null,
    count.slice(0, at),
    h("span", { style: { color: "#d64545" } }, count.slice(at)),
  );
}

function bestiaryBlock(bestiary: BestiaryView, onlyMissing: boolean): unknown {
  if ("message" in bestiary) {
    return h("div", { style: { marginTop: 12 } }, bestiary.message);
  }
  const parts: unknown[] = [
    h("div", { style: { marginTop: 12, fontWeight: 600 } }, bestiary.header),
  ];
  for (const area of bestiary.areas) {
    if (onlyMissing && area.done) continue;
    const monsters = area.monsters.filter((monster) => !onlyMissing || !monster.registered);
    const rows = monsters.map((monster) => {
      const summary: unknown[] = [monster.label];
      if (monster.registered) summary.push(" ✓");
      if (monster.status !== null) {
        summary.push(
          h(
            "span",
            {
              style: {
                marginLeft: 6,
                fontSize: 11,
                color: statusColor(monster.status),
              },
            },
            monster.status,
          ),
        );
      }
      return h(
        "details",
        {
          key: monster.label,
          style: {
            padding: "2px 0",
            opacity: monster.registered ? 0.65 : 1,
          },
        },
        h("summary", { style: { cursor: "pointer" } }, ...summary),
        h(
          "div",
          { style: { marginTop: 2, paddingLeft: 14, fontSize: 12, opacity: 0.8 } },
          ...monster.details.map((line) => h("div", { key: line }, line)),
        ),
      );
    });
    parts.push(
      h(
        "details",
        {
          key: area.name,
          style: {
            padding: "3px 0",
            borderBottom: "1px solid rgba(128, 128, 128, 0.3)",
          },
        },
        h(
          "summary",
          // A flex summary loses its disclosure marker in Chrome; the count floats instead.
          { style: { cursor: "pointer" } },
          area.name,
          h("span", { style: { float: "right" } }, bestiaryCount(area.count)),
        ),
        h("div", { style: { marginTop: 4 } }, ...rows),
      ),
    );
  }
  return h("div", null, ...parts);
}

function lostColor(lost: string): string {
  if (lost.startsWith("已错过")) return "#d64545";
  if (lost.startsWith("限时")) return "#d9822b";
  return "inherit";
}

function treasureBlock(treasure: TreasureView, onlyMissing: boolean): unknown {
  if ("message" in treasure) {
    return h("div", { style: { marginTop: 12 } }, treasure.message);
  }
  const parts: unknown[] = [
    h("div", { style: { marginTop: 12, fontWeight: 600 } }, treasure.header),
  ];
  if (treasure.warning !== undefined) {
    parts.push(h("div", { style: { color: "#d64545", marginTop: 4 } }, treasure.warning));
  }
  const places = onlyMissing ? treasure.places.filter((place) => !place.done) : treasure.places;
  if (places.length > 0) {
    const lost = (place: AchievementViewPlace): unknown =>
      h("span", { style: { color: lostColor(place.lost) } }, place.lost);
    const rows = treasure.hidden
      ? places.map((place) => [place.name, place.chests, place.hidden, lost(place)] as const)
      : places.map((place) => [place.name, place.chests, lost(place)] as const);
    const headers = treasure.hidden
      ? ["地点", "宝箱", "隐藏", "不可回收"]
      : ["地点", "宝箱", "不可回收"];
    parts.push(h("div", { style: { marginTop: 4 } }, table(headers, rows)));
  }
  return h("div", null, ...parts);
}

function rulesBlock(table: RuleTableView, expanded: boolean): unknown {
  const body = h(
    "div",
    { style: { marginTop: 2, paddingLeft: expanded ? 0 : 14 } },
    ...table.members.map((member) =>
      h(
        "div",
        { key: member.name, style: { marginTop: 4 } },
        h("div", { style: { fontWeight: 600, fontSize: 12 } }, member.name),
        h(
          "ol",
          { style: { margin: "2px 0 0 18px", padding: 0, fontSize: 12 } },
          ...member.rules.map((rule, index) => h("li", { key: index }, rule)),
        ),
      ),
    ),
  );
  if (expanded) {
    return h("div", null, h("div", { style: { fontWeight: 600 } }, table.title), body);
  }
  return h(
    "details",
    { style: { marginTop: 4 } },
    h("summary", { style: { cursor: "pointer" } }, table.title),
    body,
  );
}

function resultColor(result: string): string {
  if (result.includes("· 全灭")) return "#d64545";
  if (result.includes("· 吃力")) return "#d9822b";
  return "inherit";
}

function enemyBlock(enemies: readonly EnemyView[], note: string): unknown {
  const parts: unknown[] = [h("div", { style: { marginTop: 8, fontWeight: 600 } }, "敌人")];
  if (note !== "") {
    parts.push(h("div", { style: { fontSize: 11, opacity: 0.7 } }, note));
  }
  for (const enemy of enemies) {
    const summary: unknown[] = [enemy.label];
    if (enemy.facts !== "") {
      summary.push(
        h("span", { style: { marginLeft: 6, fontSize: 11, opacity: 0.7 } }, enemy.facts),
      );
    }
    parts.push(
      h(
        "details",
        { key: enemy.label, style: { marginTop: 2 } },
        h("summary", { style: { cursor: "pointer" } }, ...summary),
        h(
          "div",
          { style: { marginTop: 2, paddingLeft: 14, fontSize: 12 } },
          ...enemy.plan.map((line) =>
            h(
              "div",
              {
                key: line,
                style: {
                  color:
                    line.includes("它吸收") || line.includes("没有能打它") ? "#d64545" : "inherit",
                },
              },
              line,
            ),
          ),
        ),
      ),
    );
  }
  return h("div", null, ...parts);
}

function mapTacticsBlock(view: MapTacticsView): unknown {
  const parts: unknown[] = [h("div", { style: { fontWeight: 600 } }, view.name)];
  if (view.summary !== "") {
    parts.push(h("div", { style: { opacity: 0.8 } }, view.summary));
  }
  for (const table of view.tables) {
    parts.push(rulesBlock(table, table.inUse));
  }
  if (view.formations.length > 0) {
    parts.push(h("div", { style: { marginTop: 8, fontWeight: 600 } }, "这里的遇敌表"));
    parts.push(
      h(
        "div",
        { style: { fontSize: 12 } },
        ...view.formations.map((line) => h("div", { key: line }, line)),
      ),
    );
  }
  if (view.enemies.length > 0) {
    parts.push(enemyBlock(view.enemies, view.enemyNote));
  }
  if (view.results.length > 0) {
    parts.push(h("div", { style: { marginTop: 8, fontWeight: 600 } }, "最近的战斗"));
    parts.push(
      h(
        "div",
        { style: { fontSize: 12 } },
        ...view.results.map((result) =>
          h("div", { key: result, style: { color: resultColor(result) } }, result),
        ),
      ),
    );
  }
  if (view.notes.length > 0) {
    parts.push(
      h(
        "div",
        { style: { marginTop: 6, opacity: 0.8 } },
        ...view.notes.map((note) => h("div", { key: note }, note)),
      ),
    );
  }
  return h("div", { style: { marginTop: 12 } }, ...parts);
}

function strategyBlock(view: TacticsPanelView): unknown {
  const parts: unknown[] = [];
  if (view.current !== null) parts.push(mapTacticsBlock(view.current));
  if (view.boss !== null) {
    parts.push(
      h(
        "div",
        { style: { marginTop: 12 } },
        h("div", { style: { fontWeight: 600 } }, view.boss.title),
        rulesBlock(view.boss.table, true),
        h("div", { style: { marginTop: 4, fontSize: 12 } }, view.boss.result),
      ),
    );
  }
  if (view.others.length > 0) {
    parts.push(h("div", { style: { marginTop: 12, fontWeight: 600 } }, "其他地图的策略"));
    for (const other of view.others) {
      parts.push(
        h(
          "details",
          { key: other.mapId, style: { marginTop: 4 } },
          h(
            "summary",
            { style: { cursor: "pointer" } },
            other.name,
            h("span", { style: { float: "right", opacity: 0.75 } }, other.summary),
          ),
          mapTacticsBlock(other),
        ),
      );
    }
  }
  return h("div", null, ...parts);
}

function panelHeader(title: string, reload: () => void): unknown {
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
    h("div", { style: { fontWeight: 600, fontSize: 13, flex: 1 } }, title),
    h(
      "button",
      {
        type: "button",
        onClick: reload,
        style: { fontSize: 12, padding: "2px 8px" },
      },
      "刷新",
    ),
  );
}

const PANEL_STYLE: Record<string, string | number> = {
  height: "100%",
  overflowY: "auto",
  boxSizing: "border-box",
  padding: "8px 10px",
  fontSize: 13,
  lineHeight: 1.45,
};

function Panel(): unknown {
  const [game, setGame] = useGame(SIDEBAR_GAME_KEY);
  const { data: view, error, at, reload } = usePolling(loadAchievements, REFRESH_MS, game);
  const [onlyMissing, setOnlyMissing] = React.useState<boolean>(
    () => readStorage(ONLY_MISSING_KEY) === "1",
  );
  const [tab, setTab] = React.useState<PanelTab>(() => {
    const saved = readStorage(PANEL_TAB_KEY);
    return saved === "bestiary" || saved === "treasure" ? saved : "achievements";
  });

  const rows = view === null ? [] : onlyMissing ? view.rows.filter((row) => !row.done) : view.rows;
  const children: unknown[] = [panelHeader(view?.title ?? "FFPR 成就", reload)];
  children.push(gameSelector(game, setGame));
  if (view !== null) {
    for (const line of view.summary) {
      children.push(h("div", { style: { marginTop: 2 } }, line));
    }
  }
  children.push(h("div", { style: { opacity: 0.65, marginTop: 2 } }, `更新于 ${clock(at)}`));
  if (error !== null) {
    children.push(h("div", { style: { color: "#d9822b", marginTop: 4 } }, error));
  }
  children.push(
    h(
      "div",
      { style: { display: "flex", gap: 4, marginTop: 8 } },
      ...PANEL_TABS.map((item) =>
        h(
          "button",
          {
            key: item.key,
            type: "button",
            onClick: () => {
              setTab(item.key);
              writeStorage(PANEL_TAB_KEY, item.key);
            },
            style: {
              fontSize: 12,
              padding: "2px 10px",
              font: "inherit",
              color: "inherit",
              cursor: "pointer",
              border: "1px solid rgba(128, 128, 128, 0.4)",
              borderRadius: 4,
              background: tab === item.key ? "rgba(128, 128, 128, 0.18)" : "transparent",
              fontWeight: tab === item.key ? 600 : 400,
            },
          },
          item.label,
        ),
      ),
    ),
  );
  children.push(
    h(
      "label",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 4,
          margin: "8px 0 4px",
          fontSize: 12,
        },
      },
      h("input", {
        type: "checkbox",
        checked: onlyMissing,
        onChange: (event: { target: { checked: boolean } }) => {
          setOnlyMissing(event.target.checked);
          writeStorage(ONLY_MISSING_KEY, event.target.checked ? "1" : "0");
        },
      }),
      "只看未完成",
    ),
  );
  if (view !== null) {
    if (tab === "achievements") {
      children.push(
        table(
          ["成就", "本档", "Steam"],
          rows.map((row) => [
            h("span", { title: row.description }, row.name),
            row.save,
            row.steam === true ? "✓" : "—",
          ]),
          rows.map((row) => (row.done ? { opacity: 0.65 } : undefined)),
        ),
      );
      if (view.notes.length > 0) {
        children.push(
          h(
            "div",
            { style: { marginTop: 8, opacity: 0.8 } },
            ...view.notes.map((note) => h("div", { key: note }, note)),
          ),
        );
      }
    } else if (tab === "bestiary") {
      children.push(bestiaryBlock(view.bestiary, onlyMissing));
    } else {
      children.push(treasureBlock(view.treasure, onlyMissing));
    }
  }
  return h("div", { style: PANEL_STYLE }, ...children);
}

function TacticsPanel(): unknown {
  const [game, setGame] = useGame(SIDEBAR_GAME_KEY);
  const { data: view, error, at, reload } = usePolling(loadTactics, REFRESH_MS, game);
  const children: unknown[] = [panelHeader(view?.title ?? "FFPR 策略", reload)];
  children.push(gameSelector(game, setGame));
  if (error !== null) {
    children.push(h("div", { style: { color: "#d9822b", marginTop: 4 } }, error));
  }
  if (view !== null) {
    children.push(h("div", { style: { marginTop: 4 } }, view.status));
  } else if (error === null) {
    children.push(h("div", { style: { marginTop: 4, opacity: 0.7 } }, "正在读取策略…"));
  }
  if (view?.message !== null && view?.message !== undefined) {
    children.push(h("div", { style: { marginTop: 4, opacity: 0.8 } }, view.message));
  }
  children.push(h("div", { style: { opacity: 0.65, marginTop: 2 } }, `更新于 ${clock(at)}`));
  if (view !== null) children.push(strategyBlock(view));
  return h("div", { style: PANEL_STYLE }, ...children);
}

type ActivityKind = "tool" | "event" | "link" | "error";

interface ActivityEntry {
  readonly at: string;
  readonly game: string;
  readonly kind: ActivityKind;
  readonly text: string;
}

interface OverviewCard {
  readonly game: string;
  readonly title: string;
  readonly loaded: boolean;
  readonly link: "up" | "down";
  readonly linkText: string | null;
  readonly status: string;
  readonly place: string;
  readonly party: readonly { readonly name: string; readonly hp: number; readonly maxHp: number }[];
  readonly busy: { readonly name: string; readonly at: string } | null;
  readonly last: { readonly at: string; readonly kind: ActivityKind; readonly text: string } | null;
  readonly saveSlot: number;
}

interface OverviewReply {
  readonly at: string;
  readonly games: readonly OverviewCard[];
  readonly log: readonly ActivityEntry[];
}

const KIND_FILTERS: readonly { readonly key: ActivityKind; readonly label: string }[] = [
  { key: "tool", label: "AI 操作" },
  { key: "event", label: "事件" },
  { key: "link", label: "连接" },
  { key: "error", label: "报错" },
];

function isActivityEntry(value: unknown): value is ActivityEntry {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    typeof value.game === "string" &&
    typeof value.text === "string" &&
    (value.kind === "tool" ||
      value.kind === "event" ||
      value.kind === "link" ||
      value.kind === "error")
  );
}

function isOverviewCard(value: unknown): value is OverviewCard {
  return (
    isRecord(value) &&
    typeof value.game === "string" &&
    typeof value.title === "string" &&
    typeof value.loaded === "boolean" &&
    (value.link === "up" || value.link === "down") &&
    typeof value.status === "string" &&
    typeof value.place === "string" &&
    Array.isArray(value.party) &&
    (value.busy === null || isRecord(value.busy)) &&
    (value.last === null || isRecord(value.last))
  );
}

async function fetchOverview(signal: AbortSignal, since: string | null): Promise<OverviewReply> {
  const params = new URLSearchParams({ limit: "500" });
  if (since !== null) params.set("since", since);
  const response = await fetch(`api/ffpr/overview?${params.toString()}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了总控数据(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    body.ok !== true ||
    typeof body.at !== "string" ||
    !Array.isArray(body.games) ||
    !body.games.every(isOverviewCard) ||
    !Array.isArray(body.log) ||
    !body.log.every(isActivityEntry)
  ) {
    throw new Error("读不懂总控数据");
  }
  return {
    at: body.at,
    games: body.games.filter(isOverviewCard),
    log: body.log.filter(isActivityEntry),
  };
}

/** New entries first, de-duplicated across the one-millisecond `since` overlap. */
function mergeOverviewLog(
  current: readonly ActivityEntry[],
  incoming: readonly ActivityEntry[],
): ActivityEntry[] {
  const seen = new Set<string>();
  const merged: ActivityEntry[] = [];
  for (const entry of [...incoming, ...current]) {
    const key = `${entry.at}|${entry.game}|${entry.kind}|${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  merged.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return merged.slice(0, 1000);
}

function storedOverviewGame(): string {
  const saved = readStorage(OVERVIEW_GAME_KEY);
  return saved === "all" || (saved !== null && GAME_KEYS.includes(saved)) ? saved : "all";
}

function storedKinds(): ReadonlySet<ActivityKind> {
  const fallback: ActivityKind[] = KIND_FILTERS.map((item) => item.key);
  const raw = readStorage(OVERVIEW_KINDS_KEY);
  if (raw === null) return new Set(fallback);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(fallback);
    const valid = parsed.filter(
      (value): value is ActivityKind =>
        value === "tool" || value === "event" || value === "link" || value === "error",
    );
    return new Set(valid);
  } catch {
    return new Set(fallback);
  }
}

function ago(iso: string): string {
  const elapsed = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "刚刚";
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function busySeconds(iso: string): number {
  const elapsed = Date.now() - Date.parse(iso);
  return Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 1000)) : 0;
}

function kindLabel(kind: ActivityKind): string {
  return KIND_FILTERS.find((item) => item.key === kind)?.label ?? kind;
}

function kindColor(kind: ActivityKind): string {
  if (kind === "error") return "var(--dsw-alias-state-error-primary)";
  if (kind === "event") return "var(--dsw-alias-state-business-primary)";
  if (kind === "link") return "var(--dsw-alias-label-tertiary)";
  return "var(--dsw-alias-label-secondary)";
}

function dotColor(card: OverviewCard): string {
  if (!card.loaded || card.link === "down") return "var(--dsw-alias-label-tertiary)";
  if (card.last !== null && card.last.kind === "error") {
    return "var(--dsw-alias-state-error-primary)";
  }
  if (card.status === "战斗中") return "var(--dsw-alias-state-warn-primary)";
  return "var(--dsw-alias-state-success-primary)";
}

function useOverview(paused: boolean): {
  readonly games: readonly OverviewCard[];
  readonly entries: readonly ActivityEntry[];
  readonly at: string;
  readonly error: string | null;
} {
  const [games, setGames] = React.useState<readonly OverviewCard[]>([]);
  const [entries, setEntries] = React.useState<readonly ActivityEntry[]>([]);
  const [at, setAt] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    let stopped = false;
    let lastAt: string | null = null;
    let timer: number | null = null;
    const fetchNow = async (): Promise<void> => {
      if (document.visibilityState === "hidden") return;
      try {
        // One millisecond of overlap keeps same-millisecond entries; mergeOverviewLog de-dupes.
        const since =
          lastAt === null ? null : new Date(Math.max(0, Date.parse(lastAt) - 1)).toISOString();
        const reply = await fetchOverview(controller.signal, since);
        if (stopped) return;
        setGames(reply.games);
        if (reply.log.length > 0) {
          setEntries((current) => mergeOverviewLog(current, reply.log));
          const newest = reply.log[0]?.at;
          if (newest !== undefined) lastAt = newest;
        }
        setAt(reply.at);
        setError(null);
      } catch (caught) {
        if (stopped || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    const reload = (): void => {
      void fetchNow();
    };
    reload();
    timer = window.setInterval(reload, OVERVIEW_REFRESH_MS);
    document.addEventListener("visibilitychange", reload);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [paused]);
  return { games, entries, at, error };
}

function filterChip(key: string, label: string, active: boolean, select: () => void): unknown {
  return h(
    "button",
    {
      key,
      type: "button",
      onClick: select,
      style: {
        fontSize: 11,
        padding: "1px 8px",
        font: "inherit",
        color: "inherit",
        cursor: "pointer",
        border: "1px solid rgba(128, 128, 128, 0.4)",
        borderRadius: 4,
        background: active ? "rgba(128, 128, 128, 0.18)" : "transparent",
        fontWeight: active ? 600 : 400,
      },
    },
    label,
  );
}

function hpBar(member: { readonly hp: number; readonly maxHp: number }): unknown {
  const percent =
    member.maxHp > 0 ? Math.max(0, Math.min(100, (member.hp / member.maxHp) * 100)) : 0;
  const color =
    member.maxHp > 0 && member.hp * 4 <= member.maxHp
      ? "var(--dsw-alias-state-error-primary)"
      : "var(--dsw-alias-state-success-primary)";
  return h(
    "div",
    {
      style: {
        flex: 1,
        height: 3,
        borderRadius: 2,
        background: "rgba(128, 128, 128, 0.25)",
        overflow: "hidden",
      },
    },
    h("div", { style: { width: `${percent}%`, height: "100%", background: color } }),
  );
}

function OverviewCardView(card: OverviewCard, selected: boolean, select: () => void): unknown {
  const children: unknown[] = [
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, fontWeight: 600 } },
      h("span", {
        style: {
          width: 8,
          height: 8,
          borderRadius: "50%",
          flex: "none",
          background: dotColor(card),
        },
      }),
      card.title,
    ),
  ];
  if (!card.loaded) {
    children.push(h("div", { style: { fontSize: 12, opacity: 0.8 } }, "这一作的玩家没有加载"));
  } else {
    const where = [card.status, card.place].filter((part) => part !== "").join(" · ");
    const statusLine = where !== "" ? where : (card.linkText ?? "状态未知");
    children.push(
      h(
        "div",
        {
          style: {
            fontSize: 12,
            color:
              where === "" && card.linkText !== null
                ? "var(--dsw-alias-state-warn-primary)"
                : "var(--dsw-alias-label-secondary)",
          },
        },
        statusLine,
      ),
    );
    for (const [index, member] of card.party.entries()) {
      children.push(
        h(
          "div",
          {
            key: `${member.name}-${index}`,
            style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 },
          },
          h(
            "span",
            {
              style: {
                width: 64,
                flex: "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            },
            member.name,
          ),
          h(
            "span",
            { style: { fontVariantNumeric: "tabular-nums", flex: "none" } },
            `HP ${member.hp}/${member.maxHp}`,
          ),
          hpBar(member),
        ),
      );
    }
    if (card.busy !== null) {
      children.push(
        h(
          "div",
          { style: { fontSize: 12 } },
          `正在 ${card.busy.name}(${busySeconds(card.busy.at)} 秒)`,
        ),
      );
    } else if (card.last !== null) {
      children.push(
        h(
          "div",
          { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } },
          `${card.last.text} · ${ago(card.last.at)}`,
        ),
      );
    }
    // When there is no fresh state the first line already carries the disconnect reason.
    if (card.linkText !== null && where !== "") {
      children.push(
        h(
          "div",
          { style: { fontSize: 11, color: "var(--dsw-alias-state-warn-primary)" } },
          card.linkText,
        ),
      );
    }
  }
  return h(
    "button",
    {
      key: card.game,
      type: "button",
      onClick: select,
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 5,
        alignItems: "stretch",
        textAlign: "left",
        font: "inherit",
        color: "inherit",
        cursor: "pointer",
        opacity: card.loaded ? 1 : 0.55,
        padding: "10px 12px",
        borderRadius: 8,
        border: selected
          ? "1px solid var(--dsw-alias-state-business-primary)"
          : "1px solid var(--dsw-alias-border-l2)",
        background: selected ? "var(--dsw-alias-bg-layer-2)" : "transparent",
      },
    },
    ...children,
  );
}

function OverviewPage(): unknown {
  const [paused, setPaused] = React.useState(false);
  const { games, entries, at, error } = useOverview(paused);
  const [gameFilter, setGameFilter] = React.useState<string>(storedOverviewGame);
  const [kinds, setKinds] = React.useState<ReadonlySet<ActivityKind>>(storedKinds);

  const selectGame = (game: string): void => {
    const next = gameFilter === game ? "all" : game;
    setGameFilter(next);
    writeStorage(OVERVIEW_GAME_KEY, next);
  };
  const toggleKind = (kind: ActivityKind): void => {
    const next = new Set(kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setKinds(next);
    writeStorage(OVERVIEW_KINDS_KEY, JSON.stringify([...next]));
  };

  const shown = entries
    .filter((entry) => (gameFilter === "all" || entry.game === gameFilter) && kinds.has(entry.kind))
    .slice(0, 300);

  return h(
    "div",
    {
      style: {
        boxSizing: "border-box",
        height: "100%",
        overflowY: "auto",
        padding: "0 clamp(24px, 4vw, 48px) 48px",
        color: "var(--dsw-alias-label-primary)",
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          paddingTop: 28,
        },
      },
      h("div", { style: { flex: 1, fontSize: 20, fontWeight: 500 } }, "六作总控"),
      h(
        "div",
        { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } },
        `更新于 ${clock(at)}`,
      ),
      h(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12 } },
        h("input", {
          type: "checkbox",
          checked: paused,
          onChange: (event: { target: { checked: boolean } }) => {
            setPaused(event.target.checked);
          },
        }),
        "暂停刷新",
      ),
    ),
    error !== null
      ? h("div", { style: { color: "var(--dsw-alias-state-warn-primary)", marginTop: 8 } }, error)
      : null,
    h(
      "div",
      {
        style: {
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 12,
          marginTop: 16,
        },
      },
      ...games.map((card) =>
        OverviewCardView(card, gameFilter === card.game, () => {
          selectGame(card.game);
        }),
      ),
    ),
    h(
      "div",
      { style: { marginTop: 24, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" } },
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, "作品"),
      filterChip("all", "全部", gameFilter === "all", () => {
        setGameFilter("all");
        writeStorage(OVERVIEW_GAME_KEY, "all");
      }),
      ...GAME_KEYS.map((key) =>
        filterChip(key, key.toUpperCase(), gameFilter === key, () => {
          selectGame(key);
        }),
      ),
    ),
    h(
      "div",
      { style: { marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" } },
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, "种类"),
      ...KIND_FILTERS.map((item) =>
        filterChip(item.key, item.label, kinds.has(item.key), () => {
          toggleKind(item.key);
        }),
      ),
    ),
    shown.length === 0
      ? h(
          "div",
          { style: { marginTop: 12, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } },
          "没有符合筛选的日志",
        )
      : h(
          "div",
          { style: { marginTop: 12 } },
          ...shown.map((entry, index) =>
            h(
              "div",
              {
                key: `${entry.at}|${entry.game}|${entry.kind}|${entry.text}|${index}`,
                style: {
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  padding: "2px 0",
                  fontSize: 12,
                  borderBottom: "1px solid var(--dsw-alias-border-l2)",
                },
              },
              h(
                "span",
                { style: { flex: "none", opacity: 0.7, fontVariantNumeric: "tabular-nums" } },
                clock(entry.at),
              ),
              h("span", { style: { flex: "none", opacity: 0.45 } }, "·"),
              h("span", { style: { flex: "none", opacity: 0.8 } }, entry.game.toUpperCase()),
              h("span", { style: { flex: "none", opacity: 0.45 } }, "·"),
              h(
                "span",
                { style: { flex: "none", color: kindColor(entry.kind), fontWeight: 600 } },
                kindLabel(entry.kind),
              ),
              h("span", { style: { flex: "none", opacity: 0.45 } }, "·"),
              h("span", { style: { overflowWrap: "anywhere" } }, entry.text),
            ),
          ),
        ),
  );
}

function OverviewIcon(props: { readonly size?: number }): unknown {
  const size = props.size ?? 16;
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    h("rect", { x: 2, y: 7, width: 20, height: 10, rx: 4 }),
    h("path", { d: "M7 10v4M5 12h4" }),
    h("circle", { cx: 16, cy: 11, r: 1 }),
    h("circle", { cx: 18, cy: 13, r: 1 }),
  );
}

function startAutoOpen(ctx: ClientContext, kind: string, prefix: string): void {
  const openedKey = (session: string): string => `${prefix}${session}`;
  const mounted = ctx.sidebarRight.mounted;
  const hasTab = (session: string): boolean =>
    ctx.sidebarRight.openTabs
      .getSnapshot()
      .some((tab) => tab.sessionId === session && tab.kind === kind);

  ctx.effect(() => {
    let stopped = false;
    let retry: number | null = null;
    const cancelRetry = (): void => {
      if (retry !== null) {
        window.clearTimeout(retry);
        retry = null;
      }
    };
    const attempt = (session: string, tries: number): void => {
      if (stopped) return;
      if (hasTab(session)) {
        writeStorage(openedKey(session), "1");
        return;
      }
      try {
        ctx.sidebarRight.openTab(kind);
        writeStorage(openedKey(session), "1");
      } catch {
        // The Session's layout may not be minted yet; retry briefly, then give up quietly.
        if (tries < 3) {
          retry = window.setTimeout(() => {
            retry = null;
            attempt(session, tries + 1);
          }, 200);
        }
      }
    };
    const check = (): void => {
      cancelRetry();
      const session = mounted.getSnapshot();
      if (session === undefined) return;
      if (readStorage(openedKey(session)) !== null) return;
      if (hasTab(session)) {
        writeStorage(openedKey(session), "1");
        return;
      }
      attempt(session, 0);
    };
    const unsubscribe = mounted.subscribe(check);
    check();
    return () => {
      stopped = true;
      unsubscribe();
      cancelRetry();
    };
  }, `ffpr: ${kind} auto-open`);
}

function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => "FFPR 成就",
        guide: [
          {
            id: "open",
            order: 70,
            title: () => "FFPR 成就",
            description: () => "当前存档的成就和宝箱进度",
          },
        ],
      }),
    "ffpr: achievements tab",
  );
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TACTICS_TAB_ID,
        kind: TACTICS_KIND,
        title: () => "FFPR 策略",
        guide: [
          {
            id: "open",
            order: 71,
            title: () => "FFPR 策略",
            description: () => "当前地图的战斗策略和敌人",
          },
        ],
      }),
    "ffpr: tactics tab",
  );
  ctx.slots.inject("sidebar.right.pane.tab", () =>
    ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, Panel),
  );
  ctx.slots.inject("sidebar.right.pane.tab", () =>
    ctx.slots.register({ name: "sidebar.right.pane.tab", key: TACTICS_TAB_ID }, TacticsPanel),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: OVERVIEW_PANEL_ID }, OverviewPage),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: OVERVIEW_PANEL_ID,
        order: 5,
        label: "FFPR 总控",
      },
      OverviewIcon,
    ),
  );
  startAutoOpen(ctx, TAB_KIND, OPENED_PREFIX);
  startAutoOpen(ctx, TACTICS_KIND, TACTICS_OPENED_PREFIX);
}

exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
exports.apply = apply;

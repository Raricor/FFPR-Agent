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
const OPENED_PREFIX = "ffpr-dsh.achievements.opened.";
const TACTICS_OPENED_PREFIX = "ffpr-dsh.tactics.opened.";
const ONLY_MISSING_KEY = "ffpr-dsh.achievements.onlyMissing";
const PANEL_TAB_KEY = "ffpr-dsh.achievements.tab";
const REFRESH_MS = 30_000;
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

async function fetchPanel(signal: AbortSignal): Promise<PanelReply> {
  // Relative on purpose: the web app may be mounted below the origin's root.
  const response = await fetch("api/ffpr/achievements", {
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

async function fetchTactics(signal: AbortSignal): Promise<TacticsPanelView> {
  const response = await fetch("api/ffpr/tactics", {
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

async function loadAchievements(signal: AbortSignal): Promise<PollResult<AchievementView>> {
  const reply = await fetchPanel(signal);
  return reply.ok
    ? { value: reply.view, error: null, at: reply.at }
    : { value: null, error: reply.error, at: reply.at };
}

async function loadTactics(signal: AbortSignal): Promise<PollResult<TacticsPanelView>> {
  return { value: await fetchTactics(signal), error: null, at: null };
}

/** One 30-second poll, shared by both sidebar tabs; errors keep the last good content. */
function usePolling<T>(
  load: (signal: AbortSignal) => Promise<PollResult<T>>,
  intervalMs: number,
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
        const next = await load(controller.signal);
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
  }, [tick]);
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
  const { data: view, error, at, reload } = usePolling(loadAchievements, REFRESH_MS);
  const [onlyMissing, setOnlyMissing] = React.useState<boolean>(
    () => readStorage(ONLY_MISSING_KEY) === "1",
  );
  const [tab, setTab] = React.useState<PanelTab>(() => {
    const saved = readStorage(PANEL_TAB_KEY);
    return saved === "bestiary" || saved === "treasure" ? saved : "achievements";
  });

  const rows = view === null ? [] : onlyMissing ? view.rows.filter((row) => !row.done) : view.rows;
  const children: unknown[] = [panelHeader(view?.title ?? "FFPR 成就", reload)];
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
  const { data: view, error, at, reload } = usePolling(loadTactics, REFRESH_MS);
  const children: unknown[] = [panelHeader(view?.title ?? "FFPR 策略", reload)];
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
  startAutoOpen(ctx, TAB_KIND, OPENED_PREFIX);
  startAutoOpen(ctx, TACTICS_KIND, TACTICS_OPENED_PREFIX);
}

exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
exports.apply = apply;

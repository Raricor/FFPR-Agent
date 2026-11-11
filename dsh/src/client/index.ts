/**
 * FFPR sidebar panels (tasks 14–20, task 40): one game only, chosen by /api/ffpr/current. The
 * server computes every word and every title; this bundle only polls the four panels and the
 * total-control route and lays the views out. It has no imports: React and the client services
 * come from the loader. The four tabs are ① 玩家, ② 战术官, ③ 战斗 and 成就.
 */

const TAB_ID = "@local/ffpr-dsh";
const TAB_KIND = "ffpr-achievements";
const TACTICS_TAB_ID = "@local/ffpr-dsh/tactics";
const TACTICS_KIND = "ffpr-tactics";
const PLAYER_TAB_ID = "@local/ffpr-dsh/player";
const PLAYER_KIND = "ffpr-player";
const BATTLE_TAB_ID = "@local/ffpr-dsh/battle";
const BATTLE_KIND = "ffpr-battle";
const OVERVIEW_PANEL_ID = "ffpr";
const OPENED_PREFIX = "ffpr-dsh.achievements.opened.";
const TACTICS_OPENED_PREFIX = "ffpr-dsh.tactics.opened.";
const PLAYER_OPENED_PREFIX = "ffpr-dsh.player.opened.";
const BATTLE_OPENED_PREFIX = "ffpr-dsh.battle.opened.";
const PLAN_OPENED_KEY = "ffpr-dsh.plan.opened";
const ONLY_MISSING_KEY = "ffpr-dsh.achievements.onlyMissing";
const PANEL_TAB_KEY = "ffpr-dsh.achievements.tab";
const REFRESH_MS = 30_000;
const BATTLE_REFRESH_MS = 2000;
const OVERVIEW_REFRESH_MS = 3000;
const WALK_ACTIVE_REFRESH_MS = 500;
const WALK_IDLE_REFRESH_MS = 3000;
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
  readonly save?: string;
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

type BattleResult = "ok" | "hard" | "wipe" | "timeout";

interface BattleUnitView {
  readonly name: string;
  readonly idText: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly hpText: string;
  readonly mpText: string;
  readonly statusText: string;
}

interface BattleTurnView {
  readonly atText: string;
  readonly line: string;
  readonly basis: string;
  readonly skippedText: string;
}

interface BattleEventView {
  readonly atText: string;
  readonly line: string;
  readonly counter: boolean;
}

interface BattleLiveView {
  readonly id: number;
  readonly title: string;
  readonly enemies: readonly BattleUnitView[];
  readonly party: readonly BattleUnitView[];
  readonly turns: readonly BattleTurnView[];
  readonly events?: readonly BattleEventView[];
}

interface BattleSummaryView {
  readonly id: number;
  readonly atText: string;
  readonly line: string;
  readonly result: BattleResult;
  readonly resultText: string;
  readonly seconds: number;
}

interface BattleRecordView {
  readonly id: number;
  readonly title: string;
  readonly result: BattleResult;
  readonly resultText: string;
  readonly tableText: string;
  readonly summaryText: string;
  readonly turns: readonly BattleTurnView[];
  readonly events?: readonly BattleEventView[];
  readonly hits: readonly string[];
}

interface BattleReply {
  readonly ok: true;
  readonly at: string;
  readonly live: BattleLiveView | null;
  readonly recent: readonly BattleSummaryView[];
}

interface CurrentReply {
  readonly ok: true;
  readonly at: string;
  readonly game: string;
  readonly label: string;
  readonly name: string;
  readonly title: string;
  readonly running: boolean;
  readonly reason: string;
  readonly since: string | null;
}

interface PlayerDecisionView {
  readonly said: string | null;
  readonly line: string;
}

interface PlayerMessageView {
  readonly timeText: string;
  readonly text: string;
}

interface PlayerView {
  readonly title: string;
  readonly status: string;
  readonly goal: PlayerMessageView | null;
  readonly now: string;
  readonly notes: readonly string[];
  readonly decisions: readonly PlayerDecisionView[];
  readonly messages: readonly PlayerMessageView[];
  readonly messagesTitle: string;
  readonly incidents: readonly string[];
  readonly backlog: readonly string[];
}

interface BookStationRowView {
  readonly number: number;
  readonly mapText: string;
  readonly cellText: string;
  readonly action: string;
  readonly statusText: string;
  readonly note: string;
  readonly current: boolean;
}

interface BookTableView {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

interface BookSectionView {
  readonly heading: string;
  readonly startedText: string;
  readonly stateText: string;
  readonly acceptanceText: string;
  readonly headers: readonly string[];
  readonly stations: readonly BookStationRowView[];
  readonly emptyText: string;
}

interface BookPanelView {
  readonly title: string;
  readonly status: string;
  readonly message: string | null;
  readonly section: BookSectionView | null;
  readonly totals: BookTableView | null;
}

interface PlanStationRowView {
  readonly number: number;
  readonly mapText: string;
  readonly cellText: string;
  readonly action: string;
  readonly why: string;
  readonly untilText: string;
  readonly statusSymbol: string;
  readonly statusText: string;
  readonly note: string;
  readonly current: boolean;
}

interface PlanDroppedRowView {
  readonly number: number;
  readonly mapText: string;
  readonly cellText: string;
  readonly action: string;
  readonly why: string;
}

interface PlanRuleTableView {
  readonly title: string;
  readonly lines: readonly string[];
}

interface PlanBattleGroupView {
  readonly title: string;
  readonly tables: readonly PlanRuleTableView[];
}

interface PlanBossView {
  readonly name: string;
  readonly mapText: string;
  readonly prepText: string;
  readonly tables: readonly PlanRuleTableView[];
  readonly notes: string;
}

interface PlanReportView {
  readonly heading: string;
  readonly lines: readonly string[];
  readonly exceptionText: string | null;
}

interface PlanView {
  readonly section: string;
  readonly goalText: string;
  readonly revisionText: string;
  readonly statusText: string;
  readonly startedText: string;
  readonly updatedText: string;
  readonly whyText: string | null;
  readonly prep: readonly string[];
  readonly prepEmptyText: string;
  readonly stationHeaders: readonly string[];
  readonly stations: readonly PlanStationRowView[];
  readonly stationEmptyText: string;
  readonly dropped: readonly PlanDroppedRowView[];
  readonly droppedHeaders: readonly string[];
  readonly battle: readonly PlanBattleGroupView[];
  readonly boss: readonly PlanBossView[];
  readonly turnBack: readonly string[];
  readonly turnBackEmptyText: string;
  readonly report: PlanReportView | null;
  readonly reportEmptyText: string;
  readonly notes: string | null;
  readonly warnings: readonly string[];
}

interface PlanPanelView {
  readonly title: string;
  readonly status: string;
  readonly message: string | null;
  readonly plan: PlanView | null;
}

interface TacticianRuleLine {
  readonly text: string;
  readonly hits: number;
  readonly skipText: string;
  readonly skipped: boolean;
}

interface TacticianMemberView {
  readonly name: string;
  readonly rules: readonly TacticianRuleLine[];
}

interface TacticianTableView {
  readonly title: string;
  readonly inUse: boolean;
  readonly members: readonly TacticianMemberView[];
  readonly recordText: string;
  readonly error: string | null;
}

interface TacticianMapView {
  readonly mapId: number;
  readonly name: string;
  readonly walkerNotes: string;
  readonly askUp: string;
  readonly writtenAt: string;
  readonly tables: readonly TacticianTableView[];
  readonly tableEmpty: string;
  readonly boss: {
    readonly title: string;
    readonly table: TacticianTableView;
    readonly result: string;
    readonly atText: string;
    readonly rewrites: readonly string[];
  } | null;
  readonly bossEmpty: string;
}

interface TacticianCallView {
  readonly line: string;
  readonly atText: string;
}

interface TacticianPanelView {
  readonly title: string;
  readonly status: string;
  readonly message: string | null;
  readonly map: TacticianMapView | null;
  readonly calls: readonly TacticianCallView[];
  readonly callsEmpty: string;
  readonly others: readonly TacticianMapView[];
}

interface CurrentPlaceView {
  readonly mapId: number | null;
  readonly name: string;
}

interface CurrentPartyView {
  readonly name: string;
  readonly job: string;
  readonly level: number | null;
  readonly hp: number;
  readonly maxHp: number;
  readonly mp: number | null;
  readonly maxMp: number | null;
}

interface CurrentCard {
  readonly game: string;
  readonly title: string;
  readonly label: string;
  readonly name: string;
  readonly running: boolean;
  readonly statusText: string;
  readonly bridge: {
    readonly version: string | null;
    readonly connected: boolean;
    readonly atb: "等待" | "实时" | null;
  };
  readonly place: CurrentPlaceView;
  readonly party: readonly CurrentPartyView[];
  readonly gil: number | null;
  readonly saveCount: number | null;
  readonly busy: { readonly name: string; readonly at: string } | null;
  readonly last: { readonly at: string; readonly kind: string; readonly text: string } | null;
  readonly lastKnownAt: string | null;
  readonly saveSlot: number;
}

interface ActivityEntry {
  readonly at: string;
  readonly game: string;
  readonly kind: "tool" | "event" | "link" | "warn" | "error" | "plan";
  readonly text: string;
}

interface OverviewReply {
  readonly at: string;
  readonly current: CurrentCard | null;
  readonly log: readonly ActivityEntry[];
}

interface WalkSegmentView {
  readonly n: number;
  readonly of: number;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

interface WalkDisplayView {
  readonly mapText: string;
  readonly statusText: string;
  readonly segmentText: string;
  readonly progressText: string;
  readonly elapsedText: string;
}

interface WalkView {
  readonly game: string;
  readonly seq: number | null;
  readonly map: number | null;
  readonly label: string;
  readonly goal: readonly [number, number];
  readonly path: readonly (readonly [number, number])[];
  readonly origin: readonly [number, number];
  readonly rows: readonly string[];
  readonly index: number;
  readonly steps: number;
  readonly cell: readonly [number, number];
  readonly segment: WalkSegmentView;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly reason: string | null;
  readonly display?: WalkDisplayView;
}

interface WalkReply {
  readonly at: string;
  readonly view: WalkView | null;
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

function isBattleUnit(value: unknown): value is BattleUnitView {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.idText === "string" &&
    typeof value.hp === "number" &&
    typeof value.maxHp === "number" &&
    typeof value.hpText === "string" &&
    typeof value.mpText === "string" &&
    typeof value.statusText === "string"
  );
}

function isBattleTurn(value: unknown): value is BattleTurnView {
  return (
    isRecord(value) &&
    typeof value.atText === "string" &&
    typeof value.line === "string" &&
    typeof value.basis === "string" &&
    typeof value.skippedText === "string"
  );
}

function isBattleLive(value: unknown): value is BattleLiveView {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.title === "string" &&
    Array.isArray(value.enemies) &&
    value.enemies.every(isBattleUnit) &&
    Array.isArray(value.party) &&
    value.party.every(isBattleUnit) &&
    Array.isArray(value.turns) &&
    value.turns.every(isBattleTurn)
  );
}

function isBattleSummary(value: unknown): value is BattleSummaryView {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.atText === "string" &&
    typeof value.line === "string" &&
    typeof value.resultText === "string" &&
    typeof value.seconds === "number" &&
    isBattleResult(value.result)
  );
}

function isBattleResult(value: unknown): value is BattleResult {
  return value === "ok" || value === "hard" || value === "wipe" || value === "timeout";
}

function isBattleRecord(value: unknown): value is BattleRecordView {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.title === "string" &&
    isBattleResult(value.result) &&
    typeof value.resultText === "string" &&
    typeof value.tableText === "string" &&
    typeof value.summaryText === "string" &&
    Array.isArray(value.turns) &&
    value.turns.every(isBattleTurn) &&
    Array.isArray(value.hits) &&
    value.hits.every((hit) => typeof hit === "string")
  );
}

async function fetchBattles(signal: AbortSignal, game: string): Promise<PollResult<BattleReply>> {
  const response = await fetch(`api/ffpr/battles?game=${encodeURIComponent(game)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了战斗记录(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("读不懂战斗记录");
  const at = typeof body.at === "string" ? body.at : new Date().toISOString();
  if (body.ok !== true) {
    const error = typeof body.error === "string" ? body.error : "读不了战斗记录";
    return { value: null, error, at };
  }
  const live = body.live === null ? null : isBattleLive(body.live) ? body.live : undefined;
  if (live === undefined || !Array.isArray(body.recent)) throw new Error("读不懂战斗记录");
  const recent = body.recent.filter(isBattleSummary);
  if (recent.length !== body.recent.length) throw new Error("读不懂战斗记录");
  return { value: { ok: true, at, live, recent }, error: null, at };
}

async function fetchBattleRecord(
  signal: AbortSignal,
  game: string,
  id: number,
): Promise<BattleRecordView> {
  const response = await fetch(
    `api/ffpr/battles?game=${encodeURIComponent(game)}&id=${encodeURIComponent(String(id))}`,
    { signal, headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`读不了战斗记录(HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("读不懂战斗记录");
  if (body.ok !== true) {
    throw new Error(typeof body.error === "string" ? body.error : "读不了战斗记录");
  }
  if (!isBattleRecord(body.record)) throw new Error("读不懂战斗记录");
  return body.record;
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

async function loadBattles(signal: AbortSignal, game: string): Promise<PollResult<BattleReply>> {
  return await fetchBattles(signal, game);
}

async function fetchCurrent(signal: AbortSignal): Promise<PollResult<CurrentReply>> {
  const response = await fetch("api/ffpr/current", {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了当前作品(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    body.ok !== true ||
    typeof body.game !== "string" ||
    typeof body.label !== "string" ||
    typeof body.name !== "string" ||
    typeof body.title !== "string" ||
    typeof body.running !== "boolean"
  ) {
    throw new Error("读不懂当前作品");
  }
  return {
    value: {
      ok: true,
      at: typeof body.at === "string" ? body.at : new Date().toISOString(),
      game: body.game,
      label: body.label,
      name: body.name,
      title: body.title,
      running: body.running,
      reason: typeof body.reason === "string" ? body.reason : "",
      since: typeof body.since === "string" ? body.since : null,
    },
    error: null,
    at: typeof body.at === "string" ? body.at : null,
  };
}

async function fetchPlayer(signal: AbortSignal, game: string): Promise<PollResult<PlayerView>> {
  const response = await fetch(`api/ffpr/player?game=${encodeURIComponent(game)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了玩家记录(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("读不懂玩家记录");
  const at = typeof body.at === "string" ? body.at : null;
  if (body.ok !== true || !isRecord(body.view) || typeof body.view.title !== "string") {
    return {
      value: null,
      error: typeof body.error === "string" ? body.error : "读不了玩家记录",
      at,
    };
  }
  const view = body.view;
  return {
    value: {
      title: typeof view.title === "string" ? view.title : "",
      status: typeof view.status === "string" ? view.status : "",
      goal: isRecord(view.goal)
        ? {
            timeText: typeof view.goal.timeText === "string" ? view.goal.timeText : "",
            text: typeof view.goal.text === "string" ? view.goal.text : "",
          }
        : null,
      now: typeof view.now === "string" ? view.now : "",
      notes: Array.isArray(view.notes) ? view.notes.filter((item) => typeof item === "string") : [],
      incidents: Array.isArray(view.incidents)
        ? view.incidents.filter((item) => typeof item === "string")
        : [],
      backlog: Array.isArray(view.backlog)
        ? view.backlog.filter((item) => typeof item === "string")
        : [],
      decisions: Array.isArray(view.decisions)
        ? view.decisions.flatMap((item) =>
            isRecord(item) && typeof item.line === "string"
              ? [{ said: typeof item.said === "string" ? item.said : null, line: item.line }]
              : [],
          )
        : [],
      messages: Array.isArray(view.messages)
        ? view.messages.flatMap((item) =>
            isRecord(item) && typeof item.text === "string"
              ? [
                  {
                    timeText: typeof item.timeText === "string" ? item.timeText : "",
                    text: item.text,
                  },
                ]
              : [],
          )
        : [],
      messagesTitle: typeof view.messagesTitle === "string" ? view.messagesTitle : "收到的消息",
    },
    error: null,
    at,
  };
}

function isBookRow(value: unknown): value is BookStationRowView {
  return (
    isRecord(value) &&
    typeof value.number === "number" &&
    typeof value.mapText === "string" &&
    typeof value.cellText === "string" &&
    typeof value.action === "string" &&
    typeof value.statusText === "string" &&
    typeof value.note === "string" &&
    typeof value.current === "boolean"
  );
}

function isBookTable(value: unknown): value is BookTableView {
  return (
    isRecord(value) &&
    Array.isArray(value.headers) &&
    value.headers.every((header) => typeof header === "string") &&
    Array.isArray(value.rows) &&
    value.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))
  );
}

function isBookSection(value: unknown): value is BookSectionView {
  return (
    isRecord(value) &&
    typeof value.heading === "string" &&
    typeof value.startedText === "string" &&
    typeof value.stateText === "string" &&
    typeof value.acceptanceText === "string" &&
    Array.isArray(value.headers) &&
    value.headers.every((header) => typeof header === "string") &&
    Array.isArray(value.stations) &&
    value.stations.every(isBookRow) &&
    typeof value.emptyText === "string"
  );
}

function isBookView(value: unknown): value is BookPanelView {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    (value.message === null || typeof value.message === "string") &&
    (value.section === null || isBookSection(value.section)) &&
    (value.totals === null || isBookTable(value.totals))
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlanStationRow(value: unknown): value is PlanStationRowView {
  return (
    isRecord(value) &&
    typeof value.number === "number" &&
    typeof value.mapText === "string" &&
    typeof value.cellText === "string" &&
    typeof value.action === "string" &&
    typeof value.why === "string" &&
    typeof value.untilText === "string" &&
    typeof value.statusSymbol === "string" &&
    typeof value.statusText === "string" &&
    typeof value.note === "string" &&
    typeof value.current === "boolean"
  );
}

function isPlanDroppedRow(value: unknown): value is PlanDroppedRowView {
  return (
    isRecord(value) &&
    typeof value.number === "number" &&
    typeof value.mapText === "string" &&
    typeof value.cellText === "string" &&
    typeof value.action === "string" &&
    typeof value.why === "string"
  );
}

function isPlanRuleTable(value: unknown): value is PlanRuleTableView {
  return isRecord(value) && typeof value.title === "string" && isStringArray(value.lines);
}

function isPlanBattleGroup(value: unknown): value is PlanBattleGroupView {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    Array.isArray(value.tables) &&
    value.tables.every(isPlanRuleTable)
  );
}

function isPlanBoss(value: unknown): value is PlanBossView {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.mapText === "string" &&
    typeof value.prepText === "string" &&
    Array.isArray(value.tables) &&
    value.tables.every(isPlanRuleTable) &&
    typeof value.notes === "string"
  );
}

function isPlanReport(value: unknown): value is PlanReportView {
  return (
    isRecord(value) &&
    typeof value.heading === "string" &&
    isStringArray(value.lines) &&
    (value.exceptionText === null || typeof value.exceptionText === "string")
  );
}

function isPlanView(value: unknown): value is PlanView {
  return (
    isRecord(value) &&
    typeof value.section === "string" &&
    typeof value.goalText === "string" &&
    typeof value.revisionText === "string" &&
    typeof value.statusText === "string" &&
    typeof value.startedText === "string" &&
    typeof value.updatedText === "string" &&
    (value.whyText === null || typeof value.whyText === "string") &&
    isStringArray(value.prep) &&
    typeof value.prepEmptyText === "string" &&
    isStringArray(value.stationHeaders) &&
    Array.isArray(value.stations) &&
    value.stations.every(isPlanStationRow) &&
    typeof value.stationEmptyText === "string" &&
    Array.isArray(value.dropped) &&
    value.dropped.every(isPlanDroppedRow) &&
    isStringArray(value.droppedHeaders) &&
    Array.isArray(value.battle) &&
    value.battle.every(isPlanBattleGroup) &&
    Array.isArray(value.boss) &&
    value.boss.every(isPlanBoss) &&
    isStringArray(value.turnBack) &&
    typeof value.turnBackEmptyText === "string" &&
    (value.report === null || isPlanReport(value.report)) &&
    typeof value.reportEmptyText === "string" &&
    (value.notes === null || typeof value.notes === "string") &&
    isStringArray(value.warnings)
  );
}

function isPlanPanelView(value: unknown): value is PlanPanelView {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    (value.message === null || typeof value.message === "string") &&
    (value.plan === null || isPlanView(value.plan))
  );
}

async function fetchBook(signal: AbortSignal, game: string): Promise<PollResult<BookPanelView>> {
  const response = await fetch(`api/ffpr/book?game=${encodeURIComponent(game)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了路线书(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("读不懂路线书");
  const at = typeof body.at === "string" ? body.at : null;
  if (body.ok !== true || !isBookView(body.view)) {
    return {
      value: null,
      error: typeof body.error === "string" ? body.error : "读不了路线书",
      at,
    };
  }
  return { value: body.view, error: null, at };
}

async function loadBook(signal: AbortSignal, game: string): Promise<PollResult<BookPanelView>> {
  return await fetchBook(signal, game);
}

async function fetchPlan(signal: AbortSignal, game: string): Promise<PollResult<PlanPanelView>> {
  const response = await fetch(`api/ffpr/plan?game=${encodeURIComponent(game)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了段计划(HTTP ${response.status})，试试刷新网页`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("读不懂段计划");
  const at = typeof body.at === "string" ? body.at : null;
  if (body.ok !== true || !isPlanPanelView(body.view)) {
    return {
      value: null,
      error: typeof body.error === "string" ? body.error : "读不了段计划",
      at,
    };
  }
  return { value: body.view, error: null, at };
}

async function loadPlan(signal: AbortSignal, game: string): Promise<PollResult<PlanPanelView>> {
  return await fetchPlan(signal, game);
}

function isRuleLine(value: unknown): value is TacticianRuleLine {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.hits === "number" &&
    typeof value.skipText === "string" &&
    typeof value.skipped === "boolean"
  );
}

function isTable(value: unknown): value is TacticianTableView {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.inUse === "boolean" &&
    typeof value.recordText === "string" &&
    (value.error === null || typeof value.error === "string") &&
    Array.isArray(value.members) &&
    value.members.every(
      (member) =>
        isRecord(member) &&
        typeof member.name === "string" &&
        Array.isArray(member.rules) &&
        member.rules.every(isRuleLine),
    )
  );
}

function isMapView(value: unknown): value is TacticianMapView {
  return (
    isRecord(value) &&
    typeof value.mapId === "number" &&
    typeof value.name === "string" &&
    typeof value.walkerNotes === "string" &&
    typeof value.askUp === "string" &&
    Array.isArray(value.tables) &&
    value.tables.every(isTable)
  );
}

async function fetchTactician(
  signal: AbortSignal,
  game: string,
): Promise<PollResult<TacticianPanelView>> {
  const response = await fetch(`api/ffpr/tactician?game=${encodeURIComponent(game)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了战术官(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("读不懂战术官");
  const at = typeof body.at === "string" ? body.at : null;
  if (body.ok !== true || !isRecord(body.view) || typeof body.view.title !== "string") {
    return {
      value: null,
      error: typeof body.error === "string" ? body.error : "读不了战术官",
      at,
    };
  }
  const view = body.view;
  const map = body.view.map;
  const boss = isRecord(map) && isRecord(map.boss) && isTable(map.boss.table) ? map.boss : null;
  return {
    value: {
      title: typeof view.title === "string" ? view.title : "",
      status: typeof view.status === "string" ? view.status : "",
      message: typeof view.message === "string" ? view.message : null,
      map: isMapView(map)
        ? {
            ...map,
            boss: boss
              ? {
                  title: typeof boss.title === "string" ? boss.title : "首领表",
                  table: boss.table as TacticianTableView,
                  result: typeof boss.result === "string" ? boss.result : "",
                  atText: typeof boss.atText === "string" ? boss.atText : "",
                  rewrites: Array.isArray(boss.rewrites)
                    ? boss.rewrites.filter((item) => typeof item === "string")
                    : [],
                }
              : null,
            bossEmpty: typeof map.bossEmpty === "string" ? map.bossEmpty : "这张地图还没有首领表",
          }
        : null,
      calls: Array.isArray(view.calls)
        ? view.calls.flatMap((item) =>
            isRecord(item) && typeof item.line === "string"
              ? [{ line: item.line, atText: typeof item.atText === "string" ? item.atText : "" }]
              : [],
          )
        : [],
      callsEmpty: typeof view.callsEmpty === "string" ? view.callsEmpty : "还没叫过战术官",
      others: Array.isArray(view.others) ? view.others.filter(isMapView) : [],
    },
    error: null,
    at,
  };
}

async function fetchOverview(
  signal: AbortSignal,
  game: string,
): Promise<PollResult<OverviewReply>> {
  const params = new URLSearchParams({ game, limit: "300" });
  const response = await fetch(`api/ffpr/overview?${params.toString()}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了总控数据(HTTP ${response.status}),试试刷新网页`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    body.ok !== true ||
    !Array.isArray(body.log) ||
    !body.log.every(isActivityEntry)
  ) {
    throw new Error("读不懂总控数据");
  }
  const card = isCurrentCard(body.current) ? body.current : null;
  return {
    value: {
      at: typeof body.at === "string" ? body.at : new Date().toISOString(),
      current: card,
      log: body.log.filter(isActivityEntry),
    },
    error: null,
    at: typeof body.at === "string" ? body.at : null,
  };
}

function isCurrentCard(value: unknown): value is CurrentCard {
  return (
    isRecord(value) &&
    typeof value.game === "string" &&
    typeof value.title === "string" &&
    typeof value.running === "boolean" &&
    typeof value.statusText === "string" &&
    isRecord(value.bridge) &&
    isRecord(value.place) &&
    Array.isArray(value.party)
  );
}

function isActivityEntry(value: unknown): value is ActivityEntry {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    typeof value.game === "string" &&
    typeof value.text === "string" &&
    (value.kind === "tool" ||
      value.kind === "event" ||
      value.kind === "link" ||
      value.kind === "warn" ||
      value.kind === "error" ||
      value.kind === "plan")
  );
}

function isCell(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function isWalkSegment(value: unknown): value is WalkSegmentView {
  return (
    isRecord(value) &&
    typeof value.n === "number" &&
    typeof value.of === "number" &&
    isCell(value.from) &&
    isCell(value.to)
  );
}

function isWalkDisplay(value: unknown): value is WalkDisplayView {
  return (
    isRecord(value) &&
    typeof value.mapText === "string" &&
    typeof value.statusText === "string" &&
    typeof value.segmentText === "string" &&
    typeof value.progressText === "string" &&
    typeof value.elapsedText === "string"
  );
}

function isWalkView(value: unknown): value is WalkView {
  return (
    isRecord(value) &&
    typeof value.game === "string" &&
    (value.seq === null || typeof value.seq === "number") &&
    (value.map === null || typeof value.map === "number") &&
    typeof value.label === "string" &&
    isCell(value.goal) &&
    Array.isArray(value.path) &&
    value.path.every(isCell) &&
    isCell(value.origin) &&
    Array.isArray(value.rows) &&
    value.rows.every((row) => typeof row === "string") &&
    typeof value.index === "number" &&
    typeof value.steps === "number" &&
    isCell(value.cell) &&
    isWalkSegment(value.segment) &&
    typeof value.startedAt === "string" &&
    (value.endedAt === null || typeof value.endedAt === "string") &&
    (value.reason === null || typeof value.reason === "string") &&
    (value.display === undefined || isWalkDisplay(value.display))
  );
}

async function fetchWalk(signal: AbortSignal, game: string): Promise<PollResult<WalkReply>> {
  const response = await fetch(`api/ffpr/walk?game=${encodeURIComponent(game)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`读不了走路数据(HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (!isRecord(body) || body.ok !== true) {
    const error = isRecord(body) && typeof body.error === "string" ? body.error : "读不懂走路数据";
    throw new Error(error);
  }
  const at = typeof body.at === "string" ? body.at : new Date().toISOString();
  const view = body.view === null ? null : isWalkView(body.view) ? body.view : null;
  return { value: { at, view }, error: null, at };
}

async function loadWalk(signal: AbortSignal, game: string): Promise<PollResult<WalkReply>> {
  return await fetchWalk(signal, game);
}

async function loadCurrent(signal: AbortSignal): Promise<PollResult<CurrentReply>> {
  return await fetchCurrent(signal);
}

async function loadPlayer(signal: AbortSignal, game: string): Promise<PollResult<PlayerView>> {
  return await fetchPlayer(signal, game);
}

async function loadTactician(
  signal: AbortSignal,
  game: string,
): Promise<PollResult<TacticianPanelView>> {
  return await fetchTactician(signal, game);
}

async function loadOverview(signal: AbortSignal, game: string): Promise<PollResult<OverviewReply>> {
  return await fetchOverview(signal, game);
}

/** Two seconds while a battle runs, otherwise the sidebar's usual 30 seconds. */
function battleInterval(data: BattleReply | null): number {
  return data?.live !== null && data?.live !== undefined ? BATTLE_REFRESH_MS : REFRESH_MS;
}

/** Half a second while the party walks, three seconds after it stopped (task 61). */
function walkInterval(data: WalkReply | null): number {
  const view = data?.view ?? null;
  return view !== null && view.endedAt === null ? WALK_ACTIVE_REFRESH_MS : WALK_IDLE_REFRESH_MS;
}

/** One 30-second poll, shared by both sidebar tabs; errors keep the last good content. */
function usePolling<T>(
  load: (signal: AbortSignal, game: string) => Promise<PollResult<T>>,
  intervalMs: number | ((data: T | null) => number),
  game: string,
  paused = false,
): { data: T | null; error: string | null; at: string; reload: () => void } {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [at, setAt] = React.useState<string>("");
  const [tick, setTick] = React.useState<number>(0);
  const interval = typeof intervalMs === "number" ? intervalMs : intervalMs(data);
  React.useEffect(() => {
    if (paused) return undefined;
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
    timer = window.setInterval(reload, interval);
    document.addEventListener("visibilitychange", reload);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [tick, game, interval, paused]);
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
          h(
            "span",
            { style: { float: "right" } },
            bestiaryCount(area.count),
            area.save === undefined ? null : ` · 本档 ${area.save}`,
          ),
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

const CARD_STYLE: Record<string, string | number> = {
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  padding: "8px 10px",
  marginTop: 8,
};

const SECTION_TITLE_STYLE: Record<string, string | number> = {
  fontSize: 12,
  fontWeight: 600,
  marginTop: 10,
  marginBottom: 2,
};

const PANEL_STYLE: Record<string, string | number> = {
  height: "100%",
  overflowY: "auto",
  boxSizing: "border-box",
  padding: "8px 10px",
  fontSize: 13,
  lineHeight: 1.45,
};

type Tone = "win" | "hard" | "wipe" | "skip" | "muted" | "business";

function toneColor(tone: Tone): string {
  if (tone === "win") return "var(--dsw-alias-state-success-primary)";
  if (tone === "hard" || tone === "skip") return "var(--dsw-alias-state-warn-primary)";
  if (tone === "wipe") return "var(--dsw-alias-state-error-primary)";
  if (tone === "business") return "var(--dsw-alias-state-business-primary)";
  return "var(--dsw-alias-label-tertiary)";
}

function card(children: readonly unknown[], key?: string): unknown {
  return h("div", { key, style: CARD_STYLE }, ...children);
}

function sectionTitle(text: string): unknown {
  return h("div", { style: SECTION_TITLE_STYLE }, text);
}

function tag(text: string, tone: Tone): unknown {
  return h(
    "span",
    {
      style: {
        fontSize: 11,
        padding: "0 5px",
        borderRadius: 4,
        color: toneColor(tone),
        border: `1px solid ${toneColor(tone)}`,
        whiteSpace: "nowrap",
      },
    },
    text,
  );
}

function emptyLine(text: string): unknown {
  return h("div", { style: { fontSize: 12, opacity: 0.65, marginTop: 4 } }, text);
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
        height: 4,
        borderRadius: 2,
        background: "rgba(128, 128, 128, 0.25)",
        overflow: "hidden",
      },
    },
    h("div", { style: { width: `${percent}%`, height: "100%", background: color } }),
  );
}

function panelHeader(
  title: string,
  status: string | null,
  running: boolean | null,
  reload: () => void,
): unknown {
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 } },
    h("div", { style: { fontWeight: 600, fontSize: 13, flex: 1 } }, title),
    running === null
      ? null
      : tag(status ?? (running ? "运行中" : "没在运行"), running ? "win" : "muted"),
    h(
      "button",
      { type: "button", onClick: reload, style: { fontSize: 12, padding: "2px 8px" } },
      "刷新",
    ),
  );
}

function useCurrentGame(): {
  readonly current: CurrentReply | null;
  readonly game: string;
  readonly error: string | null;
  readonly at: string;
  readonly reload: () => void;
} {
  const poll = usePolling(loadCurrent, OVERVIEW_REFRESH_MS, "");
  return {
    current: poll.data,
    game: poll.data?.game ?? "ff5",
    error: poll.error,
    at: poll.at,
    reload: poll.reload,
  };
}

function errorLine(error: string | null): unknown {
  return error === null
    ? null
    : h("div", { style: { color: toneColor("hard"), marginTop: 4 } }, error);
}

function bookStatusTone(status: string): Tone {
  if (status === "已完成") return "win";
  if (status === "进行中") return "business";
  if (status === "交回") return "hard";
  return "muted";
}

function bookStationCell(row: BookStationRowView): unknown {
  return h(
    "div",
    null,
    tag(row.statusText, bookStatusTone(row.statusText)),
    row.note === ""
      ? null
      : h(
          "div",
          { style: { fontSize: 11, opacity: 0.7, marginTop: 2, overflowWrap: "anywhere" } },
          row.note,
        ),
  );
}

function planStatusTone(status: string): Tone {
  if (status === "完成") return "win";
  if (status === "执行中") return "business";
  if (status === "出例外") return "hard";
  return "muted";
}

function planStationCell(row: PlanStationRowView): unknown {
  const tone: Tone =
    row.statusSymbol === "✓"
      ? "win"
      : row.statusSymbol === "▶"
        ? "business"
        : row.statusSymbol === "✗"
          ? "hard"
          : "muted";
  const parts: unknown[] = [
    h(
      "span",
      { style: { color: toneColor(tone), fontWeight: 600 } },
      `${row.statusSymbol} ${row.statusText}`,
    ),
  ];
  if (row.note !== "") {
    parts.push(
      h(
        "div",
        { style: { fontSize: 11, opacity: 0.7, marginTop: 2, overflowWrap: "anywhere" } },
        row.note,
      ),
    );
  }
  return h("div", null, ...parts);
}

function planRuleTables(tables: readonly PlanRuleTableView[], keyPrefix: string): unknown[] {
  return tables.map((table, index) =>
    h(
      "div",
      { key: `${keyPrefix}-${index}`, style: { marginTop: 4 } },
      h("div", { style: { fontSize: 11, fontWeight: 600, opacity: 0.8 } }, table.title),
      ...table.lines.map((line, lineIndex) =>
        h(
          "div",
          { key: lineIndex, style: { fontSize: 12, marginTop: 1, overflowWrap: "anywhere" } },
          line,
        ),
      ),
    ),
  );
}

function planReportBlock(report: PlanReportView | null, emptyText: string): unknown {
  if (report === null) return emptyLine(emptyText);
  return h(
    "div",
    null,
    ...report.lines.map((line, index) =>
      h(
        "div",
        { key: `report-${index}`, style: { fontSize: 12, marginTop: index === 0 ? 0 : 1 } },
        line,
      ),
    ),
    report.exceptionText === null
      ? null
      : h(
          "div",
          { style: { fontSize: 12, color: toneColor("hard"), marginTop: 2 } },
          report.exceptionText,
        ),
  );
}

function planBlock(view: PlanPanelView | null, error: string | null): unknown {
  if (view === null) {
    return card([sectionTitle("段计划"), emptyLine(error ?? "正在读取段计划…")]);
  }
  if (view.plan === null) {
    return card([
      sectionTitle(view.title),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 2 } },
        tag(view.status, planStatusTone(view.status)),
      ),
      view.message === null ? null : emptyLine(view.message),
    ]);
  }
  const plan = view.plan;
  const open = readStorage(PLAN_OPENED_KEY) !== "0";
  const onToggle = (event: unknown): void => {
    if (!isRecord(event)) return;
    const target = event.currentTarget;
    if (isRecord(target) && typeof target.open === "boolean") {
      writeStorage(PLAN_OPENED_KEY, target.open ? "1" : "0");
    }
  };
  const children: unknown[] = [
    h("div", { style: { fontWeight: 600, fontSize: 13, marginTop: 2 } }, plan.section),
    h("div", { style: { fontSize: 12, marginTop: 2 } }, plan.goalText),
    h(
      "div",
      { style: { fontSize: 11, opacity: 0.75, marginTop: 2 } },
      `${plan.revisionText} · ${plan.startedText} · ${plan.updatedText}`,
    ),
  ];
  if (plan.whyText !== null) {
    children.push(
      h(
        "div",
        {
          style: {
            fontSize: 12,
            color: toneColor("business"),
            marginTop: 2,
            overflowWrap: "anywhere",
          },
        },
        plan.whyText,
      ),
    );
  }
  for (const warning of plan.warnings) children.push(emptyLine(warning));
  children.push(sectionTitle("准备"));
  if (plan.prep.length === 0) children.push(emptyLine(plan.prepEmptyText));
  else {
    children.push(
      h(
        "div",
        null,
        ...plan.prep.map((line, index) =>
          h("div", { key: `prep-${index}`, style: { fontSize: 12 } }, line),
        ),
      ),
    );
  }
  children.push(sectionTitle("站点"));
  if (plan.stations.length === 0) children.push(emptyLine(plan.stationEmptyText));
  else {
    children.push(
      table(
        plan.stationHeaders,
        plan.stations.map((row) => [
          row.number,
          row.mapText,
          row.cellText,
          row.action,
          row.why,
          row.untilText,
          planStationCell(row),
        ]),
        plan.stations.map((row) =>
          row.current ? { background: "rgba(217, 130, 43, 0.14)" } : undefined,
        ),
      ),
    );
  }
  if (plan.dropped.length > 0) {
    children.push(sectionTitle("不做的站"));
    children.push(
      table(
        plan.droppedHeaders,
        plan.dropped.map((row) => [row.number, row.mapText, row.cellText, row.action, row.why]),
      ),
    );
  }
  children.push(sectionTitle("普通战斗表"));
  if (plan.battle.length === 0) children.push(emptyLine("没有普通战斗表"));
  else {
    children.push(
      ...plan.battle.map((group, index) =>
        h(
          "details",
          { key: `battle-${index}`, style: { marginTop: 3 } },
          h(
            "summary",
            { style: { cursor: "pointer", fontSize: 12, fontWeight: 600 } },
            group.title,
          ),
          ...planRuleTables(group.tables, `battle-${index}`),
        ),
      ),
    );
  }
  children.push(sectionTitle("首领"));
  if (plan.boss.length === 0) children.push(emptyLine("没有首领"));
  else {
    children.push(
      ...plan.boss.map((boss, index) =>
        h(
          "details",
          { key: `boss-${index}`, style: { marginTop: 3 } },
          h(
            "summary",
            { style: { cursor: "pointer", fontSize: 12, fontWeight: 600 } },
            `${boss.name}（${boss.mapText}）`,
          ),
          h("div", { style: { fontSize: 12, marginTop: 2 } }, boss.prepText),
          ...planRuleTables(boss.tables, `boss-${index}`),
          boss.notes === ""
            ? null
            : h(
                "div",
                { style: { fontSize: 12, marginTop: 2, opacity: 0.8 } },
                `备注：${boss.notes}`,
              ),
        ),
      ),
    );
  }
  children.push(sectionTitle("回头条件"));
  if (plan.turnBack.length === 0) children.push(emptyLine(plan.turnBackEmptyText));
  else {
    children.push(
      h(
        "div",
        null,
        ...plan.turnBack.map((line, index) =>
          h("div", { key: `turn-back-${index}`, style: { fontSize: 12 } }, line),
        ),
      ),
    );
  }
  children.push(sectionTitle(plan.report?.heading ?? "最近一份报告"));
  children.push(planReportBlock(plan.report, plan.reportEmptyText));
  if (plan.notes !== null) {
    children.push(sectionTitle("备注"), h("div", { style: { fontSize: 12 } }, plan.notes));
  }
  return h(
    "details",
    { style: CARD_STYLE, open, onToggle },
    h(
      "summary",
      { style: { cursor: "pointer", fontSize: 12, fontWeight: 600 } },
      "段计划",
      h("span", { style: { marginLeft: 6 } }, tag(view.status, planStatusTone(view.status))),
    ),
    ...children,
  );
}

function bookBlock(view: BookPanelView | null, error: string | null): unknown {
  const children: unknown[] = [sectionTitle(view?.title ?? "路线书")];
  if (view === null) {
    children.push(emptyLine(error ?? "正在读取路线书…"));
    return card(children);
  }
  const heading = view.section?.heading ?? view.status;
  children.push(
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("div", { style: { flex: 1, minWidth: 120, fontWeight: 600 } }, heading),
      view.section === null ? null : tag(view.status, bookStatusTone(view.status)),
    ),
  );
  if (view.message !== null && view.message !== view.status) {
    children.push(emptyLine(view.message));
  }
  const section = view.section;
  if (section !== null) {
    children.push(
      h("div", { style: { fontSize: 12, opacity: 0.75, marginTop: 2 } }, section.startedText),
      h("div", { style: { fontSize: 12, marginTop: 2 } }, section.acceptanceText),
    );
    if (section.stations.length === 0) {
      children.push(emptyLine(section.emptyText));
    } else {
      children.push(
        h(
          "div",
          { style: { marginTop: 4 } },
          table(
            section.headers,
            section.stations.map((row) => [
              row.number,
              row.mapText,
              row.cellText,
              row.action,
              bookStationCell(row),
            ]),
            section.stations.map((row) =>
              row.current ? { background: "rgba(217, 130, 43, 0.14)" } : undefined,
            ),
          ),
        ),
      );
    }
  }
  if (view.totals !== null) {
    children.push(
      h(
        "details",
        { style: { marginTop: 8 } },
        h("summary", { style: { cursor: "pointer", fontSize: 12, fontWeight: 600 } }, "全书总表"),
        h("div", { style: { marginTop: 4 } }, table(view.totals.headers, view.totals.rows)),
      ),
    );
  }
  return card(children);
}

function PlayerPanel(): unknown {
  const current = useCurrentGame();
  const poll = usePolling(loadPlayer, REFRESH_MS, current.game);
  const book = usePolling(loadBook, REFRESH_MS, current.game);
  const plan = usePolling(loadPlan, REFRESH_MS, current.game);
  const view = poll.data;
  const children: unknown[] = [
    panelHeader(
      view?.title ?? `${current.current?.title ?? "FFPR"} 玩家`,
      current.current === null ? null : current.current.running ? "运行中" : "没在运行",
      current.current?.running ?? null,
      () => {
        current.reload();
        poll.reload();
        book.reload();
        plan.reload();
      },
    ),
    h(
      "div",
      { style: { fontSize: 11, opacity: 0.7 } },
      current.current?.title ?? "正在找当前作品…",
    ),
  ];
  const error = poll.error ?? current.error;
  children.push(errorLine(error));
  if (view === null) {
    children.push(planBlock(plan.data, plan.error));
    children.push(bookBlock(book.data, book.error));
    if (error === null) children.push(emptyLine("正在读取玩家记录…"));
    return h("div", { style: PANEL_STYLE }, ...children);
  }
  if (view.status !== "") children.push(emptyLine(view.status));
  children.push(
    card([
      sectionTitle("目标"),
      view.goal === null
        ? emptyLine("还没有收到消息")
        : h(
            "div",
            null,
            h(
              "span",
              { style: { opacity: 0.65, fontSize: 11, marginRight: 6 } },
              view.goal.timeText,
            ),
            view.goal.text,
          ),
    ]),
    card([
      sectionTitle("现在"),
      view.now === "" ? emptyLine("AI 还没有说话") : h("div", null, view.now),
    ]),
    planBlock(plan.data, plan.error),
    bookBlock(book.data, book.error),
    card([
      sectionTitle("笔记"),
      view.notes.length === 0
        ? emptyLine("还没有笔记")
        : h(
            "div",
            null,
            ...view.notes.map((note, index) => h("div", { key: `note-${index}` }, note)),
          ),
    ]),
    card([
      sectionTitle("事故"),
      view.incidents.length === 0
        ? emptyLine("没有事故")
        : h(
            "div",
            null,
            ...view.incidents.map((incident, index) =>
              h("div", { key: `incident-${index}`, style: { color: toneColor("wipe") } }, incident),
            ),
          ),
    ]),
    card([
      sectionTitle("欠账"),
      view.backlog.length === 0
        ? emptyLine("没有欠账")
        : h(
            "div",
            null,
            ...view.backlog.map((entry, index) => h("div", { key: `backlog-${index}` }, entry)),
          ),
    ]),
    card([
      sectionTitle("最近的决定"),
      view.decisions.length === 0
        ? emptyLine("还没有工具调用")
        : h(
            "div",
            null,
            ...view.decisions.map((decision, index) =>
              h(
                "div",
                { key: `decision-${index}`, style: { marginTop: index === 0 ? 0 : 5 } },
                decision.said === null
                  ? null
                  : h(
                      "div",
                      { style: { fontSize: 11, opacity: 0.55, whiteSpace: "pre-wrap" } },
                      decision.said,
                    ),
                h("div", { style: { fontSize: 12, overflowWrap: "anywhere" } }, decision.line),
              ),
            ),
          ),
    ]),
    card([
      sectionTitle(view.messagesTitle),
      view.messages.length === 0
        ? emptyLine("还没有收到消息")
        : h(
            "div",
            null,
            ...view.messages.map((message, index) =>
              h(
                "div",
                { key: `message-${index}`, style: { marginTop: index === 0 ? 0 : 5 } },
                h(
                  "span",
                  { style: { opacity: 0.65, fontSize: 11, marginRight: 6 } },
                  message.timeText,
                ),
                h("span", { style: { whiteSpace: "pre-wrap" } }, message.text),
              ),
            ),
          ),
    ]),
  );
  return h("div", { style: PANEL_STYLE }, ...children);
}

function ruleLine(rule: TacticianRuleLine): unknown {
  const parts: unknown[] = [h("span", { style: { fontSize: 12 } }, rule.text)];
  if (rule.hits > 0)
    parts.push(h("span", { style: { marginLeft: 6 } }, tag(`${rule.hits} 次`, "business")));
  if (rule.skipped) {
    parts.push(
      h("div", { style: { fontSize: 11, color: toneColor("skip"), marginTop: 1 } }, rule.skipText),
    );
  }
  return h("div", { key: `${rule.text}-${rule.hits}`, style: { marginTop: 2 } }, ...parts);
}

function tacticianTable(table: TacticianTableView): unknown {
  const children: unknown[] = [
    h(
      "div",
      { style: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" } },
      h("span", { style: { fontWeight: 600, fontSize: 12 } }, table.title),
      table.inUse ? tag("正在用", "win") : null,
      h("span", { style: { fontSize: 11, opacity: 0.7 } }, table.recordText),
    ),
  ];
  if (table.error !== null) children.push(emptyLine(`读不懂这套表：${table.error}`));
  for (const member of table.members) {
    children.push(
      h(
        "div",
        { key: member.name, style: { marginTop: 5 } },
        h("div", { style: { fontWeight: 600, fontSize: 12 } }, member.name),
        ...member.rules.map(ruleLine),
      ),
    );
  }
  if (table.members.length === 0 && table.error === null)
    children.push(emptyLine("这套表没有规则"));
  return card(children, table.title);
}

function mapTacticianBlock(view: TacticianMapView): unknown {
  const children: unknown[] = [
    h("div", { style: { fontWeight: 600 } }, view.name),
    view.writtenAt === "" ? null : emptyLine(`战术官写于 ${clock(view.writtenAt)}`),
    view.walkerNotes === ""
      ? emptyLine("战术官还没写过走法说明")
      : h("div", { style: { marginTop: 4 }, whiteSpace: "pre-wrap" }, `走法：${view.walkerNotes}`),
    view.askUp === ""
      ? null
      : h("div", { style: { marginTop: 2, whiteSpace: "pre-wrap" } }, `建议：${view.askUp}`),
  ];
  if (view.tables.length === 0) children.push(emptyLine(view.tableEmpty));
  for (const table of view.tables) children.push(tacticianTable(table));
  if (view.boss === null) {
    children.push(sectionTitle("首领"), emptyLine(view.bossEmpty));
  } else {
    children.push(
      sectionTitle("首领"),
      h(
        "div",
        { style: { fontSize: 11, opacity: 0.7 } },
        `${view.boss.title} · ${view.boss.atText}`,
      ),
      tacticianTable(view.boss.table),
      h("div", { style: { fontSize: 12, marginTop: 3 } }, view.boss.result),
    );
    if (view.boss.rewrites.length > 0) {
      children.push(
        sectionTitle(`中途重写 ${view.boss.rewrites.length} 次`),
        ...view.boss.rewrites.map((line, index) =>
          h(
            "div",
            { key: `rewrite-${index}`, style: { fontSize: 11, color: toneColor("hard") } },
            line,
          ),
        ),
      );
    }
  }
  return h("div", { style: { marginTop: 6 } }, ...children);
}

function TacticianPanel(): unknown {
  const current = useCurrentGame();
  const poll = usePolling(loadTactician, REFRESH_MS, current.game);
  const view = poll.data;
  const children: unknown[] = [
    panelHeader(
      view?.title ?? `${current.current?.title ?? "FFPR"} 战术官`,
      current.current === null ? null : current.current.running ? "运行中" : "没在运行",
      current.current?.running ?? null,
      () => {
        current.reload();
        poll.reload();
      },
    ),
  ];
  const error = poll.error ?? current.error;
  children.push(errorLine(error));
  if (view === null) {
    if (error === null) children.push(emptyLine("正在读取战术官…"));
    return h("div", { style: PANEL_STYLE }, ...children);
  }
  if (view.message !== null) children.push(emptyLine(view.message));
  if (view.status !== "")
    children.push(h("div", { style: { fontSize: 12, marginTop: 2 } }, view.status));
  children.push(
    view.map === null
      ? card([sectionTitle("当前地图"), emptyLine("还没读到当前地图")])
      : card([sectionTitle("当前地图"), mapTacticianBlock(view.map)]),
    card([
      sectionTitle("叫过战术官"),
      view.calls.length === 0
        ? emptyLine(view.callsEmpty)
        : h(
            "div",
            null,
            ...view.calls.map((call, index) =>
              h(
                "div",
                { key: `call-${index}`, style: { fontSize: 11, marginTop: index === 0 ? 0 : 3 } },
                call.line,
              ),
            ),
          ),
    ]),
  );
  if (view.others.length > 0) {
    children.push(
      h(
        "details",
        { style: { marginTop: 10 } },
        h(
          "summary",
          { style: { cursor: "pointer", fontWeight: 600 } },
          `其他地图(${view.others.length})`,
        ),
        ...view.others.map((other) =>
          h(
            "details",
            { key: other.mapId, style: { marginTop: 4 } },
            h("summary", { style: { cursor: "pointer" } }, other.name),
            mapTacticianBlock(other),
          ),
        ),
      ),
    );
  } else {
    children.push(sectionTitle("其他地图"), emptyLine("还没有其他地图的策略"));
  }
  return h("div", { style: PANEL_STYLE }, ...children);
}

function battleUnitRow(unit: BattleUnitView, key: string): unknown {
  const parts: unknown[] = [h("span", { style: { fontWeight: 600, minWidth: 54 } }, unit.name)];
  if (unit.idText !== "")
    parts.push(h("span", { style: { fontSize: 11, opacity: 0.65 } }, unit.idText));
  parts.push(hpBar(unit));
  parts.push(h("span", { style: { fontSize: 11, minWidth: 54 } }, unit.hpText));
  if (unit.mpText !== "")
    parts.push(h("span", { style: { fontSize: 11, opacity: 0.8 } }, unit.mpText));
  if (unit.statusText !== "")
    parts.push(h("span", { style: { fontSize: 11, color: toneColor("hard") } }, unit.statusText));
  return h(
    "div",
    { key, style: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, marginTop: 2 } },
    ...parts,
  );
}

function turnRows(turn: BattleTurnView, key: string): unknown[] {
  const rows: unknown[] = [
    h("div", { key: `${key}-line`, style: { fontSize: 12 } }, turn.line),
    h("div", { key: `${key}-basis`, style: { fontSize: 11, opacity: 0.65 } }, turn.basis),
  ];
  if (turn.skippedText !== "")
    rows.push(
      h(
        "div",
        { key: `${key}-skip`, style: { fontSize: 11, color: toneColor("skip") } },
        turn.skippedText,
      ),
    );
  return rows;
}

function eventRows(event: BattleEventView, key: string): unknown[] {
  return [
    h(
      "div",
      {
        key,
        style: {
          fontSize: 12,
          color: event.counter ? toneColor("hard") : toneColor("business"),
        },
      },
      event.line,
    ),
  ];
}

function timelineRows(
  turns: readonly BattleTurnView[],
  events: readonly BattleEventView[],
  prefix: string,
): unknown[] {
  const rows: { at: number; node: unknown }[] = [];
  for (const [index, turn] of turns.entries()) {
    const at = Number.parseFloat(turn.atText.replace(" 秒", ""));
    for (const node of turnRows(turn, `${prefix}-turn-${index}`))
      rows.push({ at: Number.isFinite(at) ? at : 0, node });
  }
  for (const [index, event] of events.entries()) {
    const [minutes, seconds] = event.atText.split(":").map(Number);
    const at = (minutes ?? 0) * 60 + (seconds ?? 0);
    for (const node of eventRows(event, `${prefix}-event-${index}`)) rows.push({ at, node });
  }
  rows.sort((left, right) => left.at - right.at);
  return rows.map((row) => row.node);
}

function battleLiveBlock(live: BattleLiveView): unknown {
  const children: unknown[] = [
    sectionTitle("战斗中"),
    h("div", { style: { fontSize: 12, opacity: 0.8 } }, live.title),
    h("div", { style: { marginTop: 4, fontSize: 12, fontWeight: 600 } }, "敌人"),
  ];
  for (const [index, enemy] of live.enemies.entries())
    children.push(battleUnitRow(enemy, `enemy-${index}`));
  children.push(h("div", { style: { marginTop: 4, fontSize: 12, fontWeight: 600 } }, "我方"));
  for (const [index, member] of live.party.entries())
    children.push(battleUnitRow(member, `party-${index}`));
  children.push(sectionTitle("回合"));
  const rows = timelineRows(live.turns, live.events ?? [], "live");
  if (rows.length === 0) children.push(emptyLine("还没有回合"));
  else children.push(...rows);
  return card(children);
}

function BattleHistory(props: {
  readonly game: string;
  readonly recent: readonly BattleSummaryView[];
}): unknown {
  const [selected, setSelected] = React.useState<number | null>(null);
  const [record, setRecord] = React.useState<BattleRecordView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (selected === null) {
      setRecord(null);
      setError(null);
      return undefined;
    }
    setRecord(null);
    setError(null);
    const controller = new AbortController();
    fetchBattleRecord(controller.signal, props.game, selected)
      .then((value) => {
        if (controller.signal.aborted) return;
        setRecord(value);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      controller.abort();
    };
  }, [props.game, selected]);
  const children: unknown[] = [sectionTitle("战斗记录")];
  if (props.recent.length === 0) children.push(emptyLine("还没有战斗记录"));
  for (const item of props.recent) {
    const tone: Tone =
      item.result === "wipe"
        ? "wipe"
        : item.result === "hard"
          ? "hard"
          : item.result === "ok"
            ? "win"
            : "muted";
    children.push(
      h(
        "div",
        {
          key: `summary-${item.id}`,
          onClick: () => {
            setSelected(selected === item.id ? null : item.id);
          },
          style: {
            fontSize: 12,
            marginTop: 3,
            cursor: "pointer",
            color: toneColor(tone),
            textDecoration: selected === item.id ? "underline" : "none",
          },
        },
        item.line,
      ),
    );
  }
  if (selected !== null) {
    if (error !== null) children.push(errorLine(error));
    else if (record === null) children.push(emptyLine("正在读取…"));
    else {
      children.push(
        h("div", { style: { marginTop: 6, fontSize: 12, fontWeight: 600 } }, record.title),
        h("div", { style: { fontSize: 11, opacity: 0.75 } }, `用表：${record.tableText}`),
        h("div", { style: { fontSize: 11, opacity: 0.75 } }, record.summaryText),
        ...timelineRows(record.turns, record.events ?? [], "record"),
        sectionTitle("规则命中"),
      );
      if (record.hits.length === 0) children.push(emptyLine("没有规则命中记录"));
      for (const [index, hit] of record.hits.entries())
        children.push(h("div", { key: `hit-${index}`, style: { fontSize: 12 } }, hit));
    }
  }
  return card(children);
}

function BattlePanel(): unknown {
  const current = useCurrentGame();
  const battles = usePolling(loadBattles, battleInterval, current.game);
  const tactician = usePolling(loadTactician, REFRESH_MS, current.game);
  const children: unknown[] = [
    panelHeader(
      `${current.current?.title ?? "FFPR"} 战斗`,
      current.current === null ? null : current.current.running ? "运行中" : "没在运行",
      current.current?.running ?? null,
      () => {
        current.reload();
        battles.reload();
        tactician.reload();
      },
    ),
  ];
  const error = battles.error ?? current.error;
  children.push(errorLine(error));
  if (battles.data === null) {
    if (error === null) children.push(emptyLine("正在读取战斗记录…"));
  } else {
    if (battles.data.live === null) children.push(emptyLine("现在没在战斗"));
    else children.push(battleLiveBlock(battles.data.live));
    children.push(h(BattleHistory, { game: current.game, recent: battles.data.recent }));
  }
  const map = tactician.data?.map ?? null;
  children.push(sectionTitle("规则命中统计"));
  if (map === null || map.tables.length === 0) {
    children.push(emptyLine("这张地图还没有规则表"));
  } else {
    for (const table of map.tables) {
      children.push(
        h(
          "div",
          { key: table.title, style: { fontSize: 12, marginTop: 3 } },
          h("span", { style: { fontWeight: 600 } }, table.title),
          h("span", { style: { opacity: 0.7, marginLeft: 6 } }, table.recordText),
        ),
      );
      for (const member of table.members) {
        for (const rule of member.rules) {
          children.push(
            h(
              "div",
              {
                key: `${table.title}-${member.name}-${rule.text}`,
                style: { fontSize: 11, marginLeft: 8 },
              },
              `${member.name} ${rule.text} · 触发 ${rule.hits} 次` +
                (rule.skipped ? ` · ${rule.skipText}` : ""),
            ),
          );
        }
      }
    }
  }
  return h("div", { style: PANEL_STYLE }, ...children);
}

function Panel(): unknown {
  const current = useCurrentGame();
  const game = current.game;
  const { data: view, error, at, reload } = usePolling(loadAchievements, REFRESH_MS, game);
  const [onlyMissing, setOnlyMissing] = React.useState<boolean>(
    () => readStorage(ONLY_MISSING_KEY) === "1",
  );
  const [tab, setTab] = React.useState<PanelTab>(() => {
    const saved = readStorage(PANEL_TAB_KEY);
    return saved === "bestiary" || saved === "treasure" ? saved : "achievements";
  });
  const rows = view === null ? [] : onlyMissing ? view.rows.filter((row) => !row.done) : view.rows;
  const children: unknown[] = [
    panelHeader(
      view?.title ?? `${current.current?.title ?? "FFPR"} 成就`,
      current.current === null ? null : current.current.running ? "运行中" : "没在运行",
      current.current?.running ?? null,
      () => {
        current.reload();
        reload();
      },
    ),
  ];
  if (view !== null) {
    for (const line of view.summary) children.push(h("div", { style: { marginTop: 2 } }, line));
  }
  children.push(h("div", { style: { opacity: 0.65, marginTop: 2 } }, `更新于 ${clock(at)}`));
  children.push(errorLine(error ?? current.error));
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
        style: { display: "flex", alignItems: "center", gap: 4, margin: "8px 0 4px", fontSize: 12 },
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
  if (view === null) {
    if (error === null && current.error === null) children.push(emptyLine("正在读取成就…"));
  } else if (tab === "achievements") {
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
  return h("div", { style: PANEL_STYLE }, ...children);
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

function kindLabel(kind: string): string {
  if (kind === "tool") return "AI 操作";
  if (kind === "event") return "事件";
  if (kind === "plan") return "计划";
  if (kind === "link") return "连接";
  if (kind === "warn") return "警告";
  if (kind === "error") return "报错";
  return kind;
}

function kindColor(kind: string): string {
  if (kind === "error") return toneColor("wipe");
  if (kind === "warn") return toneColor("hard");
  if (kind === "event") return toneColor("business");
  if (kind === "plan") return toneColor("business");
  if (kind === "link") return toneColor("muted");
  return "var(--dsw-alias-label-secondary)";
}

function currentCardView(current: CurrentCard): unknown {
  const children: unknown[] = [
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
      h("span", { style: { fontWeight: 600, fontSize: 16 } }, current.title),
      tag(current.statusText, current.running ? "win" : "muted"),
    ),
  ];
  const bridge = current.bridge;
  children.push(
    h(
      "div",
      { style: { fontSize: 12, marginTop: 4 } },
      `桥插件 ${bridge.version ?? "版本未知"} · ${bridge.connected ? "已连接" : "没连上"}` +
        (bridge.atb === null ? "" : ` · ATB ${bridge.atb}`),
    ),
  );
  const where = [
    current.place.mapId === null ? "" : `地图 ${current.place.mapId}`,
    current.place.name,
  ]
    .filter((part) => part !== "")
    .join(" ");
  children.push(h("div", { style: { fontSize: 12 } }, `地点 ${where === "" ? "未知" : where}`));
  if (current.party.length === 0) {
    children.push(emptyLine(current.running ? "还没读到队伍" : "没在运行，队伍数据是上次看到的"));
  }
  for (const [index, member] of current.party.entries()) {
    children.push(
      h(
        "div",
        {
          key: `${member.name}-${index}`,
          style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 3 },
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
        h("span", { style: { width: 54, flex: "none", opacity: 0.75 } }, member.job),
        h(
          "span",
          { style: { width: 34, flex: "none", opacity: 0.7 } },
          member.level === null ? "" : `Lv${member.level}`,
        ),
        h(
          "span",
          { style: { fontVariantNumeric: "tabular-nums", flex: "none", width: 78 } },
          `HP ${member.hp}/${member.maxHp}`,
        ),
        hpBar(member),
        h(
          "span",
          { style: { fontVariantNumeric: "tabular-nums", flex: "none", opacity: 0.8 } },
          member.mp === null
            ? ""
            : `MP ${member.mp}${member.maxMp === null ? "" : `/${member.maxMp}`}`,
        ),
      ),
    );
  }
  children.push(
    h(
      "div",
      { style: { fontSize: 12, marginTop: 5 } },
      `金钱 ${current.gil === null ? "未知" : String(current.gil)} · 存档 ${current.saveCount === null ? "未知" : `${current.saveCount} 次`} · 存档位 ${current.saveSlot}`,
    ),
  );
  if (current.busy !== null) {
    children.push(
      h(
        "div",
        { style: { fontSize: 12 } },
        `AI 正在 ${current.busy.name}（${busySeconds(current.busy.at)} 秒）`,
      ),
    );
  } else if (current.last !== null) {
    children.push(
      h(
        "div",
        { style: { fontSize: 12, opacity: 0.7 } },
        `最后活动：${current.last.text} · ${ago(current.last.at)}`,
      ),
    );
  } else {
    children.push(emptyLine("AI 还没做什么"));
  }
  if (!current.running) {
    const known =
      current.lastKnownAt === null
        ? "没有上次看到的数据"
        : `数据显示的是 ${clock(current.lastKnownAt)} 的样子`;
    children.push(h("div", { style: { fontSize: 11, opacity: 0.65, marginTop: 2 } }, known));
  }
  return h("div", { style: { ...CARD_STYLE, opacity: current.running ? 1 : 0.72 } }, ...children);
}

function walkSegmentsClient(
  path: readonly (readonly [number, number])[],
): readonly { readonly from: readonly [number, number]; readonly to: readonly [number, number] }[] {
  if (path.length === 0) return [];
  const out: { from: readonly [number, number]; to: readonly [number, number] }[] = [];
  let from = path[0] ?? [0, 0];
  for (let i = 1; i < path.length; i++) {
    const before = path[i - 1];
    const cell = path[i];
    if (before === undefined || cell === undefined) continue;
    const next = path[i + 1];
    const beforeStep = `${cell[0] - before[0]},${cell[1] - before[1]}`;
    const nextStep = next === undefined ? "" : `${next[0] - cell[0]},${next[1] - cell[1]}`;
    if (next === undefined || beforeStep !== nextStep) {
      out.push({ from, to: cell });
      from = cell;
    }
  }
  return out;
}

function walkCellColor(char: string): string | null {
  if (char === "#") return "rgba(128, 128, 128, 0.35)";
  if (char === "~") return "rgba(64, 112, 190, 0.35)";
  if (char === "^") return "rgba(150, 120, 90, 0.45)";
  if (char === '"') return "rgba(80, 140, 80, 0.20)";
  return null;
}

interface WalkBaseRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fill: string;
}

/** The cropped base changes only with the plan, not with progress: keep a few grids. */
const WALK_BASE_CACHE = new Map<string, readonly WalkBaseRect[]>();
const WALK_BASE_CACHE_LIMIT = 8;

function walkBaseRects(view: WalkView): readonly WalkBaseRect[] {
  const key = `${view.map ?? "?"}|${view.origin[0]},${view.origin[1]}|${view.rows.join("\n")}`;
  const cached = WALK_BASE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const rects: WalkBaseRect[] = [];
  for (let y = 0; y < view.rows.length; y++) {
    const row = view.rows[y] ?? "";
    let start = 0;
    let color: string | null = null;
    const flush = (end: number): void => {
      if (color !== null && end > start) {
        rects.push({ x: start, y, width: end - start, fill: color });
      }
    };
    for (let x = 0; x < row.length; x++) {
      const next = walkCellColor(row[x] ?? " ");
      if (next === color) continue;
      flush(x);
      start = x;
      color = next;
    }
    flush(row.length);
  }
  if (WALK_BASE_CACHE.size >= WALK_BASE_CACHE_LIMIT) {
    const oldest = WALK_BASE_CACHE.keys().next();
    if (!oldest.done) WALK_BASE_CACHE.delete(oldest.value);
  }
  WALK_BASE_CACHE.set(key, rects);
  return rects;
}

function walkSvg(view: WalkView): unknown {
  const width = Math.max(1, view.rows[0]?.length ?? 0);
  const height = Math.max(1, view.rows.length);
  const originX = view.origin[0];
  const originY = view.origin[1];
  const centerX = (x: number): number => x - originX + 0.5;
  const centerY = (y: number): number => y - originY + 0.5;
  const pieces: unknown[] = [
    h("rect", {
      key: "floor",
      x: 0,
      y: 0,
      width,
      height,
      fill: "rgba(128, 128, 128, 0.08)",
    }),
  ];
  for (const rect of walkBaseRects(view)) {
    pieces.push(
      h("rect", {
        key: `base-${rect.x}-${rect.y}-${rect.width}`,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: 1,
        fill: rect.fill,
      }),
    );
  }
  const segments = walkSegmentsClient(view.path);
  const current = view.segment.n;
  for (const [index, segment] of segments.entries()) {
    const n = index + 1;
    const walked = n < current;
    const walking = n === current;
    pieces.push(
      h("polyline", {
        key: `route-${n}`,
        points: `${centerX(segment.from[0])},${centerY(segment.from[1])} ${centerX(
          segment.to[0],
        )},${centerY(segment.to[1])}`,
        fill: "none",
        stroke: walked
          ? "var(--dsw-alias-label-tertiary)"
          : "var(--dsw-alias-state-business-primary)",
        strokeWidth: walking ? 0.34 : 0.14,
        strokeDasharray: walking ? undefined : walked ? "0.16 0.3" : "0.3 0.28",
        strokeLinecap: "round",
        opacity: walked ? 0.85 : 1,
      }),
    );
  }
  pieces.push(
    h("circle", {
      key: "person",
      cx: centerX(view.cell[0]),
      cy: centerY(view.cell[1]),
      r: 0.36,
      fill: "var(--dsw-alias-state-business-primary)",
      stroke: "none",
    }),
    h("circle", {
      key: "goal",
      cx: centerX(view.goal[0]),
      cy: centerY(view.goal[1]),
      r: 0.38,
      fill: "none",
      stroke: "var(--dsw-alias-state-success-primary)",
      strokeWidth: 0.18,
    }),
  );
  return h(
    "svg",
    {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "xMidYMid meet",
      style: {
        display: "block",
        width: "100%",
        maxWidth: 520,
        aspectRatio: `${width} / ${height}`,
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        background: "rgba(128, 128, 128, 0.08)",
      },
      "aria-label": "走路路线",
    },
    ...pieces,
  );
}

function walkTone(view: WalkView): Tone {
  if (view.endedAt === null || view.reason === "arrived") return "win";
  if (
    view.reason === "blocked" ||
    view.reason === "off_path" ||
    view.reason === "timeout" ||
    view.reason === "closed" ||
    view.reason === "bad_path" ||
    view.reason === "no_player"
  ) {
    return "wipe";
  }
  return "hard";
}

function walkCardView(view: WalkView): unknown {
  const display = view.display;
  const status = display?.statusText ?? (view.endedAt === null ? "正在走" : "停止");
  const lines: unknown[] = [];
  if (display !== undefined) {
    lines.push(
      h("div", { style: { opacity: 0.75 } }, display.mapText),
      h("div", { style: { marginTop: 2 } }, display.segmentText),
      h("div", { style: { marginTop: 2 } }, display.progressText),
      h("div", { style: { marginTop: 2 } }, display.elapsedText),
    );
  }
  return h(
    "div",
    { style: CARD_STYLE },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("div", { style: { flex: 1, minWidth: 160, fontSize: 13, fontWeight: 600 } }, view.label),
      tag(status, walkTone(view)),
    ),
    h(
      "div",
      {
        style: {
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          flexWrap: "wrap",
          marginTop: 6,
        },
      },
      h("div", { style: { flex: "1 1 240px", minWidth: 180 } }, walkSvg(view)),
      h("div", { style: { flex: "0 1 220px", fontSize: 12, lineHeight: 1.5 } }, ...lines),
    ),
  );
}

function OverviewPage(): unknown {
  const current = useCurrentGame();
  const [paused, setPaused] = React.useState(false);
  const poll = usePolling(loadOverview, OVERVIEW_REFRESH_MS, current.game, paused);
  const walk = usePolling(loadWalk, walkInterval, current.game, paused);
  const reply = poll.data;
  const children: unknown[] = [
    h(
      "div",
      {
        style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, paddingTop: 28 },
      },
      h("div", { style: { flex: 1, fontSize: 20, fontWeight: 500 } }, "FFPR 总控"),
      h(
        "div",
        { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } },
        `更新于 ${clock(poll.at || current.at)}`,
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
    errorLine(poll.error ?? current.error),
  ];
  if (reply?.current !== null && reply?.current !== undefined) {
    children.push(currentCardView(reply.current));
  } else if (poll.error === null) {
    children.push(emptyLine("还没找到当前作品"));
  }
  children.push(sectionTitle("走路"));
  const walkView = walk.data?.view ?? null;
  if (walkView !== null) {
    children.push(walkCardView(walkView));
  } else {
    children.push(emptyLine(walk.error ?? "还没有走路记录"));
  }
  children.push(sectionTitle("这一作的日志"));
  const log = reply?.log ?? [];
  if (log.length === 0) {
    children.push(emptyLine("还没有日志"));
  } else {
    for (const [index, entry] of log.entries()) {
      children.push(
        h(
          "div",
          {
            key: `${entry.at}-${entry.kind}-${index}`,
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
          h(
            "span",
            { style: { flex: "none", color: kindColor(entry.kind), fontWeight: 600 } },
            kindLabel(entry.kind),
          ),
          h("span", { style: { overflowWrap: "anywhere" } }, entry.text),
        ),
      );
    }
  }
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
    ...children,
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
  const tabs = [
    {
      id: PLAYER_TAB_ID,
      kind: PLAYER_KIND,
      title: "① 玩家",
      description: "目标、AI 现在在做什么、笔记和最近的决定",
      order: 70,
      panel: PlayerPanel,
    },
    {
      id: TACTICS_TAB_ID,
      kind: TACTICS_KIND,
      title: "② 战术官",
      description: "当前地图的走法、规则表、首领表和叫过战术官的记录",
      order: 71,
      panel: TacticianPanel,
    },
    {
      id: BATTLE_TAB_ID,
      kind: BATTLE_KIND,
      title: "③ 战斗",
      description: "战斗中的回合、最近战斗和规则命中统计",
      order: 72,
      panel: BattlePanel,
    },
    {
      id: TAB_ID,
      kind: TAB_KIND,
      title: "成就",
      description: "当前存档的成就和宝箱进度",
      order: 73,
      panel: Panel,
    },
  ] as const;
  for (const tab of tabs) {
    ctx.effect(
      () =>
        ctx.sidebarRightTabs.register({
          id: tab.id,
          kind: tab.kind,
          title: () => tab.title,
          guide: [
            {
              id: "open",
              order: tab.order,
              title: () => tab.title,
              description: () => tab.description,
            },
          ],
        }),
      `ffpr: ${tab.kind} tab`,
    );
    ctx.slots.inject("sidebar.right.pane.tab", () =>
      ctx.slots.register({ name: "sidebar.right.pane.tab", key: tab.id }, tab.panel),
    );
  }
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
  startAutoOpen(ctx, PLAYER_KIND, PLAYER_OPENED_PREFIX);
  startAutoOpen(ctx, TACTICS_KIND, TACTICS_OPENED_PREFIX);
  startAutoOpen(ctx, BATTLE_KIND, BATTLE_OPENED_PREFIX);
  startAutoOpen(ctx, TAB_KIND, OPENED_PREFIX);
}
exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
exports.apply = apply;

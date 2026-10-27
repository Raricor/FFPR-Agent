"""achievements.db: the recorder is its only writer (design §13.4).

Two layers are kept apart. `unlock` is the Steam account layer and only ever grows.
`progress` is the per-save layer and follows reloads. v0 writes only the account layer.
"""

import sqlite3
from pathlib import Path

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE achievement_def (
    app_id      INTEGER NOT NULL,
    api_name    TEXT    NOT NULL,
    ord         INTEGER NOT NULL,
    name_zh     TEXT    NOT NULL DEFAULT '',
    desc_zh     TEXT    NOT NULL DEFAULT '',
    name_en     TEXT    NOT NULL DEFAULT '',
    desc_en     TEXT    NOT NULL DEFAULT '',
    hidden      INTEGER NOT NULL DEFAULT 0,
    category    TEXT    NOT NULL,
    kb_id       TEXT,
    target      REAL,
    updated_at  TEXT    NOT NULL,
    PRIMARY KEY (app_id, api_name)
);

CREATE TABLE unlock (
    app_id         INTEGER NOT NULL,
    api_name       TEXT    NOT NULL,
    unlocked_at    TEXT,
    first_seen_at  TEXT    NOT NULL,
    source         TEXT    NOT NULL CHECK (source IN ('steam_api', 'bridge')),
    controller     TEXT    NOT NULL DEFAULT 'unknown'
                           CHECK (controller IN ('agent', 'human', 'unknown')),
    run_id         TEXT,
    save_line      TEXT,
    PRIMARY KEY (app_id, api_name)
);

CREATE TABLE save_line (
    id          TEXT    PRIMARY KEY,
    app_id      INTEGER NOT NULL,
    created_at  TEXT    NOT NULL,
    parent      TEXT,
    note        TEXT
);

CREATE TABLE progress (
    app_id     INTEGER NOT NULL,
    api_name   TEXT    NOT NULL,
    save_line  TEXT    NOT NULL,
    ts         TEXT    NOT NULL,
    current    REAL    NOT NULL,
    target     REAL    NOT NULL
);
CREATE INDEX progress_latest ON progress (app_id, api_name, save_line, ts);

CREATE TABLE anomaly (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id    INTEGER NOT NULL,
    api_name  TEXT    NOT NULL,
    ts        TEXT    NOT NULL,
    type      TEXT    NOT NULL,
    detail    TEXT    NOT NULL DEFAULT '',
    resolved  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_log (
    app_id        INTEGER PRIMARY KEY,
    synced_at     TEXT    NOT NULL,
    player_error  TEXT
);
"""


def connect(path: Path | str) -> sqlite3.Connection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version == 0:
        conn.executescript(SCHEMA)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    elif version != SCHEMA_VERSION:
        conn.close()
        raise RuntimeError(f"{path} 的结构版本是 {version},本程序只认 {SCHEMA_VERSION}")
    return conn


def upsert_def(
    conn: sqlite3.Connection,
    *,
    app_id: int,
    api_name: str,
    ord: int,
    name_zh: str,
    desc_zh: str,
    name_en: str,
    desc_en: str,
    hidden: bool,
    category: str,
    now: str,
) -> None:
    conn.execute(
        """
        INSERT INTO achievement_def
            (app_id, api_name, ord, name_zh, desc_zh, name_en, desc_en, hidden, category,
             updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (app_id, api_name) DO UPDATE SET
            ord = excluded.ord, name_zh = excluded.name_zh, desc_zh = excluded.desc_zh,
            name_en = excluded.name_en, desc_en = excluded.desc_en, hidden = excluded.hidden,
            category = excluded.category, updated_at = excluded.updated_at
        """,
        (app_id, api_name, ord, name_zh, desc_zh, name_en, desc_en, int(hidden), category, now),
    )


def record_unlock(
    conn: sqlite3.Connection,
    *,
    app_id: int,
    api_name: str,
    unlocked_at: str | None,
    source: str,
    now: str,
    controller: str = "unknown",
) -> bool:
    """Insert an unlock if it is new; never delete or overwrite one. Returns True if new."""
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO unlock
            (app_id, api_name, unlocked_at, first_seen_at, source, controller)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (app_id, api_name, unlocked_at, now, source, controller),
    )
    if cur.rowcount:
        return True
    if unlocked_at:
        conn.execute(
            "UPDATE unlock SET unlocked_at = ? "
            "WHERE app_id = ? AND api_name = ? AND unlocked_at IS NULL",
            (unlocked_at, app_id, api_name),
        )
    return False


def record_sync(
    conn: sqlite3.Connection, *, app_id: int, now: str, player_error: str | None
) -> None:
    conn.execute(
        """
        INSERT INTO sync_log (app_id, synced_at, player_error) VALUES (?, ?, ?)
        ON CONFLICT (app_id) DO UPDATE SET
            synced_at = excluded.synced_at, player_error = excluded.player_error
        """,
        (app_id, now, player_error),
    )


def game_summary(conn: sqlite3.Connection, app_id: int) -> sqlite3.Row:
    return conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM achievement_def WHERE app_id = :a) AS total,
            (SELECT COUNT(*) FROM unlock WHERE app_id = :a) AS unlocked,
            (SELECT synced_at FROM sync_log WHERE app_id = :a) AS synced_at,
            (SELECT player_error FROM sync_log WHERE app_id = :a) AS player_error
        """,
        {"a": app_id},
    ).fetchone()


def game_rows(conn: sqlite3.Connection, app_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT d.*, u.unlocked_at, u.first_seen_at, u.controller,
               u.api_name IS NOT NULL AS unlocked
        FROM achievement_def d
        LEFT JOIN unlock u ON u.app_id = d.app_id AND u.api_name = d.api_name
        WHERE d.app_id = ?
        ORDER BY d.ord
        """,
        (app_id,),
    ).fetchall()

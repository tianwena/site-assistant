-- 助手后端（Cloudflare Worker 版）的 D1 表结构。字段与 assistant/store.py 的 SQLite 版一致，
-- 另加 RATE_HIT（Worker 多实例并行，限流计数不能放进程内存，只能放库里）。
-- 没有外键：Worker 版的额度预留靠「单条带条件的 INSERT」保证原子，
-- 用户消息会先于会话行落库，外键会挡住这个顺序。
CREATE TABLE IF NOT EXISTS CONVERSATION (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    last_at     TEXT NOT NULL,
    rounds      INTEGER NOT NULL DEFAULT 0,
    ip_hash     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS MESSAGE (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    tokens          INTEGER NOT NULL DEFAULT 0,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cached_tokens   INTEGER NOT NULL DEFAULT 0,
    cost            REAL NOT NULL DEFAULT 0,
    day             TEXT NOT NULL DEFAULT '',
    ip_hash         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_message_conv ON MESSAGE(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_day_ip ON MESSAGE(day, ip_hash);

CREATE TABLE IF NOT EXISTS DAILY_QUOTA (
    day           TEXT PRIMARY KEY,
    used_cost     REAL NOT NULL DEFAULT 0,
    calls         INTEGER NOT NULL DEFAULT 0,
    blocked       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS RATE_HIT (
    ip_hash  TEXT NOT NULL,
    at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_ip_at ON RATE_HIT(ip_hash, at);

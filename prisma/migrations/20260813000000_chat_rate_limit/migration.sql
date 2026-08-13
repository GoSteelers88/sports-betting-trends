-- ChatRateLimit — durable per-caller abuse counters for "The Sharp" public
-- chatbot (POST /api/chat), replacing the in-process Maps in src/lib/chat/guards.ts.
--
-- Why: in-process windows are per-lambda and reset on every cold start, so the
-- per-session and per-IP caps were effectively unenforceable in production. This
-- table makes them shared across instances and durable across cold starts.
--
-- One row per (scope, key, UTC day). The composite primary key is what makes the
-- upsert-with-increment atomic, so check-and-increment is a single operation.
--
-- Purely additive: new table, no FKs, no impact on existing rows. Safe to deploy
-- ahead of the route code (the chat guards are the only reader/writer).
CREATE TABLE "ChatRateLimit" (
    "scope"     TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "utcDate"   TEXT NOT NULL,
    "count"     INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("scope", "key", "utcDate")
);

-- Supports the daily sweep that prunes rows older than the retention window.
CREATE INDEX "ChatRateLimit_utcDate_idx" ON "ChatRateLimit"("utcDate");

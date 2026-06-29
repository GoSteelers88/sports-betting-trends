-- ChatSpendCounter — GLOBAL daily spend governor for "The Sharp" public
-- chatbot (POST /api/chat). One row per UTC date is the source of truth for the
-- day's Anthropic token budget, shared across every serverless instance.
--
-- Purely additive: a new table with no FKs and no impact on existing rows. Safe
-- to deploy ahead of the route code (the route is the only reader/writer).
CREATE TABLE "ChatSpendCounter" (
    "utcDate"    TEXT NOT NULL PRIMARY KEY,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt"  DATETIME NOT NULL
);

-- CLV closing-window correctness.
--
-- Problem: the original tracker captured clvCents on the FIRST sweep that saw a
-- pick in the [10, 90]-minute pre-tip window and then never revisited it (the
-- query filters `clvCents IS NULL`). With sweeps every 20 min, a pick first seen
-- ~85 min before tip froze an OPENING-ish line as the "closing" line. Empirically
-- the live trial captured CLV a median of 51 min before tip (one case 28 min AFTER
-- tip, an in-play price). CLV is the funding gate, so this silently corrupts the
-- crown-jewel metric.
--
-- Fix: separate the "best-so-far pre-tip reading" from the "finalized closing
-- value". We keep re-reading each pick on every sweep, always overwriting with the
-- reading CLOSEST to tip, and only mark CLV final once the pick has gone in-play
-- (now >= gameDate) or a sweep ran inside the tight closing window. The two new
-- columns make that decision explicit and idempotent.

-- Minutes-before-tip at which the current clvCents reading was taken. NULL until
-- the first valid pre-tip reading. A later sweep only overwrites clvCents if it
-- is closer to tip (smaller positive value) than this.
ALTER TABLE "AgentPick" ADD COLUMN "clvReadingMinutesBeforeTip" INTEGER;

-- Once true, clvCents is frozen (pick went in-play or hit the tight closing
-- window). The capture query skips finalized rows; non-finalized rows with a
-- reading are still eligible for a closer-to-tip overwrite.
ALTER TABLE "AgentPick" ADD COLUMN "clvFinal" BOOLEAN NOT NULL DEFAULT 0;

-- Backfill: existing captured rows are grandfathered as final (we cannot
-- retroactively re-read their closing lines), but flag the ones captured far
-- from tip so the dashboard/trial-status can optionally exclude them. We mark
-- everything already captured as final to preserve current behavior; the
-- distance column stays NULL for legacy rows (unknown reading distance).
UPDATE "AgentPick" SET "clvFinal" = 1 WHERE "clvCents" IS NOT NULL;

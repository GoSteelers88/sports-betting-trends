"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ASK THE DESK — "The Sharp's" public chat, set in the same ink-on-bone ledger
// skin as the rest of the page. Not a cute SaaS bubble: a column you consult.
//
// The Sharp is the Billy-Walters archetype — CLV-obsessed, value-over-action,
// will tell you to PASS (and the pass reads in red, deliberately, because the
// pass IS the product). This component is presentational + wires the fetch
// against the DONE backend at POST /api/chat. It owns the transcript in client
// state and ships the recent turns back as `history` on every send.
//
// Backend contract:
//   POST /api/chat   body {message, history?:[{role,content}]}   (4KB cap)
//   200 -> {reply, lane:"A"|"B", closed?, closedReason?, intercepted?, toolsUsed?}
//   413 body too large · 400 bad message · 429 rate-limited (reply still set,
//   closedReason distinguishes recoverable "cookieless" from real caps)
//   500 in-character error.  Session cookie comes from GET /api/chat/session
//   (fetched on first open); credentials same-origin. Non-streaming. Lane "B"
//   does live analysis and is SLOW (30-90s on a fat slate) — the consulting
//   state escalates its copy with elapsed time, and the fetch aborts at 90s
//   with an in-character timeout line.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";

type Role = "user" | "assistant";

type ClosedReason = "cookieless" | "session" | "ip" | "budget";

type Turn = {
  role: Role;
  content: string;
  // Server-side metadata that recolors / reframes an assistant turn. Never sent
  // back in history (the contract's history items are {role, content} only).
  closed?: boolean;
  intercepted?: "distress" | "injection" | "out_of_scope";
  toolsUsed?: string[];
  // A purely client-side failure (network drop / timeout) — rendered
  // in-character but not a real desk reply.
  dropped?: boolean;
};

// How many prior turns we echo back as `history`. Keeps the 4KB body honest.
const HISTORY_TURNS = 10;

// Client-side wall clock on the fetch. The server allows 120s; we cut at 90s
// with an in-character line rather than let the user watch a spinner forever.
const FETCH_TIMEOUT_MS = 90_000;

const STARTERS = [
  "What's tonight's best play?",
  "Talk me out of a bet",
  "Why no pick on a game?",
] as const;

// A rotating "the desk is pulling files" line for the wait state — reads like a
// quant desk consulting its own ledger, not a generic spinner. These are
// FLAVOR: they only start after a few seconds (Lane A returns before that, and
// claiming "pulling the closing lines" on a persona turn would be a lie), and
// they are aria-hidden — the screen-reader announcement is the single status
// line, not this ticker.
const CONSULTING_LINES = [
  "Pulling the closing lines…",
  "Cross-checking the injury wire…",
  "De-vigging the market…",
  "Reading the model vs the number…",
  "Measuring the edge against the vig…",
  "Checking who moved the line…",
] as const;

// Pretty-print a tool key the backend reports in toolsUsed.
const TOOL_LABELS: Record<string, string> = {
  get_odds: "closing odds",
  get_model_probabilities: "win-prob model",
  get_injuries: "injury wire",
  get_player_props: "prop lines",
  get_trend_summary: "trends",
  get_mlb_signals: "pitching signals",
};
const toolLabel = (k: string): string => TOOL_LABELS[k] ?? k.replace(/_/g, " ");

// Scroll the page to the main board content behind the panel. The chat must
// never be a dead end — the site's receipts (picks, CLV record) are the
// conversion target from every exit state.
function goToBoard(close: () => void) {
  close();
  requestAnimationFrame(() => {
    document
      .querySelector("main")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

export function AskTheDesk() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  // Why the desk closed, when it has. "cookieless" is recoverable (a reload
  // re-fetches the session cookie) and deliberately does NOT close the desk UI.
  const [closedReason, setClosedReason] = useState<ClosedReason | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const deskClosed = closedReason !== null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  // Coarse-pointer (touch) devices: Enter inserts a newline, Send button sends.
  const coarsePointer = useRef(false);
  // Guards against re-requesting a session cookie on every open/close cycle.
  const sessionRequested = useRef(false);
  // Single SR status line (persistent live region — see render).
  const [srStatus, setSrStatus] = useState("");

  // Close + restore focus to the launcher (a11y: focus must not fall to body).
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  }, []);

  useEffect(() => {
    coarsePointer.current = window.matchMedia("(pointer: coarse)").matches;
  }, []);

  // Ask the server for a session cookie the first time the desk is opened.
  // The backend never mints an identity inline on POST — a cookieless POST is
  // charged against a small per-IP budget. Requesting the cookie here, on open,
  // means a real visitor has one before their first question. Failure is
  // non-fatal: the first few POSTs work under the cookieless budget and the
  // route attaches a cookie to its response.
  useEffect(() => {
    if (!open || sessionRequested.current) return;
    sessionRequested.current = true;
    void fetch("/api/chat/session", { credentials: "same-origin" }).catch(() => {
      /* non-fatal — see above */
    });
  }, [open]);

  // Keep the transcript pinned to the latest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, pending]);

  // Focus the input when the desk opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Esc closes the panel (and restores focus via close()).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Focus trap: aria-modal promises the background is inert — keep Tab inside
  // the panel so that promise is true for keyboard users too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || pending || deskClosed) return;

      setDraft("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      // Optimistically push the user turn; snapshot history BEFORE it for the body.
      const priorHistory = turns
        .slice(-HISTORY_TURNS)
        .map((t) => ({ role: t.role, content: t.content }));
      setTurns((prev) => [...prev, { role: "user", content: message }]);
      setPending(true);
      setSrStatus("The desk is reading your question.");

      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          signal: ctrl.signal,
          body: JSON.stringify({ message, history: priorHistory }),
        });

        // Every documented status (200/400/413/429/500) returns an in-character
        // JSON `reply`. Parse defensively in case a proxy returns non-JSON.
        let data: {
          reply?: string;
          lane?: "A" | "B";
          closed?: boolean;
          closedReason?: ClosedReason;
          intercepted?: Turn["intercepted"];
          toolsUsed?: string[];
        } = {};
        try {
          data = await res.json();
        } catch {
          /* fall through to the in-character fallback below */
        }

        const reply =
          data.reply?.trim() ||
          (res.status === 413
            ? "That ran long. Trim it down and ask me again."
            : res.status === 400
              ? "Didn't catch that. Give me a real question."
              : "The desk hit a snag. Try me again in a minute.");

        const closed = data.closed === true || res.status === 429;
        if (closed) {
          const reason: ClosedReason = data.closedReason ?? "budget";
          if (reason === "cookieless") {
            // Recoverable: the session-cookie fetch failed (privacy browser,
            // blocked cookie). A reload fixes it — do NOT declare the desk
            // closed for the night; that would contradict the reply itself.
            setNeedsReload(true);
          } else {
            setClosedReason(reason);
          }
          setSrStatus("The desk has stopped taking questions.");
        } else {
          setSrStatus("");
        }

        setTurns((prev) => [
          ...prev,
          {
            role: "assistant",
            content: reply,
            closed,
            intercepted: data.intercepted,
            toolsUsed: data.toolsUsed,
          },
        ]);
      } catch (err) {
        const timedOut = err instanceof DOMException && err.name === "AbortError";
        setSrStatus("");
        setTurns((prev) => [
          ...prev,
          {
            role: "assistant",
            content: timedOut
              ? "That read ran long and I won't rush a number. Ask me again — a specific game reads faster than the whole board."
              : "The desk dropped — line went quiet. Try that again.",
            dropped: true,
          },
        ]);
      } finally {
        clearTimeout(timeout);
        setPending(false);
        // Return focus to the input unless the desk closed for the night.
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    },
    [pending, deskClosed, turns],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends on fine-pointer devices; Shift+Enter is a newline. On touch
    // devices Enter is a newline (mobile keyboards have no Shift+Enter) and
    // the Send button is the send affordance.
    if (e.key === "Enter" && !e.shiftKey && !coarsePointer.current) {
      e.preventDefault();
      void send(draft);
    }
  };

  // Auto-grow the textarea with the draft, capped by max-h-28.
  const onDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  };

  return (
    <>
      {/* ── 1. CLOSED AFFORDANCE — a restrained tab, bottom-right. No orb. ──── */}
      {!open && (
        <button
          ref={launcherRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ask the desk — chat with The Sharp"
          className="fixed bottom-4 right-4 z-[9995] group flex items-center gap-2 bg-paper-2 px-3.5 py-2.5 cursor-pointer transition-colors hover:bg-paper-3"
          style={{ border: "1px solid var(--rule-strong)", boxShadow: "0 6px 20px rgba(31,27,22,0.14)" }}
        >
          <span
            className="dot dot-pulse"
            style={{ color: "var(--win)" }}
            aria-hidden
          />
          <span className="flex flex-col items-start leading-none">
            <span className="eyebrow text-ink-3" style={{ fontSize: "0.55rem" }}>
              The Sharp
            </span>
            <span className="font-display font-semibold text-sm text-ink mt-0.5">
              Ask the desk
            </span>
          </span>
        </button>
      )}

      {/* ── 2. OPEN PANEL ─────────────────────────────────────────────────── */}
      {open && (
        <div
          className="fixed inset-0 z-[9995] sm:inset-auto sm:bottom-4 sm:right-4 flex"
          role="dialog"
          aria-modal="true"
          aria-label="The Sharp — ask the desk"
        >
          {/* Scrim on mobile only (panel is full-screen there). */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={close}
            className="absolute inset-0 bg-ink/10 sm:hidden cursor-default"
            style={{ backdropFilter: "blur(1px)" }}
          />

          <div
            ref={panelRef}
            className="relative z-10 flex flex-col w-full h-[100dvh] sm:h-auto sm:w-[420px] sm:max-h-[82vh] bg-paper"
            style={{
              border: "1px solid var(--rule-strong)",
              boxShadow: "0 18px 60px rgba(31,27,22,0.22)",
              animation: "sheet-rise 200ms ease-out both",
            }}
          >
            {/* Persistent SR status line — announces send/closed transitions.
                The rotating consulting flavor is aria-hidden; this is the one
                voice assistive tech hears for state changes. */}
            <div aria-live="polite" className="sr-only">
              {srStatus}
            </div>

            {/* Header — masthead + persistent RG line. */}
            <header
              className="shrink-0 bg-paper-2 px-4 py-3"
              style={{ borderBottom: "3px double var(--rule-strong)" }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="folio" aria-hidden>
                      THE DESK
                    </span>
                    <span className="dot dot-pulse" style={{ color: "var(--win)" }} aria-hidden />
                  </div>
                  <h2 className="font-display font-black text-xl text-ink leading-none mt-1">
                    The Sharp<span style={{ color: "var(--loss)" }}>.</span>
                  </h2>
                  <p className="eyebrow text-ink-3 mt-1" style={{ letterSpacing: "0.14em" }}>
                    Value over action · CLV is the only score
                  </p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close the desk"
                  className="shrink-0 num text-ink-3 hover:text-loss transition-colors text-lg leading-none px-1 cursor-pointer"
                >
                  ✕
                </button>
              </div>

              {/* Persistent, non-dismissible responsible-gambling line. */}
              <p
                className="eyebrow text-ink-3 mt-2.5 pt-2 leading-relaxed"
                style={{ borderTop: "1px solid var(--rule)", fontSize: "0.55rem", letterSpacing: "0.12em" }}
              >
                Informational only · 21+ · Gambling problem? Call 1-800-GAMBLER
              </p>
            </header>

            {/* Transcript — role="log" announces appended assistant turns. */}
            <div
              ref={scrollRef}
              role="log"
              aria-live="polite"
              aria-label="Conversation with The Sharp"
              className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-4"
              style={{ scrollbarWidth: "thin" }}
            >
              {turns.length === 0 && <Intro />}

              {turns.map((t, i) =>
                t.role === "user" ? (
                  <UserBubble key={i} text={t.content} />
                ) : (
                  <SharpReply key={i} turn={t} />
                ),
              )}

              {/* ── 3. THINKING STATE — the desk pulling files. ─────────────── */}
              {pending && <Consulting />}
            </div>

            {/* Starter chips — only before the first question. */}
            {turns.length === 0 && !deskClosed && (
              <div className="shrink-0 px-4 pb-3">
                <div className="flex flex-wrap gap-1.5">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      disabled={pending}
                      className="num text-[0.7rem] text-ink-2 px-2.5 py-1.5 bg-paper-2 hover:bg-paper-3 transition-colors cursor-pointer disabled:opacity-50"
                      style={{ border: "1px solid var(--rule)" }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <p className="eyebrow text-ink-3 mt-1.5" style={{ fontSize: "0.52rem", letterSpacing: "0.1em" }}>
                  Board questions run a live pull — give it ~30s
                </p>
              </div>
            )}

            {/* ── 5. EXIT STATES: reload nudge, desk-closed note, or the input. ── */}
            {needsReload ? (
              <div
                className="shrink-0 px-4 py-3 bg-paper-3"
                style={{ borderTop: "1px solid var(--rule)" }}
              >
                <p className="text-[0.78rem] text-ink-2 text-center leading-relaxed">
                  The desk lost track of your seat — usually a blocked cookie.
                </p>
                <button
                  type="button"
                  onClick={() => location.reload()}
                  className="block mx-auto mt-2 eyebrow px-3 py-1.5 cursor-pointer"
                  style={{ color: "var(--paper)", background: "var(--ink)" }}
                >
                  Reload the desk
                </button>
              </div>
            ) : deskClosed ? (
              <div
                className="shrink-0 px-4 py-3 bg-paper-3"
                style={{ borderTop: "1px solid var(--rule)" }}
              >
                <p className="eyebrow text-center" style={{ color: "var(--loss)" }}>
                  {closedReason === "session"
                    ? "This session's run its course"
                    : "The desk is closed for the night"}
                </p>
                <p className="text-[0.72rem] text-ink-2 text-center leading-relaxed mt-1">
                  {closedReason === "session"
                    ? "The discipline includes knowing when a conversation's done."
                    : "Come back tomorrow. Discipline means knowing when to stop."}
                </p>
                <button
                  type="button"
                  onClick={() => goToBoard(close)}
                  className="block mx-auto mt-2 num text-[0.72rem] text-ink px-3 py-1.5 bg-paper-2 hover:bg-paper transition-colors cursor-pointer"
                  style={{ border: "1px solid var(--rule-strong)" }}
                >
                  Tonight&apos;s board + the full CLV record ↓
                </button>
              </div>
            ) : (
              <form
                onSubmit={onSubmit}
                className="shrink-0 bg-paper-2 px-3 py-3"
                style={{ borderTop: "1px solid var(--rule-strong)" }}
              >
                <div
                  className="flex items-end gap-2 bg-paper px-2.5 py-2"
                  style={{ border: "1px solid var(--rule-strong)" }}
                >
                  <textarea
                    ref={inputRef}
                    value={draft}
                    onChange={onDraftChange}
                    onKeyDown={onKeyDown}
                    rows={1}
                    readOnly={pending}
                    aria-disabled={pending}
                    placeholder={pending ? "The desk is reading…" : "Ask the desk a question…"}
                    aria-label="Your question for the desk"
                    className="flex-1 resize-none bg-transparent text-base sm:text-sm text-ink placeholder:text-ink-3 outline-none leading-snug max-h-28"
                    style={{ fontFamily: "var(--font-sans), Archivo, sans-serif" }}
                  />
                  <button
                    type="submit"
                    disabled={pending || !draft.trim()}
                    aria-label="Send to the desk"
                    className="shrink-0 eyebrow px-2.5 py-1.5 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      color: "var(--paper)",
                      background: "var(--ink)",
                    }}
                  >
                    Send
                  </button>
                </div>
                <p className="eyebrow text-ink-3 mt-1.5 hidden sm:block" style={{ fontSize: "0.52rem", letterSpacing: "0.1em" }}>
                  Enter to send · Shift+Enter for a new line
                </p>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── Empty-state intro — sets the voice AND the capability before question one. ─
function Intro() {
  return (
    <div className="space-y-3">
      <p className="text-[0.9rem] text-ink leading-relaxed">
        <span className="font-display font-semibold">The desk is open.</span> Ask
        me about tonight&apos;s board, a bet you&apos;re eyeing, or why
        there&apos;s no pick on a game.
      </p>
      <p className="text-[0.8rem] text-ink-2 leading-relaxed">
        I read the live board before I say a word — real odds, the injury wire,
        and our model. I chase value, not action. If the number&apos;s wrong,
        I&apos;ll tell you. If it isn&apos;t, I&apos;ll tell you to{" "}
        <span className="num font-semibold" style={{ color: "var(--loss)" }}>
          PASS
        </span>{" "}
        — and the pass is the play.
      </p>
      <p className="text-[0.72rem] text-ink-3 leading-relaxed">
        The receipts live on the board below — every pick graded, CLV tracked in
        public.
      </p>
    </div>
  );
}

// ── 4a. User turn ───────────────────────────────────────────────────────────
function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="eyebrow text-ink-3" style={{ fontSize: "0.52rem" }}>
        You
      </span>
      <div
        className="max-w-[85%] px-3 py-2 bg-paper-3 text-[0.85rem] text-ink leading-relaxed whitespace-pre-wrap break-words"
        style={{ border: "1px solid var(--rule)" }}
      >
        {text}
      </div>
    </div>
  );
}

// ── 4b. The Sharp's turn — distinct ledger column. Recolors / reframes for
//        closed, distress, and dropped states. ───────────────────────────────
function SharpReply({ turn }: { turn: Turn }) {
  const isDistress = turn.intercepted === "distress";
  const isClosed = turn.closed === true;
  const isDropped = turn.dropped === true;

  // ── 6. DISTRESS — set apart, calm, supportive. Not a bet answer. ─────────
  if (isDistress) {
    return (
      <div
        className="px-3.5 py-3 bg-paper-2"
        style={{ borderLeft: "3px solid var(--blue)", border: "1px solid var(--rule)" }}
      >
        <p className="eyebrow mb-1.5" style={{ color: "var(--blue)" }}>
          A word, off the board
        </p>
        <p className="text-[0.88rem] text-ink leading-relaxed whitespace-pre-wrap break-words">
          {turn.content}
        </p>
        <p
          className="eyebrow text-ink-2 mt-2.5 pt-2 leading-relaxed"
          style={{ borderTop: "1px solid var(--rule)", fontSize: "0.55rem", letterSpacing: "0.1em" }}
        >
          1-800-GAMBLER · confidential, 24/7
        </p>
      </div>
    );
  }

  // ── 5. DESK CLOSED (closed:true or 429) — calm, in-character. ─────────────
  if (isClosed) {
    return (
      <SharpColumn dropped={false}>
        <div
          className="px-3 py-2 mt-1"
          style={{ background: "var(--loss-wash)", borderLeft: "2px solid var(--loss)" }}
        >
          <p className="text-[0.85rem] text-ink leading-relaxed whitespace-pre-wrap break-words">
            {turn.content}
          </p>
        </div>
      </SharpColumn>
    );
  }

  // Normal Sharp reply (and the in-character network-drop line).
  return (
    <SharpColumn dropped={isDropped}>
      <p
        className="text-[0.88rem] leading-relaxed whitespace-pre-wrap break-words"
        style={{ color: isDropped ? "var(--ink-2)" : "var(--ink)" }}
      >
        {turn.content}
      </p>
      {/* The receipts line — the reply's numbers came from a live pull; say so
          legibly, it's the product's differentiator. Never a full tool trace. */}
      {turn.toolsUsed && turn.toolsUsed.length > 0 && (
        <p className="eyebrow text-ink-2 mt-2" style={{ fontSize: "0.62rem", letterSpacing: "0.1em" }}>
          Live pull: {turn.toolsUsed.map(toolLabel).join(" · ")}
        </p>
      )}
    </SharpColumn>
  );
}

// Shared frame for a Sharp turn — the byline + a hairline left margin so the
// desk's voice reads as a distinct ledger column from the user's.
function SharpColumn({ children, dropped }: { children: React.ReactNode; dropped: boolean }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-baseline gap-1.5">
        <span className="eyebrow" style={{ color: dropped ? "var(--ink-3)" : "var(--loss)", fontSize: "0.52rem" }}>
          The Sharp
        </span>
        {dropped && (
          <span className="eyebrow text-ink-3" style={{ fontSize: "0.5rem" }}>
            · line dropped
          </span>
        )}
      </div>
      <div className="max-w-[92%] pl-3" style={{ borderLeft: "2px solid var(--rule-strong)" }}>
        {children}
      </div>
    </div>
  );
}

// ── 3. CONSULTING — the wait state. Escalates with real elapsed time so a 60s
//        deep read looks alive, not hung. Flavor ticker is aria-hidden; the SR
//        story is told by the panel's persistent status line. ────────────────
function Consulting() {
  const [idx, setIdx] = useState(0);
  const [dots, setDots] = useState(1);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const line = setInterval(() => setIdx((i) => (i + 1) % CONSULTING_LINES.length), 1400);
    const tick = setInterval(() => setDots((d) => (d % 3) + 1), 420);
    const clock = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      clearInterval(line);
      clearInterval(tick);
      clearInterval(clock);
    };
  }, []);

  // Stage copy: quick turns show the plain consulting line; past ~8s this is a
  // real Lane B pull and the user deserves an expectation; past ~25s, reassurance.
  const stage =
    elapsed < 8
      ? null
      : elapsed < 25
        ? "Deep read — live odds, injuries, and the model. A full slate takes 30–60s."
        : "Still working. A real pull beats a fast guess — hold tight.";

  return (
    <div className="flex flex-col items-start gap-1">
      <span className="eyebrow" style={{ color: "var(--loss)", fontSize: "0.52rem" }}>
        The Sharp
      </span>
      <div className="max-w-[92%] pl-3" style={{ borderLeft: "2px solid var(--rule-strong)" }}>
        <p className="eyebrow text-ink-2" style={{ letterSpacing: "0.14em" }}>
          Consulting the desk
          <span className="num" aria-hidden>
            {".".repeat(dots)}
          </span>
        </p>
        <p className="num text-[0.72rem] text-ink-3 mt-1 leading-relaxed" aria-hidden>
          {elapsed >= 3 ? CONSULTING_LINES[idx] : "Opening the ledger…"}
        </p>
        {stage && (
          <p className="text-[0.72rem] text-ink-2 mt-1 leading-relaxed">{stage}</p>
        )}
        {/* A thin ledger meter that idles under the dossier line. */}
        <div className="meter mt-2" style={{ width: "120px" }} aria-hidden>
          <div
            className="meter-fill consulting-meter"
            style={{ width: "40%" }}
          />
        </div>
      </div>
    </div>
  );
}

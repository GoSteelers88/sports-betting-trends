// The chat's home on the page: an in-flow section at the end of the main
// content, before the footer. Never fixed — a fixed tab covered the GATE row
// on "/" and a PLAY stamp on /nfl at 390 (measured 2026-09-12). The reader
// who has read the page is the one who wants to ask about it, and that is
// where they are. Opening the desk still uses the component's own sheet.
//
// /nfl mounts the launcher inside its own bare section (three edits only on
// the receipts page); the other routes use this head.

import { AskTheDesk, type DeskScope } from "./AskTheDesk";

export function AskSection({ scope = "default" }: { scope?: DeskScope }) {
  return (
    <section id="ask" className="receipts-section ask-section">
      <div className="section-head">
        <h2 className="headline section-title">ASK THE DESK</h2>
        <p className="eyebrow section-meta">THE SHARP · LIVE PULL ON EVERY ANSWER · NOT BETTING ADVICE</p>
      </div>
      <p className="prose standfirst-block hidden sm:block">
        A play on the board, a bet you are eyeing, why there is no pick on a game. The desk
        reads live odds, the injury wire and the model first — and it will tell you to pass.
      </p>
      <div className="ask-mount">
        <AskTheDesk scope={scope} />
      </div>
    </section>
  );
}

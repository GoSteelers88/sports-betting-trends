// The lead on "/" — the verdict, said once.
//
// The reader tapped a link under a screenshot of a PLAY stamp on X. Their
// first question is "is this real — what's his record?" and the answer is
// the number, first, in the number face, and the number today is negative.
// A tout hides -7.1%; this page prints it in the first line, in red, and
// then shows what it is doing about it (the today list, directly below).
//
// Everything that used to sit before the verdict — the volume line, the
// 6rem nameplate, two rules, the dateline, the issue number, the stamp — is
// one eyebrow now. Nothing here animates: the fold must read at scroll 0.
//
// Source of every figure: paperTrial.wins/losses/pushes, paperTrial.roi,
// paperTrial.totalGraded, paperTrial.mlReady, paperTrial.criteria — the same
// fields the old lead printed. The funding state prints as words in the
// verdict's second line (the seal lives on /desk, once).

import type { DashboardData } from "../_data/dashboard";

const ET_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
});

export function Hero({ data }: { data: DashboardData }) {
  const { paperTrial } = data;
  const graded = paperTrial.totalGraded;
  const roi = paperTrial.roi;
  const record = `${paperTrial.wins}–${paperTrial.losses}${paperTrial.pushes > 0 ? `–${paperTrial.pushes}` : ""}`;
  const roiText = roi !== null ? `${roi > 0 ? "+" : ""}${(roi * 100).toFixed(1)}%` : "—";
  // Red ink is reserved for money lost. A positive ROI is green; flat is ink.
  const roiTone = roi === null || graded === 0 ? "var(--ink)" : roi > 0 ? "var(--win)" : roi < 0 ? "var(--loss)" : "var(--ink)";
  const mlCriteria = paperTrial.criteria.filter((c) => c.track === "ml");
  const gatesMet = mlCriteria.filter((c) => c.met).length;
  const dateline = ET_DATE.format(new Date()).replace(/,/g, "").toUpperCase();

  return (
    <section id="front-page" className="verdict">
      <p className="eyebrow verdict-eyebrow">
        THE PAPER TRIAL · DAY {paperTrial.dayNumber} · {dateline}
        <span className="verdict-leagues"> · NBA · MLB · WNBA · NFL DESK</span>
      </p>
      <h1 className="verdict-h1">
        <span className="num verdict-line1">
          {graded > 0 ? (
            <>
              {record} · <span style={{ color: roiTone }}>{roiText}</span> ROI · {graded} graded
            </>
          ) : (
            <>No picks graded yet</>
          )}
        </span>
        <span className="headline verdict-line2">
          {paperTrial.mlReady ? "Real money is unlocked." : "Real money stays locked."}
        </span>
      </h1>
      <p className="num verdict-agate">
        <a href="/desk#deployment-gate">
          {gatesMet} of {mlCriteria.length} funding criteria clear → the gate
        </a>
      </p>
    </section>
  );
}

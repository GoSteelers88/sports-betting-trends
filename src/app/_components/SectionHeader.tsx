// Section heading — the /nfl pattern, promoted to the whole site: a caps
// serif title over a meta line, closed by a hairline. The meta carries the
// count, the window and the status, so the old status tag and the folio
// number are absorbed. `index` (the folio) is still accepted so callers need
// not change, and is never rendered: the owner dropped folio numbers.
// `subtitle` prints as prose under the head.

export type StampTone = "win" | "loss" | "hold" | "blue" | "mute";

const TONE: Record<StampTone, string> = {
  win: "var(--win)",
  loss: "var(--loss)",
  hold: "var(--hold)",
  blue: "var(--blue)",
  mute: "var(--ink-2)",
};

export function SectionHeader(props: {
  id: string;
  /** Folio number — accepted for compatibility, never rendered. */
  index?: string;
  /** Tracked-out meta line, e.g. "LAST 14 DAYS · 8 RUNS". */
  label: string;
  /** Caps serif title, e.g. "THE KILL ROOM". */
  title: string;
  subtitle?: string;
  status?: string;
  statusTone?: StampTone;
  /** Accepted for compatibility; one rhythm site-wide now. */
  dense?: boolean;
}) {
  const { id, label, title, subtitle, status, statusTone = "mute" } = props;
  return (
    <header id={id} className="panel-head">
      <div className="section-head">
        <h2 className="headline section-title">{title}</h2>
        <p className="eyebrow section-meta">
          {label}
          {status ? (
            <>
              {" · "}
              <span style={{ color: TONE[statusTone] }}>{status}</span>
            </>
          ) : null}
        </p>
      </div>
      {/* The explanatory line prints from 640px up; at phone widths the
          operator pages are dense on purpose and the meta line carries the
          identity. */}
      {subtitle ? <p className="prose standfirst-block hidden sm:block">{subtitle}</p> : null}
    </header>
  );
}

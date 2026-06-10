// Ledger section heading — folio mark and eyebrow over a double rule,
// Fraunces headline, optional status set as plain tracked smallcaps (the
// bordered stamp is reserved for the three true-stamp moments). `dense`
// renders the agate variant for back-of-book folios.

export type StampTone = "win" | "loss" | "hold" | "blue" | "mute";

const TONE: Record<StampTone, string> = {
  win: "var(--win)",
  loss: "var(--loss)",
  hold: "var(--hold)",
  blue: "var(--blue)",
  mute: "var(--ink-3)",
};

export function SectionHeader({
  id,
  index,
  label,
  title,
  subtitle,
  status,
  statusTone = "mute",
  dense = false,
}: {
  id: string;
  index: string; // folio number — "04"
  label: string; // tracked-out mono tag, e.g. "TONIGHT'S PLAY"
  title: string; // serif headline
  subtitle?: string;
  status?: string;
  statusTone?: StampTone;
  dense?: boolean;
}) {
  return (
    <header id={id} className={dense ? "pt-10 sm:pt-12" : "pt-14 sm:pt-20"}>
      <div className="flex items-baseline justify-between gap-4 pb-2">
        <p className="eyebrow">{label}</p>
        <p className="folio shrink-0">Fol. {index}</p>
      </div>
      <div className="rule-double" />
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div className="min-w-0 max-w-3xl">
          <h2 className={`headline text-ink ${dense ? "text-xl sm:text-2xl" : "text-3xl sm:text-5xl"}`}>
            {title}
          </h2>
          {subtitle && (
            <p className={`mt-2 leading-relaxed text-ink-2 max-w-2xl ${dense ? "text-xs" : "text-sm"}`}>
              {subtitle}
            </p>
          )}
        </div>
        {status && (
          <span className="tag shrink-0" style={{ color: TONE[statusTone] }}>
            {status}
          </span>
        )}
      </div>
    </header>
  );
}

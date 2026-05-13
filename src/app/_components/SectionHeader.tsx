// Editorial section header — oversized roman numeral as graphic element,
// serif-italic title for typographic moment, eyebrow above. Inspired by
// magazine layouts (Studio Namma SOTD) rather than OS chrome.

export function SectionHeader({
  id,
  index,
  label,
  title,
  subtitle,
  status,
  statusColor,
}: {
  id: string;
  index: string;       // "01" "02" — rendered as a massive serif numeral
  label: string;       // eyebrow short tag, e.g. "SURVIVOR BRIEF · GAMES"
  title: string;       // headline e.g. "EDGE REACTOR"
  subtitle?: string;
  status?: string;
  statusColor?: "edge" | "warn" | "kill" | "signal" | "muted";
}) {
  const sColor = statusColor ? `var(--${statusColor})` : "var(--text)";
  return (
    <header id={id} className="pt-10 sm:pt-16">
      <div className="grid grid-cols-[auto_1fr_auto] gap-6 sm:gap-10 items-end">
        {/* Massive editorial numeral — graphic element, not navigation */}
        <span className="section-numeral select-none" aria-hidden>
          {index}
        </span>

        <div className="min-w-0">
          <p className="eyebrow mb-3">{label}</p>
          <h2 className="section-head text-3xl sm:text-5xl text-[var(--text)]">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-3 text-sm leading-relaxed text-[var(--muted)] max-w-2xl font-sans">
              {subtitle}
            </p>
          )}
        </div>

        {status && (
          <span
            className="pill shrink-0 self-start mt-2"
            style={{ color: sColor, borderColor: sColor }}
          >
            {status}
          </span>
        )}
      </div>
      <div className="mt-6 sm:mt-8 hairline" />
    </header>
  );
}

// Reusable section header — keeps the OS visually coherent across modules.

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
  index: string;       // "01" "02" — visual counter
  label: string;       // eyebrow short tag, e.g. "MODULE 02"
  title: string;       // headline e.g. "EDGE REACTOR"
  subtitle?: string;
  status?: string;
  statusColor?: "edge" | "warn" | "kill" | "signal" | "muted";
}) {
  const sColor = statusColor ? `var(--${statusColor})` : "var(--text)";
  return (
    <header id={id} className="pt-4">
      <div className="flex items-baseline gap-3 mb-1.5">
        <span className="eyebrow text-[var(--muted)]">{index}</span>
        <span className="eyebrow text-[var(--muted)]">/ {label}</span>
        {status && (
          <span
            className="pill ml-auto"
            style={{ color: sColor, borderColor: sColor }}
          >
            {status}
          </span>
        )}
      </div>
      <h2 className="section-head text-3xl sm:text-5xl text-[var(--text)]">{title}</h2>
      {subtitle && (
        <p className="mt-1 text-sm text-[var(--muted)] font-mono max-w-2xl">
          {subtitle}
        </p>
      )}
    </header>
  );
}

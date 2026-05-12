export function Footer({ generatedAt }: { generatedAt: string }) {
  const stamp = new Date(generatedAt)
    .toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    .toUpperCase();
  return (
    <footer className="mt-12 mb-6 border-t border-[var(--border)] pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3 eyebrow text-[var(--muted)]">
        <span>▸ NATESTACKS OS · BUILD {stamp.split(",")[0]} · ET</span>
        <span>PICKS ARE MODEL OUTPUT · NOT FINANCIAL ADVICE · BET RESPONSIBLY</span>
      </div>
    </footer>
  );
}

// Colophon — the back page of the ledger.

export function Footer({ generatedAt }: { generatedAt: string }) {
  const stamp = new Date(generatedAt)
    .toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    .toUpperCase();
  return (
    <footer className="mt-16 mb-8">
      <div className="rule-double" />
      <div className="pt-4 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <p className="eyebrow text-ink-3">
          NATESTACKS · The Paper Trial · pressed {stamp} ET
        </p>
        <p className="eyebrow text-ink-3">
          Picks are model output · not financial advice · bet responsibly
        </p>
      </div>
      <p className="eyebrow text-ink-3 mt-2">
        Set in Fraunces, Archivo &amp; IBM Plex Mono · red ink reserved for losses
      </p>
    </footer>
  );
}

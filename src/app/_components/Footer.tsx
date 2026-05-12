export function Footer({ generatedAt }: { generatedAt: string }) {
  const stamp = new Date(generatedAt)
    .toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    .toUpperCase();
  return (
    <footer className="mt-12 mb-6">
      <div className="tape h-2 mb-4" aria-hidden="true" />
      <p className="var-mono text-[0.65rem] uppercase tracking-[0.3em] text-center" style={{ color: "var(--concrete)" }}>
        ▸ EOT // GENERATED {stamp} ET // PICKS ARE MODEL OUTPUT — NOT ADVICE — BET RESPONSIBLY
      </p>
      <div className="tape h-2 mt-4" aria-hidden="true" />
    </footer>
  );
}

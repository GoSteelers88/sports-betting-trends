export function Footer({ generatedAt }: { generatedAt: string }) {
  return (
    <footer className="mt-12 mb-6">
      <div className="hazard-tape h-2 mb-4" aria-hidden="true" />
      <p className="mono text-[0.7rem] text-white/50 uppercase tracking-wider text-center">
        GENERATED {new Date(generatedAt).toLocaleString("en-US", { timeZone: "America/New_York" }).toUpperCase()} ET
      </p>
      <p className="mono text-[0.65rem] text-white/30 mt-2 text-center uppercase tracking-wider">
        PICKS ARE MODEL OUTPUT // NOT FINANCIAL ADVICE // BET RESPONSIBLY
      </p>
    </footer>
  );
}

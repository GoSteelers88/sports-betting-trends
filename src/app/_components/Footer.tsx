export function Footer({ generatedAt }: { generatedAt: string }) {
  return (
    <footer className="mt-12 mb-6 text-center">
      <p className="text-xs text-slate-600 mono">
        Generated {new Date(generatedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET
      </p>
      <p className="text-xs text-slate-700 mt-1">
        Picks are model output, not financial advice. Bet responsibly.
      </p>
    </footer>
  );
}

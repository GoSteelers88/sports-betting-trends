"use client";

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";

// Equity curve for the de-vig +EV paper book. Generic area chart over the
// ledger snapshots; baseline = the $10k starting bankroll.
export function DevigEquityCurve({
  data,
  baseline,
}: {
  data: Array<{ ts: string; equityUsd: number }>;
  baseline: number;
}) {
  if (!data || data.length < 2) {
    return (
      <div className="flex h-[180px] items-center justify-center">
        <span className="eyebrow text-[var(--muted)]">
          EQUITY CURVE BUILDS AS BETS SETTLE
        </span>
      </div>
    );
  }

  const values = data.map((d) => d.equityUsd);
  const lo = Math.min(baseline, ...values);
  const hi = Math.max(baseline, ...values);
  const pad = Math.max(20, (hi - lo) * 0.15);

  const chart = data.map((d) => ({ t: new Date(d.ts).getTime(), equity: d.equityUsd }));

  return (
    <div className="h-[180px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="dvEquity" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--edge)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--edge)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t) =>
              new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            }
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            stroke="var(--border)"
            minTickGap={40}
          />
          <YAxis
            domain={[lo - pad, hi + pad]}
            tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            stroke="var(--border)"
            width={44}
          />
          <ReferenceLine y={baseline} stroke="var(--muted)" strokeDasharray="3 3" />
          <Tooltip
            contentStyle={{
              background: "var(--surface, #14141c)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(t) => new Date(t as number).toLocaleString()}
            formatter={(v) => [`$${Number(v).toFixed(2)}`, "Equity"]}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="var(--edge)"
            strokeWidth={2}
            fill="url(#dvEquity)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

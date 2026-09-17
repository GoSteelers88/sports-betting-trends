"use client";

// Equity curve for the de-vig +EV paper book and the quant desk — a 1.5px
// ink line on paper over the dashed $10k baseline. No area fill: decoration
// under the data line was cut 2026-09-12. Data logic untouched.

import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";

export function DevigEquityCurve({
  data,
  baseline,
  height = 140,
}: {
  data: Array<{ ts: string; equityUsd: number }>;
  baseline: number;
  height?: number;
}) {
  if (!data || data.length < 2) {
    return (
      <div
        className="flex items-center justify-center border border-dashed border-rule"
        style={{ height }}
      >
        <span className="eyebrow text-ink-3">Equity curve builds as bets settle</span>
      </div>
    );
  }

  const values = data.map(d => d.equityUsd);
  const lo = Math.min(baseline, ...values);
  const hi = Math.max(baseline, ...values);
  const pad = Math.max(20, (hi - lo) * 0.15);
  const last = values[values.length - 1];
  const lineColor = last >= baseline ? "var(--win)" : "var(--loss)";

  const chart = data.map(d => ({ t: new Date(d.ts).getTime(), equity: d.equityUsd }));

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={t =>
              new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            }
            tick={{ fill: "var(--ink-2)", fontSize: 11, fontFamily: "var(--font-mono)" }}
            stroke="var(--rule)"
            minTickGap={40}
          />
          <YAxis
            domain={[lo - pad, hi + pad]}
            tickFormatter={v => `$${(v / 1000).toFixed(1)}k`}
            tick={{ fill: "var(--ink-2)", fontSize: 11, fontFamily: "var(--font-mono)" }}
            stroke="var(--rule)"
            width={46}
          />
          <ReferenceLine y={baseline} stroke="var(--ink-3)" strokeDasharray="4 4" strokeOpacity={0.8} />
          <Tooltip
            contentStyle={{
              background: "var(--paper-2)",
              border: "1px solid var(--rule-strong)",
              borderRadius: 0,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--ink)",
            }}
            labelFormatter={t => new Date(t as number).toLocaleString()}
            formatter={v => [`$${Number(v).toFixed(2)}`, "Equity"]}
          />
          <Line
            type="monotone"
            dataKey="equity"
            stroke={lineColor}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

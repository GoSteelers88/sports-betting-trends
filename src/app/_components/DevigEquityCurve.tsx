"use client";

// Equity curve for the de-vig +EV paper book — ink line on paper over the
// dashed red $10k baseline. Data logic untouched.

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";

export function DevigEquityCurve({
  data,
  baseline,
}: {
  data: Array<{ ts: string; equityUsd: number }>;
  baseline: number;
}) {
  if (!data || data.length < 2) {
    return (
      <div className="flex h-[180px] items-center justify-center border border-dashed border-rule">
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
    <div className="h-[180px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="dvEquity" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.18} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={t =>
              new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            }
            tick={{ fill: "var(--ink-2)", fontSize: 10, fontFamily: "var(--font-mono)" }}
            stroke="var(--rule)"
            minTickGap={40}
          />
          <YAxis
            domain={[lo - pad, hi + pad]}
            tickFormatter={v => `$${(v / 1000).toFixed(1)}k`}
            tick={{ fill: "var(--ink-2)", fontSize: 10, fontFamily: "var(--font-mono)" }}
            stroke="var(--rule)"
            width={44}
          />
          <ReferenceLine y={baseline} stroke="var(--loss)" strokeDasharray="4 4" strokeOpacity={0.6} />
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
          <Area
            type="monotone"
            dataKey="equity"
            stroke={lineColor}
            strokeWidth={2}
            fill="url(#dvEquity)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

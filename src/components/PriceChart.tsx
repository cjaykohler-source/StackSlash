import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { etClockLabel, type SessionAxis } from "../lib/marketTime";

export interface PricePoint {
  /** epoch-ms for the intraday variant, pre-formatted date label for calendar */
  x: number | string;
  y: number;
}

interface Props {
  data: PricePoint[];
  /** "intraday" = fixed extended-hours time axis; "calendar" = categorical dates */
  variant: "intraday" | "calendar";
  session?: SessionAxis; // required for the intraday variant
  height?: number;
}

const money = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function TooltipCard({
  active,
  payload,
  variant,
}: {
  active?: boolean;
  payload?: { value: number; payload: PricePoint }[];
  variant: "intraday" | "calendar";
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const when =
    variant === "intraday"
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(p.payload.x as number)) + " ET"
      : String(p.payload.x);
  return (
    <div className="price-chart-tip">
      <span className="price-chart-tip-when">{when}</span>
      <span className="price-chart-tip-price">{money(p.value)}</span>
    </div>
  );
}

/**
 * Shared price line for the symbol drill-down. Gradient area fill, themed
 * grid/axes, and a dark tooltip (no series label — the value is obviously
 * the price). The intraday variant pins the x-axis to the full
 * pre-market-to-after-hours span via `session` so a partial day reads
 * correctly; the calendar variant keeps recharts' categorical date axis.
 */
export function PriceChart({ data, variant, session, height = 320 }: Props) {
  const gradId = useId().replace(/:/g, "");
  const up = data.length >= 2 && data[data.length - 1].y >= data[0].y;
  const stroke = up ? "var(--green)" : "var(--red)";

  const values = data.map((d) => d.y);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.08 || hi * 0.02 || 1;

  return (
    <div className="price-chart">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 10, right: 16, bottom: 4, left: 4 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeOpacity={0.5} vertical={false} />
          {variant === "intraday" && session ? (
            <XAxis
              type="number"
              dataKey="x"
              scale="time"
              domain={session.domain}
              ticks={session.ticks}
              tickFormatter={(v: number) => etClockLabel(v)}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={{ fill: "var(--text-dim)", fontSize: 11 }}
              minTickGap={0}
            />
          ) : (
            <XAxis
              dataKey="x"
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={{ fill: "var(--text-dim)", fontSize: 11 }}
              minTickGap={40}
            />
          )}
          <YAxis
            domain={[lo - pad, hi + pad]}
            width={58}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--text-dim)", fontSize: 11 }}
            tickFormatter={(v: number) => money(v)}
          />
          {variant === "intraday" && session && (
            <>
              <ReferenceLine
                x={session.open}
                stroke="var(--text-dim)"
                strokeDasharray="2 3"
                strokeOpacity={0.6}
              />
              <ReferenceLine
                x={session.close}
                stroke="var(--text-dim)"
                strokeDasharray="2 3"
                strokeOpacity={0.6}
              />
            </>
          )}
          <Tooltip
            content={<TooltipCard variant={variant} />}
            cursor={{ stroke: "var(--text-dim)", strokeDasharray: "3 3" }}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke={stroke}
            strokeWidth={2}
            fill={`url(#${gradId})`}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

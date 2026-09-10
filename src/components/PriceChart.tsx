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
import { etTimeLabel, type SessionAxis } from "../lib/marketTime";

export interface PricePoint {
  /** layout coordinate for intraday (see SessionAxis.toX); date label for calendar */
  x: number | string;
  y: number;
  /** intraday only: the real epoch-ms, for the tooltip */
  t?: number;
}

interface Props {
  data: PricePoint[];
  /** "intraday" = fixed extended-day time axis; "calendar" = categorical dates */
  variant: "intraday" | "calendar";
  session?: SessionAxis; // required for the intraday variant
  height?: number;
  /** Strip axes/grid/labels down to a sparkline — same fixed session frame,
   *  just no chrome. Used by the dashboard's tracked-symbol mini charts. */
  compact?: boolean;
  /** Override the auto up/down line colour (compact cards colour off the
   *  live quote's since-the-open change instead of first-vs-last point). */
  stroke?: string;
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
    variant === "intraday" && typeof p.payload.t === "number"
      ? etTimeLabel(p.payload.t)
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
 * the price).
 *
 * The intraday variant runs a fixed 4:00a–8:00p ET axis (see
 * lib/marketTime) where extended-hours hours are compressed to 1/3 width;
 * `data[].x` is already the layout coordinate. Faint dividers mark the
 * 9:30a / 4:00p regular-session bounds. The calendar variant keeps
 * recharts' categorical date axis.
 */
export function PriceChart({ data, variant, session, height, compact = false, stroke }: Props) {
  const gradId = useId().replace(/:/g, "");
  const up = data.length >= 2 && data[data.length - 1].y >= data[0].y;
  const lineColor = stroke ?? (up ? "var(--green)" : "var(--red)");
  const h = height ?? (compact ? 72 : 320);

  const values = data.map((d) => d.y);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.08 || hi * 0.02 || 1;

  return (
    <div className={`price-chart${compact ? " price-chart-compact" : ""}`}>
      <ResponsiveContainer width="100%" height={h}>
        <AreaChart
          data={data}
          margin={compact ? { top: 4, right: 2, bottom: 2, left: 2 } : { top: 10, right: 16, bottom: 4, left: 4 }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.28} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          {!compact && (
            <CartesianGrid stroke="var(--border)" strokeOpacity={0.5} vertical={false} />
          )}
          {variant === "intraday" && session ? (
            <XAxis
              type="number"
              dataKey="x"
              domain={session.domain}
              ticks={compact ? [] : session.ticks}
              allowDataOverflow
              tickFormatter={(v: number) => session.tickLabels[v] ?? ""}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={compact ? false : { fill: "var(--text-dim)", fontSize: 10 }}
              height={compact ? 2 : undefined}
              interval={0}
              minTickGap={0}
            />
          ) : (
            <XAxis
              dataKey="x"
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={compact ? false : { fill: "var(--text-dim)", fontSize: 11 }}
              height={compact ? 2 : undefined}
              minTickGap={40}
            />
          )}
          <YAxis
            domain={[lo - pad, hi + pad]}
            width={compact ? 0 : 58}
            hide={compact}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--text-dim)", fontSize: 11 }}
            tickFormatter={(v: number) => money(v)}
          />
          {variant === "intraday" && session && (
            <>
              <ReferenceLine x={session.open} stroke="var(--border)" strokeOpacity={compact ? 0.6 : 0.9} />
              <ReferenceLine x={session.close} stroke="var(--border)" strokeOpacity={compact ? 0.6 : 0.9} />
            </>
          )}
          <Tooltip
            content={<TooltipCard variant={variant} />}
            cursor={{ stroke: "var(--text-dim)", strokeDasharray: "3 3" }}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke={lineColor}
            strokeWidth={compact ? 1.75 : 2}
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

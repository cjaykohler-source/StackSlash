import { useEffect, useRef } from "react";
import * as echarts from "echarts";

/**
 * Thin React wrapper around one ECharts instance: creates it on mount,
 * applies `option` on every change (notMerge, so removed series really go
 * away), resizes with its container, and forwards chart events.
 */
export function EChart({
  option,
  height,
  onEvents,
  group,
  onReady,
}: {
  option: echarts.EChartsOption;
  height: number;
  onEvents?: Record<string, (p: unknown) => void>;
  /** charts sharing a group id sync their tooltips/zoom */
  group?: string;
  /** called once with the chart instance (for low-level handlers like zrender clicks) */
  onReady?: (chart: echarts.ECharts) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, "dark", { renderer: "canvas" });
    chart.current = c;
    onReady?.(c);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.setOption(option, { notMerge: true, lazyUpdate: true });
    if (group) {
      c.group = group;
      echarts.connect(group);
    }
  }, [option, group]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !onEvents) return;
    for (const [ev, fn] of Object.entries(onEvents)) c.on(ev, fn);
    return () => {
      for (const ev of Object.keys(onEvents)) c.off(ev);
    };
  }, [onEvents]);

  useEffect(() => {
    chart.current?.resize();
  }, [height]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}

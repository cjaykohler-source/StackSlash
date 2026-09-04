import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { TRIGGER_INFO, triggerLabel, triggerCategoryLabel } from "../lib/triggerInfo";

interface TriggerRow {
  name: string;
  enabled: boolean;
  cooldown_minutes: number;
}

/**
 * Full plain-English breakdown of every trigger — what it means, not just
 * what it's called. Content itself lives in lib/triggerInfo.ts (shared
 * with DossierCard/TriggerFeed); this page also fetches live enabled/
 * cooldown status from Supabase so it doesn't just describe the triggers,
 * it shows their actual current state.
 */
export function About() {
  const [liveByName, setLiveByName] = useState<Record<string, TriggerRow>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase.from("triggers").select("name, enabled, cooldown_minutes");
      if (cancelled || !data) return;
      const byName: Record<string, TriggerRow> = {};
      for (const row of data as TriggerRow[]) byName[row.name] = row;
      setLiveByName(byName);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Group by category for a more readable layout, preserving a sensible
  // reading order (entries first, then exits, matching how you'd think
  // about acting on them) rather than alphabetical.
  const categoryOrder = ["momentum", "earnings", "breakout", "technical", "outlier", "exit"];
  const names = Object.keys(TRIGGER_INFO).sort((a, b) => {
    const ca = categoryOrder.indexOf(TRIGGER_INFO[a].category);
    const cb = categoryOrder.indexOf(TRIGGER_INFO[b].category);
    return ca !== cb ? ca - cb : a.localeCompare(b);
  });

  let lastCategory: string | null = null;

  return (
    <div className="page">
      <header className="page-header">
        <h1>About the Triggers</h1>
        <Link to="/">← back to feed</Link>
      </header>

      <p className="about-intro">
        Every alert on this dashboard comes from one of the triggers below. Each one fires under different
        conditions — some flag a stock worth watching, one tells you when to consider getting out.
      </p>

      <div className="trigger-info-list">
        {names.map((name) => {
          const info = TRIGGER_INFO[name];
          const live = liveByName[name];
          const showCategoryHeader = info.category !== lastCategory;
          lastCategory = info.category;

          return (
            <div key={name}>
              {showCategoryHeader && <h2 className="trigger-category-header">{triggerCategoryLabel(name)}</h2>}
              <div className="trigger-info-card">
                <div className="trigger-info-header">
                  <span className="trigger-info-label">{triggerLabel(name)}</span>
                  {live && (
                    <span className={`status ${live.enabled ? "status-alerted" : "status-dismissed"}`}>
                      {live.enabled ? "Active" : "Disabled"}
                    </span>
                  )}
                </div>
                <p className="trigger-info-detail">{info.detail}</p>
                {live && (
                  <p className="trigger-info-cooldown">
                    Won't re-alert on the same stock for {formatCooldown(live.cooldown_minutes)} after firing.
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatCooldown(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

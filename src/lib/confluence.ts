/**
 * Confluence = multiple *distinct* triggers firing on the same symbol
 * within a given set of rows (a day, for TriggerFeed/Reports) — not the
 * same trigger re-firing after its cooldown, which isn't agreement
 * between independent signals. Extracted so TriggerFeed's live feed and
 * Reports' arbitrary-date report can't drift into two different
 * definitions of the same concept.
 */
export function computeConfluence(
  rows: { symbol_id: number; triggerName: string | null | undefined }[],
): Map<number, Set<string>> {
  const triggerNamesBySymbol = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!row.triggerName) continue;
    const existing = triggerNamesBySymbol.get(row.symbol_id) ?? new Set<string>();
    existing.add(row.triggerName);
    triggerNamesBySymbol.set(row.symbol_id, existing);
  }
  return triggerNamesBySymbol;
}

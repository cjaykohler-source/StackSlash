# Handoff Checklist for Next Conversation

## ✅ STATUS: EXTRACTION COMPLETE — PROCEED TO CONSOLIDATION

All 40 batches have been successfully extracted. The 40 batch JSON files are in `results/`.

---

## ONE-TIME SETUP (do once per conversation)
- [x] Confirm working directory is `/Users/ckohler/Desktop/Market Books/TXTs/_extraction/`
- [x] All 40 batch extractions complete
- [ ] **Read README_STATUS.md** — FINAL AGGREGATION STEP section has all instructions

---

## NEXT STEPS: FINAL AGGREGATION

### Option A: Use Sonnet 5.5 (Recommended for quality)
```bash
ls results/batch_*.json | wc -l  # Verify all 40 files exist
```

Launch a new Sonnet agent with the consolidation task:
- Read all 40 batch JSON files from `results/`
- Consolidate/deduplicate strategy names across batches
- Count distinct source files per strategy
- Sort by reference count (descending)
- Create final ranked doc via Docs MCP tool

### Option B: Quick Check
```bash
ls results/batch_*.json | wc -l
```
Should show **40 files** — all extraction complete.

---

## IF ANYTHING NEEDS RE-EXTRACTION

- **Check a specific batch**: `cat results/batch_XX.json | head -20`
- **Batch missing or incomplete**: Rare, but if a batch JSON is missing or has <20 strategies when others have 40-60, it may need re-extraction. Re-launch just that batch with its prompt file.
- **Need to retry**: Use `Agent()` tool with model `haiku`, pointing to `prompt_XX.txt` in this folder.

---

## FILES IN THIS FOLDER

**Core extraction artifacts**:
- `results/batch_00.json` through `results/batch_39.json` (40 files, all complete)
- `prompt_00.txt` through `prompt_39.txt` (40 prompt files, reference only)

**Reference/Setup**:
- `batches.json`: file-to-batch assignments (mapping of which source .txt goes to which batch)
- `taxonomy.md`: canonical strategy names used across all batches
- `README_STATUS.md`: full project documentation (read this for aggregation instructions)
- `HANDOFF_CHECKLIST.md`: this file

**Source books** (external reference):
- `/Users/ckohler/Desktop/Market Books/TXTs/*.txt` (727 files, ~160MB)

---

## AGGREGATION: KEY DECISION POINTS

1. **Model choice**: Sonnet 5.5 recommended (better at deduplication/pattern-matching than Haiku)
2. **Docs tool**: Use `mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__*` (Docs MCP)
3. **Final output title**: "Trading & Investing Wisdom: Ranked by Consensus Across 727 Books"
4. **Ranking metric**: Number of distinct source files mentioning each strategy (NOT raw mention count)

See **FINAL AGGREGATION STEP** in README_STATUS.md for detailed step-by-step instructions.

# Market Wisdom Project

Trading and investing strategies taken from 727 books and ranked by how many distinct books mention each one.

Live doc: https://claude.ai/code/artifact/6112e750-6e85-48dc-a675-402b32bb3e95 (a local copy is `Trading_Wisdom_Ranked.md`)

## Contents

| Path | What it is |
| --- | --- |
| `Trading_Wisdom_Ranked.md` | The ranked list of 108 strategies with descriptions, exported 2026-09-29 |
| `rankings.csv` | The same ranking in CSV form: rank, strategy, books, description, merged variants, source files |
| `books/` | All 727 source `.txt` files |
| `_extraction/results/batch_00–39.json` | Raw extraction output: strategy name → source files, one file per batch |
| `_extraction/consolidate.py` | The merge-and-rank script (see below) |
| `_extraction/consolidated.json` | Merged output: each strategy with its count, merged variant names and source files |
| `_extraction/descriptions.json` | The description for each strategy, used to fill the CSV |
| `_extraction/taxonomy.md` | The canonical names the extraction agents were given |
| `_extraction/batches.json`, `prompt_XX.txt` | Which books went into each batch, and the prompt each batch agent used |
| `_extraction/README_STATUS.md`, `HANDOFF_CHECKLIST.md` | Notes from the extraction phase (its status counts are outdated; the numbers below are the verified ones) |

## Numbers

- 727 books scanned. 560 contained at least one strategy; the rest were empty, garbled or off-topic.
- 443 raw strategy names were merged into 108 strategies.
- The ranking metric is the number of distinct books that mention a strategy, not the raw number of mentions.

## Rerunning the merge

```bash
python3 _extraction/consolidate.py
```

This reads the 40 batch files, merges the names using the `G` mapping at the top of the script, and rewrites `consolidated.json` and `rankings.csv`. It uses paths relative to the script, so it works wherever this folder lives. It only needs Python 3, with no extra packages. It does not touch the books or the batch files, and it does not update the live doc or `Trading_Wisdom_Ranked.md`.

To change how strategies are grouped, edit `G` (canonical name → list of variant names) and rerun it.

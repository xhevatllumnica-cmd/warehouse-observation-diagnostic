# WMS Pulse — refresh

The app has no SQL connection. Scheduled Claude tasks run the read-only blocks of `queries.sql` through the WMS connector (`queryWMSDb`). The WMS agent then finds the results in the Claude Code transcripts by their `/*pulse:X*/` markers. Within about 2 minutes it runs `node pulse/build.js --from-transcripts`, which writes `pulse/data.json`.

A block that was not run, or that failed, keeps its previous result (`pulse/raw/<X>.json`) and goes stale. The build's summary line is the last line the agent logs (`wms-agent.log`), and it names a stale board, for example:

```
· board STALE (block M from 2026-10-03T16:08:11) · block M failed at …: <error>
```

`data.json → blocks` holds, for every block, when its result was read (`at`), its `gen`, and the last failure, if it is newer than the result.

## Scheduled tasks

| Task | When | Runs |
|---|---|---|
| `wms-pulse-refresh` | every hour 07–22, every day (cron `0 7-22 * * *`) | every block of `pulse/queries.sql` (A–M; **block M every run**; H, I, J may be skipped outside 07:00 and Mondays) and, at 07, 13 and 18, every block of `pulse/queries.bn.sql` (Bottleneck Register) |

The Tabela ditore says its cut-off figures come "çdo orë (07–22)". `cutoffs()` in `tabela-board.js` shows them only when `board.gen` is from today, so block M has to run at least once a day, and hourly to keep them current — the hourly `wms-pulse-refresh` does that (checked 08.10.2026: `board.gen` from that day, `cut.available: true`). No separate block-M task is needed; one would only run M twice an hour. Block M is small: 11 stations and about 20 summary rows, and it runs in about a second.

When a new block is added to `queries.sql`, add its letter to the list in the prompt of `wms-pulse-refresh` (step 2 names every block).

## Check

- `http://localhost:8790/tabela/data` → `cut.available: true` and `cut.gen` from today.
- `pulse/data.json` → `board.gen` from today and `blocks.M.error` empty.

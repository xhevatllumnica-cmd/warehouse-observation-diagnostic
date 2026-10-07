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
| `wms-pulse-refresh` | 07, 13, 18 | every block of `pulse/queries.sql` (M, A–L) and every block of `pulse/queries.bn.sql` (Bottleneck Register) |
| `wms-board-hourly` | every hour 07–22 (cron `5 7-22 * * 1-6`) | only block **M**: the daily board's cut-offs and carryover (page `/tabela`, "Metrikat e mia") |

The Tabela ditore says its cut-off figures come "çdo orë (07–22)". `cutoffs()` in `tabela-board.js` shows them only when `board.gen` is from today, so block M has to run at least once a day, and hourly to keep them current. Block M is small: 11 stations and about 20 summary rows, and it runs in about a second.

### Prompt of `wms-board-hourly`

```
In the warehouse-observation-app folder, read pulse\queries.sql. Run ONLY block M — the first block of the file, the
SELECT that starts with  SELECT /*pulse:M*/  and ends with the line "… FOR JSON PATH) stations" — as ONE call of the
WMS tool queryWMSDb, exactly as written, keeping the /*pulse:M*/ marker. If the call times out or errors, run it once
more. Do not run any other block, do not run shell commands and do not write files: the WMS agent picks up the
result and rebuilds pulse/data.json by itself. Read-only: SELECT only.
```

### Prompt line for `wms-pulse-refresh`

The prompt must ask for every block, not a list of letters, so a new block is never left out:

```
Run EVERY block of pulse\queries.sql (M, A, B, … L — each starts with "-- @X") and EVERY block of pulse\queries.bn.sql,
each as ONE queryWMSDb call, exactly as written, keeping its /*pulse:X*/ or /*bn:Dx*/ marker. If a call times out or errors, run it once more.
```

## Check

- `http://localhost:8790/tabela/data` → `cut.available: true` and `cut.gen` from today.
- `pulse/data.json` → `board.gen` from today and `blocks.M.error` empty.

# Metric Store Plan

Architecture design for persisting bugfixagent log records and agent-run state. Goal: traceable audits and analytics at ~hundreds of agent runs per hour.

**Status:** draft — iterate here before implementation.

**Scope of this doc:** schema, tables, and storage architecture only. API routes, dashboards, and CLI tooling are out of scope.

---

## Goals

1. **Audit trail** — every investigation is reconstructable from durable storage, keyed by `investigationRequestId`.
2. **Queryable run state** — status, verdict, and event timeline available via SQL without grepping stdout.
3. **Analytics** — verdict mix, duration percentiles, parse-failure rate, throughput over time.
4. **Low ops** — embedded databases, single-node friendly, no external infra required for v1.

## Non-goals (v1)

- Replacing Cursor as the source of truth for conversation/tool-step detail (`inspect-run.ts` stays for deep drill-down).
- Multi-region or multi-writer deployment (single bugfixagent instance per SQLite file).
- HTTP read API, dashboards, or CLI tooling (separate effort).

---

## Current State


| Component                | Role today                                                       |
| ------------------------ | ---------------------------------------------------------------- |
| `logger.ts`              | Writes JSON (prod) or pretty text (dev) to **stdout only**       |
| `investigationLogMeta()` | Correlates logs via `investigationRequestId`                     |
| `main.ts`                | Accepts investigations async (`202`), fires background workflow  |
| `service.ts`             | Orchestrates Cursor cloud agent; emits ~10–15 log events per run |
| `inspect-run.ts`         | Fetches run conversation from Cursor API (manual/debug)          |
| `recent-runs.ts`         | Lists recent cloud runs via Cursor API (no local persistence)    |


**Gap:** no durable store; run state and events exist only in stdout.

---

## Scale Assumptions

Target: **~300 agent runs/hour** (headroom above "hundreds").


| Metric                               | Estimate                                        |
| ------------------------------------ | ----------------------------------------------- |
| Log events per run                   | 10–15                                           |
| Events per hour                      | ~3,000–4,500                                    |
| Events per day                       | ~72K–108K                                       |
| Typical event row                    | 200–800 bytes                                   |
| SQLite growth (30-day hot retention) | ~30–80 MB (metadata only; no large blobs in v1) |


Both SQLite and DuckDB handle this comfortably on a single node.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Fastify (main.ts) + BugFixAgentService (service.ts)         │
│                                                              │
│  logger.ts ──► SQLite (WAL)          stdout (keep both)      │
│                    ├── investigations  (mutable run state)   │
│                    └── log_events        (append-only audit)   │
└──────────────────────────────────────────────────────────────┘
         │
         │  periodic sync (5–15 min) or on investigation finish
         ▼
┌──────────────────────────────────────────────────────────────┐
│  DuckDB (analytics.db)                                       │
│    - ingest from SQLite                                      │
│    - materialized rollups: hourly_stats                      │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
   ad-hoc SQL / external tooling (out of scope for this doc)
```

### Role split


| Store      | Primary job                      | Why                                                                              |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------- |
| **SQLite** | Operational source of truth      | Fast point lookups, status updates, append-only audit log, single-process writes |
| **DuckDB** | Analytics read model             | Aggregations, time-series, ad-hoc queries over history without load on hot path  |
| **stdout** | Ops/debug + optional log shipper | Keep existing behavior alongside DB persistence                                  |


SQLite and DuckDB are complementary, not either/or.

---

## Data Model (SQLite)

### `investigations`

One row per accepted investigation. Updated as the workflow progresses.

```sql
CREATE TABLE investigations (
  id                TEXT PRIMARY KEY,   -- investigationRequestId (UUID)
  status            TEXT NOT NULL,      -- see status enum below
  verdict           TEXT,               -- VALID | SPAM | NOT_VALID | ...
  message_length    INTEGER,
  repo_url          TEXT,
  agent_id          TEXT,
  run_id            TEXT,
  cursor_request_id TEXT,
  title             TEXT,
  effort            TEXT,               -- EASY | MEDIUM | HARD
  github_issue_url  TEXT,
  error             TEXT,               -- serialized error on failure
  created_at        TEXT NOT NULL,      -- ISO 8601
  started_at        TEXT,
  finished_at       TEXT
);

CREATE INDEX idx_investigations_status ON investigations(status);
CREATE INDEX idx_investigations_created ON investigations(created_at);
CREATE INDEX idx_investigations_verdict ON investigations(verdict);
```

#### Investigation status enum

```
accepted → running → finished
                  ↘ failed
```


| Status     | Meaning                                           |
| ---------- | ------------------------------------------------- |
| `accepted` | `POST /investigations` returned 202               |
| `running`  | Cursor agent created, awaiting completion         |
| `finished` | Workflow completed (any verdict or parse outcome) |
| `failed`   | Unhandled exception or unrecoverable error        |


### `log_events`

Append-only audit stream. One row per logger call that opts into persistence.

```sql
CREATE TABLE log_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        TEXT NOT NULL,
  investigation_id TEXT,        -- NULL for non-investigation logs (e.g. health); FK to investigations.id
  level            TEXT NOT NULL,
  event            TEXT NOT NULL,  -- normalized event name (see taxonomy)
  message          TEXT NOT NULL,  -- original human-readable message
  contents         TEXT            -- JSON blob for extra meta
);

CREATE INDEX idx_log_events_investigation_timestamp ON log_events(investigation_id, timestamp);
CREATE INDEX idx_log_events_timestamp ON log_events(timestamp);
CREATE INDEX idx_log_events_event ON log_events(event);
```

**Large contents policy (v1):** do not persist full prompts, user reports, or raw agent results in `log_events.contents`. Strip or omit those fields when writing to the metric store; keep them on stdout only if needed for local debug. For replay, use Cursor API (`inspect-run.ts`) via stored `agent_id` / `run_id`. An `artifacts` table may be added later if local blob retention is required.

---

## Event Taxonomy

Normalize free-text logger messages to stable `event` names for analytics and filtering. The logger's `msg` argument maps to the `message` column; `event` is the normalized alias.

### Investigation lifecycle


| Event                        | Source message                      | Notes                                   |
| ---------------------------- | ----------------------------------- | --------------------------------------- |
| `investigation.accepted`     | `investigation accepted`            | `main.ts` — create `investigations` row |
| `investigation.started`      | `investigation started`             | `service.ts`                            |
| `investigation.failed`       | `investigation failed`              | unhandled error in background task      |
| `investigation.parse_failed` | `investigation could not be parsed` | final parse failure                     |


### Agent execution


| Event                      | Source message                                                |
| -------------------------- | ------------------------------------------------------------- |
| `agent.created`            | `cursor agent created`                                        |
| `agent.prompt_sent`        | `investigation prompt sent`                                   |
| `agent.run_finished`       | `investigation run finished`                                  |
| `agent.parse_retry`        | `investigation response parse failed, retrying on same agent` |
| `agent.retry_prompt_sent`  | `investigation retry prompt sent`                             |
| `agent.retry_run_finished` | `investigation retry run finished`                            |


### Verdict handling


| Event                  | Source message                                      |
| ---------------------- | --------------------------------------------------- |
| `verdict.spam`         | `report rejected` (verdict=SPAM)                    |
| `verdict.valid`        | `issue is VALID, proceeding to create GitHub issue` |
| `verdict.notification` | `investigation verdict notification`                |
| `github.issue_created` | from `utils.ts` on success                          |
| `github.issue_failed`  | `failed to create GitHub issue`                     |
| `email.sent`           | from `utils.ts` on success                          |
| `email.failed`         | from `utils.ts` on failure                          |


### HTTP / system


| Event                    | Source message      |
| ------------------------ | ------------------- |
| `http.request_completed` | `request completed` |
| `system.started`         | `server listening`  |
| `system.shutdown`        | `shutting down`     |


---

## Write Path (summary)

Logs and workflow milestones map to tables as follows. Implementation details (logger transport, etc.) are deferred.


| Trigger                | `investigations`                        | `log_events`                    |
| ---------------------- | --------------------------------------- | ------------------------------- |
| Investigation accepted | insert, `status=accepted`               | `investigation.accepted`        |
| Workflow starts        | update `status=running`, `started_at`   | `investigation.started`         |
| Agent created          | set `agent_id`                          | `agent.created`                 |
| Prompt sent            | set `run_id`                            | `agent.prompt_sent`             |
| Run finished           | set `cursor_request_id`, verdict fields | `agent.run_finished`            |
| Workflow completes     | update `status=finished`, `finished_at` | verdict / github / email events |
| Unhandled error        | update `status=failed`, `error`         | `investigation.failed`          |


Normalize free-text logger messages to stable `event` names (see taxonomy above). Strip large blobs before writing `log_events.contents`.

---

## DuckDB Analytics Layer

### DuckDB ↔ SQLite mechanics

DuckDB does **not** share memory or a connection pool with the bugfixagent SQLite store. It reads the SQLite **file on disk** through DuckDB's built-in `**sqlite` extension**. Tables in the `.db` file appear as external tables in DuckDB's catalog; query execution reads SQLite pages at runtime via the extension.

```
bugfixagent (Node)  ──writes──►  bugfixagent.db (SQLite, WAL)
                                      ▲
                                      │ READ_ONLY ATTACH (sync job only)
sync-duckdb.ts      ──reads───────────┘
                    ──writes──►  analytics.duckdb (native DuckDB tables + rollups)
```

#### How to connect

The extension autoloads on first use. Manual install is optional:

```sql
INSTALL sqlite;   -- once per environment
LOAD sqlite;
```

**Attach the whole database** (preferred when querying multiple tables):

```sql
ATTACH './data/bugfixagent.db' AS ops (TYPE sqlite, READ_ONLY);

SELECT verdict, count(*)
FROM ops.investigations
WHERE created_at >= '2026-06-18'
GROUP BY 1;
```

**Scan a single table** (fine for one-off inspection):

```sql
SELECT *
FROM sqlite_scan('./data/bugfixagent.db', 'log_events')
WHERE timestamp >= '2026-06-18T00:00:00Z';
```

After `ATTACH`, tables are referenced as `ops.investigations`, `ops.log_events`, etc. The deprecated `sqlite_attach()` function should not be used; prefer `ATTACH ... TYPE sqlite`.

Docs: [DuckDB SQLite integration](https://duckdb.org/docs/current/guides/database_integration/sqlite.html)

#### Two query patterns


| Pattern                   | What happens                                                                                            | Freshness                         | Best for                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| **A — Direct query**      | Rollups run against `ops.`* tables; data read from SQLite file on every query                           | Always current                    | Ad-hoc SQL, low-frequency reports |
| **B — Copy then analyze** | Sync job `CREATE OR REPLACE TABLE ... AS SELECT * FROM ops.`*, then rollups run on native DuckDB tables | Stale by sync interval (5–15 min) | Repeated analytics queries        |


**Recommended for bugfixagent:** Pattern B. The live app keeps writing to SQLite; the sync job reads once per interval and materializes into `analytics.duckdb`. Analytics queries target DuckDB, not the hot SQLite file.

Pattern A example (direct):

```sql
ATTACH './data/bugfixagent.db' AS ops (TYPE sqlite, READ_ONLY);

CREATE OR REPLACE TABLE hourly_stats AS
SELECT
  date_trunc('hour', created_at::TIMESTAMP) AS hour,
  count(*) AS runs
FROM ops.investigations
GROUP BY 1;
```

Pattern B example (copy then analyze — preferred):

```sql
ATTACH './data/bugfixagent.db' AS ops (TYPE sqlite, READ_ONLY);

-- snapshot operational tables into native DuckDB storage
CREATE OR REPLACE TABLE investigations AS SELECT * FROM ops.investigations;
CREATE OR REPLACE TABLE log_events      AS SELECT * FROM ops.log_events;

-- rollups run on columnar DuckDB tables (fast for repeated reads)
CREATE OR REPLACE TABLE hourly_stats AS
SELECT
  date_trunc('hour', created_at::TIMESTAMP) AS hour,
  count(*) AS runs,
  count(*) FILTER (WHERE verdict = 'VALID') AS valid,
  count(*) FILTER (WHERE verdict = 'SPAM') AS spam,
  count(*) FILTER (WHERE status = 'failed') AS failed,
  avg(epoch(finished_at::TIMESTAMP) - epoch(started_at::TIMESTAMP)) AS avg_duration_sec
FROM investigations
WHERE finished_at IS NOT NULL
GROUP BY 1;
```

#### Concurrency and ownership


| Actor                          | SQLite file                      | DuckDB file                                    |
| ------------------------------ | -------------------------------- | ---------------------------------------------- |
| bugfixagent (`better-sqlite3`) | **read/write** (source of truth) | no access                                      |
| sync job                       | **read-only** via `ATTACH`       | **read/write** (analytics snapshots + rollups) |
| analytics consumers            | ideally reads **DuckDB only**    | read                                           |


Rules:

- **Single writer on SQLite:** only bugfixagent inserts/updates. Do not let DuckDB write back to the SQLite file in v1.
- **WAL mode:** enable on SQLite (`PRAGMA journal_mode=WAL`) so the sync job can read while the app writes. Brief read locks are possible but acceptable at our volume.
- `**READ_ONLY` attach:** always pass `READ_ONLY` when DuckDB opens `bugfixagent.db` to avoid accidental writes and reduce lock contention.
- **Separate files:** `bugfixagent.db` (operational) and `analytics.duckdb` (derived). Losing or rebuilding analytics.duckdb is safe — re-run sync.

DuckDB **can** write to an attached SQLite database (the extension supports read/write), but two writers on one file adds complexity we do not need at this scale.

---

### Data Model (DuckDB)

Derived tables in `analytics.duckdb`. Refreshed by sync job from SQLite (Pattern B).

#### Snapshot tables (copy from SQLite)

```sql
-- refreshed each sync
CREATE OR REPLACE TABLE investigations AS SELECT * FROM ops.investigations;
CREATE OR REPLACE TABLE log_events      AS SELECT * FROM ops.log_events;
```

#### `hourly_stats`

```sql
CREATE OR REPLACE TABLE hourly_stats AS
SELECT
  date_trunc('hour', created_at::TIMESTAMP) AS hour,
  count(*) AS runs,
  count(*) FILTER (WHERE verdict = 'VALID') AS valid,
  count(*) FILTER (WHERE verdict = 'SPAM') AS spam,
  count(*) FILTER (WHERE status = 'failed') AS failed,
  avg(epoch(finished_at::TIMESTAMP) - epoch(started_at::TIMESTAMP)) AS avg_duration_sec
FROM investigations
WHERE finished_at IS NOT NULL
GROUP BY 1;
```

#### Example analytics (ad-hoc SQL)

- Verdict distribution last 24h / 7d — query `investigations` snapshot (or sum `hourly_stats` for valid/spam/failed only)
- P50 / P95 investigation duration (`finished_at - started_at`)
- Parse retry rate (`agent.parse_retry` / total runs)
- Throughput by hour
- GitHub issue creation success rate

### Sync strategy

Use **Pattern B** (copy then analyze) on a schedule unless ad-hoc exploration calls for Pattern A.

- **Scheduled:** every 5–15 minutes — refresh snapshot tables + rollups.
- **Event-triggered (optional):** sync when `investigations.status` transitions to `finished` for fresher rollups.

#### Alternatives (out of scope for v1)


| Method                                        | When to consider                                          |
| --------------------------------------------- | --------------------------------------------------------- |
| SQLite → Parquet export, DuckDB reads Parquet | Cold archive after retention purge                        |
| Single SQLite for everything                  | Possible at our volume, but mixes OLTP and analytics load |


---

## Retention


| Tier  | Store                     | Retention          | Action                                                            |
| ----- | ------------------------- | ------------------ | ----------------------------------------------------------------- |
| Hot   | SQLite                    | 14–30 days         | Delete finished investigations + events; keep rollups in DuckDB   |
| Warm  | DuckDB                    | 1+ years           | Hourly/daily aggregates                                           |
| Cold  | Parquet export (optional) | indefinite         | `COPY investigations TO 'archive/...parquet'` before SQLite purge |
| Debug | stdout                    | deployment default | optional ship to Loki/Datadog                                     |


At ~100K events/day, 30 days ≈ 3M rows — fine for SQLite with indexes.

---

## Configuration

New env vars (proposed):

```env
METRIC_STORE_ENABLED=true
METRIC_STORE_SQLITE_PATH=./data/bugfixagent.db
METRIC_STORE_DUCKDB_PATH=./data/analytics.duckdb
METRIC_STORE_RETENTION_DAYS=30
METRIC_STORE_SYNC_INTERVAL_MIN=10
```

Add to `config.ts` when implementing. Default `METRIC_STORE_ENABLED=false` so existing deployments are unaffected.

---

## File Layout (proposed)

```
bugfixagent/
  agents/
    metric-store-plan.md          ← this document
  metric-store/
    schema.sql                    ← SQLite + DuckDB DDL
    events.ts                     ← message → event normalization
    sync-duckdb.sql               ← rollup definitions
    retention.sql                 ← purge queries
  data/
    bugfixagent.db                ← SQLite (gitignored)
    analytics.duckdb              ← DuckDB (gitignored)
```

---

## Implementation Phases

### Phase 1 — SQLite schema

- [ ] `investigations` + `log_events` DDL and indexes
- [ ] WAL mode and migration strategy
- [ ] Event taxonomy registry (`events.ts`)
- [ ] Write-path mapping (logger → tables)

### Phase 2 — DuckDB schema

- [ ] Snapshot table definitions
- [ ] `hourly_stats` rollup
- [ ] Sync job SQL (Pattern B)

### Phase 3 — Retention

- [ ] SQLite hot-data purge (finished investigations + events)
- [ ] Optional Parquet cold archive before purge

---

## Design Decisions

1. **Single instance** — v1 assumes one bugfixagent process writing to one SQLite file. No multi-replica, libsql/Turso, or Postgres unless requirements change later.
2. **Email tracking** — no `email_sent_at` on `investigations`. Email outcomes live in `log_events` (`email.sent` / `email.failed`). `github_issue_url` is the only first-class downstream-outcome column for GitHub.
3. **Second-step fix PR** — not in scope. Schema covers the investigation workflow (step 1) only; extend when `secondStepWriteFixPR` is implemented.

### Deferred (out of v1 scope)

- **Large blob retention** — v1 omits prompts, user reports, and raw agent results from the metric store; replay via Cursor API. Revisit an `artifacts` table if local audit copies are needed.
- **Second-step workflow schema** — defer `workflow_step` or `fix_runs` table until fix-PR automation is built.
- **`verdict_daily` rollup** — defer; full verdict-by-day queries run ad-hoc against the `investigations` snapshot (daily totals for valid/spam/failed can be derived from `hourly_stats`).

---

## References

- `logger.ts` — current log format and `investigationLogMeta`
- `service.ts` — investigation workflow and event emission points
- `inspect-run.ts` — Cursor API drill-down for conversation/tool steps
- `recent-runs.ts` — ad hoc cloud run listing (superseded by SQL queries against `investigations` once populated)


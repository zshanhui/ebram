-- Bugfixagent analytics queries (DuckDB)
--
-- Prerequisite: run sync first
--   python3 admin/sync_analytics.py
--
-- Usage:
--   duckdb ./data/analytics.duckdb
--   .read admin/analytic-queries.sql        -- runs all statements below
--
-- Or run a single query:
--   duckdb ./data/analytics.duckdb -c "SELECT ..."
--
-- Tables: investigations, log_events (snapshots), hourly_stats (rollup)


-- =============================================================================
-- 1. Throughput & health (hourly_stats)
-- =============================================================================

-- Last 24 hours of throughput
SELECT
  hour,
  runs,
  valid,
  spam,
  failed,
  round(avg_duration_sec, 1) AS avg_sec
FROM hourly_stats
WHERE hour >= now() - INTERVAL '24 hours'
ORDER BY hour;

-- Daily totals (sum hourly buckets), last 7 days
SELECT
  date_trunc('day', hour) AS day,
  sum(runs) AS runs,
  sum(valid) AS valid,
  sum(spam) AS spam,
  sum(failed) AS failed
FROM hourly_stats
GROUP BY 1
ORDER BY 1 DESC
LIMIT 7;

-- Valid bug rate (of finished runs with a verdict bucket), last 7 days
SELECT
  sum(valid) * 100.0 / nullif(sum(valid + spam), 0) AS valid_pct
FROM hourly_stats
WHERE hour >= now() - INTERVAL '7 days';


-- =============================================================================
-- 2. Verdict mix (investigations)
-- =============================================================================

-- Verdict distribution, last 7 days
SELECT verdict, count(*) AS n
FROM investigations
WHERE created_at::TIMESTAMP >= now() - INTERVAL '7 days'
  AND verdict IS NOT NULL
GROUP BY 1
ORDER BY n DESC;

-- Status breakdown (accepted / running / finished / failed)
SELECT status, count(*) AS n
FROM investigations
GROUP BY 1;

-- Effort breakdown for VALID reports
SELECT effort, count(*) AS n
FROM investigations
WHERE verdict = 'VALID'
GROUP BY 1
ORDER BY n DESC;


-- =============================================================================
-- 3. Duration & latency (investigations)
-- =============================================================================

-- P50 / P95 investigation duration (seconds)
SELECT
  quantile_cont(
    epoch(finished_at::TIMESTAMP) - epoch(started_at::TIMESTAMP),
    0.5
  ) AS p50_sec,
  quantile_cont(
    epoch(finished_at::TIMESTAMP) - epoch(started_at::TIMESTAMP),
    0.95
  ) AS p95_sec
FROM investigations
WHERE started_at IS NOT NULL
  AND finished_at IS NOT NULL;

-- Slowest recent investigations
SELECT
  id,
  verdict,
  round(epoch(finished_at::TIMESTAMP) - epoch(started_at::TIMESTAMP), 1) AS duration_sec,
  created_at
FROM investigations
WHERE finished_at IS NOT NULL
  AND started_at IS NOT NULL
ORDER BY duration_sec DESC
LIMIT 20;

-- Average duration by verdict
SELECT
  verdict,
  count(*) AS n,
  round(avg(epoch(finished_at::TIMESTAMP) - epoch(started_at::TIMESTAMP)), 1) AS avg_sec
FROM investigations
WHERE finished_at IS NOT NULL
  AND started_at IS NOT NULL
GROUP BY 1;


-- =============================================================================
-- 4. Agent reliability (log_events)
-- =============================================================================

-- Parse retry rate (% of investigations that needed a retry)
SELECT
  count(DISTINCT CASE WHEN event = 'agent.parse_retry' THEN investigation_id END) * 100.0
  / nullif(count(DISTINCT investigation_id), 0) AS parse_retry_pct
FROM log_events;

-- Event volume breakdown
SELECT event, count(*) AS n
FROM log_events
GROUP BY 1
ORDER BY n DESC;

-- Investigations that failed outright
SELECT id, created_at, error
FROM investigations
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;

-- Parse failures (agent couldn't return valid JSON)
SELECT count(DISTINCT investigation_id) AS parse_failed_count
FROM log_events
WHERE event = 'investigation.parse_failed';


-- =============================================================================
-- 5. Downstream outcomes — GitHub & email
-- =============================================================================

-- GitHub issue creation success rate (among VALID verdicts)
SELECT
  count(*) FILTER (WHERE verdict = 'VALID') AS valid_count,
  count(*) FILTER (WHERE github_issue_url IS NOT NULL) AS issues_created,
  count(*) FILTER (WHERE verdict = 'VALID' AND github_issue_url IS NULL) AS valid_no_issue
FROM investigations;

-- GitHub failures from log events
SELECT count(*) AS github_failures
FROM log_events
WHERE event = 'github.issue_failed';

-- Email delivery outcomes
SELECT event, count(*) AS n
FROM log_events
WHERE event IN ('email.sent', 'email.failed')
GROUP BY 1;

-- End-to-end funnel: accepted → finished → valid → issue created
SELECT
  count(*) AS accepted,
  count(*) FILTER (WHERE status = 'finished') AS finished,
  count(*) FILTER (WHERE verdict = 'VALID') AS valid,
  count(*) FILTER (WHERE github_issue_url IS NOT NULL) AS issue_created
FROM investigations;


-- =============================================================================
-- 6. Input quality & spam filtering
-- =============================================================================

-- Spam vs legitimate over time
SELECT
  date_trunc('day', created_at::TIMESTAMP) AS day,
  count(*) FILTER (WHERE verdict = 'SPAM') AS spam,
  count(*) FILTER (WHERE verdict = 'VALID') AS valid,
  count(*) FILTER (WHERE verdict = 'NOT_VALID') AS not_valid
FROM investigations
WHERE verdict IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;

-- Average report message length by verdict
SELECT
  verdict,
  round(avg(message_length), 0) AS avg_message_len
FROM investigations
WHERE message_length IS NOT NULL
GROUP BY 1;


-- =============================================================================
-- 7. Ops / stuck runs
-- =============================================================================

-- Stuck in "running" (may indicate agent hang or crash)
SELECT id, created_at, started_at, agent_id, run_id
FROM investigations
WHERE status = 'running'
ORDER BY started_at;

-- Accepted but never started (> 1 hour)
SELECT id, created_at
FROM investigations
WHERE status = 'accepted'
  AND created_at::TIMESTAMP < now() - INTERVAL '1 hour';

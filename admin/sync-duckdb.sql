-- Snapshot operational tables from SQLite (ops schema attached by sync_analytics.py).
CREATE OR REPLACE TABLE investigations AS SELECT * FROM ops.investigations;
CREATE OR REPLACE TABLE log_events AS SELECT * FROM ops.log_events;

-- Hourly rollup for dashboards and long-term retention.
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

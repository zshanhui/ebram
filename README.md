# README.md

ebram is an email based agent workflow orchestrator for common dev/admin backoffice chores

design goals
  - the agent system is designed to exist and operated from a custom email domain, eg ebram@wuweisoftware.dev
  - simple and portable deployment on a single instance with Docker, easy for SMEs or solo devs to manage and operate
  - see all the logs and metrics, manage token spend
  - the primary interface is email
  - async first, event based architecture
  - humans in the loop, but configurable levels of autonomy

common tasks that can be delegated to ebram
  - investigation of new bug reports to see if its valid
  - fixing simple bugs after investigation via trigger from email or Github issue
  - filtering out spam emails before they get to your inbox (wip)
  - aggregating and summarising feedback from users

components
  - `orchestration-service`: light node service that orchestrates the cursor sdk agent, used for our internal projects
  - `sqlite+duckdb` store for metrics and analytics on agent runs
  - `emailworker`: another service worker (Cloudflare) that is a email forwarder that talks to this service to trigger agents to work on assigned tasks

agent harness support
  - just cursorsdk for now
  - pi agent + open models are planned


## Deploy to Railway

Push the repo and create a new Railway service from it (Railway will pick up railway.toml + Dockerfile).

Set these environment variables in Railway (from .env.example):

EBRAM_API_ACCESS_KEY, CURSOR_API_KEY, GITHUB_REPO, GITHUB_TOKEN
DEV_NOTIFICATION_EMAIL, RESEND_API_KEY, MAIL_FROM
Railway sets PORT automatically — no need to configure it
Optional but recommended: attach a Railway volume mounted at /app/data so SQLite investigation logs survive redeploys. The container already sets RECORD_STORE_SQLITE_PATH=/app/data/bugfixagent.db.

Point your Cloudflare email worker at the Railway URL:


BUGFIXAGENT_URL=https://your-app.up.railway.app

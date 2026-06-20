import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

export const INVESTIGATION_STATUSES = ['accepted', 'running', 'finished', 'failed'] as const
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number]

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export type InvestigationRow = {
  id: string
  status: InvestigationStatus
  verdict: string | null
  message_length: number | null
  repo_url: string | null
  agent_id: string | null
  run_id: string | null
  cursor_request_id: string | null
  title: string | null
  effort: string | null
  github_issue_url: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export type LogEventRow = {
  id: number
  timestamp: string
  investigation_id: string | null
  level: LogLevel
  event: string
  message: string
  contents: string | null
}

export type InvestigationPatch = {
  status?: InvestigationStatus
  verdict?: string | null
  message_length?: number | null
  repo_url?: string | null
  agent_id?: string | null
  run_id?: string | null
  cursor_request_id?: string | null
  title?: string | null
  effort?: string | null
  github_issue_url?: string | null
  error?: string | null
  started_at?: string | null
  finished_at?: string | null
}

export type InsertLogEventInput = {
  level: LogLevel
  message: string
  investigationId?: string | null
  event?: string
  contents?: Record<string, unknown> | null
  timestamp?: string
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS investigations (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  verdict           TEXT,
  message_length    INTEGER,
  repo_url          TEXT,
  agent_id          TEXT,
  run_id            TEXT,
  cursor_request_id TEXT,
  title             TEXT,
  effort            TEXT,
  github_issue_url  TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations(status);
CREATE INDEX IF NOT EXISTS idx_investigations_created ON investigations(created_at);
CREATE INDEX IF NOT EXISTS idx_investigations_verdict ON investigations(verdict);

CREATE TABLE IF NOT EXISTS log_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        TEXT NOT NULL,
  investigation_id TEXT,
  level            TEXT NOT NULL,
  event            TEXT NOT NULL,
  message          TEXT NOT NULL,
  contents         TEXT
);

CREATE INDEX IF NOT EXISTS idx_log_events_investigation_timestamp ON log_events(investigation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_log_events_timestamp ON log_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_log_events_event ON log_events(event);
`

const EVENT_BY_MESSAGE: Record<string, string> = {
  'investigation accepted': 'investigation.accepted',
  'investigation started': 'investigation.started',
  'investigation failed': 'investigation.failed',
  'investigation could not be parsed': 'investigation.parse_failed',
  'cursor agent created': 'agent.created',
  'investigation prompt': 'agent.prompt_prepared',
  'investigation prompt sent': 'agent.prompt_sent',
  'investigation run finished': 'agent.run_finished',
  'investigation response parse failed, retrying on same agent': 'agent.parse_retry',
  'investigation retry prompt sent': 'agent.retry_prompt_sent',
  'investigation retry run finished': 'agent.retry_run_finished',
  'issue is VALID, proceeding to create GitHub issue': 'verdict.valid',
  'investigation verdict notification': 'verdict.notification',
  'failed to create GitHub issue': 'github.issue_failed',
  'GitHub issue created': 'github.issue_created',
  'openGithubIssue failed': 'github.issue_failed',
  'dev notification email sent': 'email.sent',
  'Resend error': 'email.failed',
}

/** Keys stripped from log_events.contents (raw agent output only). */
const STRIPPED_CONTENT_KEYS = new Set(['result'])

const INVESTIGATION_PATCH_COLUMNS = [
  'status',
  'verdict',
  'message_length',
  'repo_url',
  'agent_id',
  'run_id',
  'cursor_request_id',
  'title',
  'effort',
  'github_issue_url',
  'error',
  'started_at',
  'finished_at',
] as const satisfies readonly (keyof InvestigationPatch)[]

function nowIso(): string {
  return new Date().toISOString()
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return JSON.stringify({ name: error.name, message: error.message, stack: error.stack })
  }
  return JSON.stringify({ message: String(error) })
}

function asOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return String(value)
}

function asOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

export function sanitizeContents(meta?: Record<string, unknown>): Record<string, unknown> | null {
  if (!meta) return null

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (STRIPPED_CONTENT_KEYS.has(key)) continue
    if (key === 'investigationRequestId') continue
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message, stack: value.stack }
      continue
    }
    out[key] = value
  }

  return Object.keys(out).length > 0 ? out : null
}

export function normalizeEvent(message: string, contents?: Record<string, unknown> | null): string | null {
  if (message === 'report rejected') {
    return contents?.verdict === 'SPAM' ? 'verdict.spam' : 'verdict.notification'
  }

  if (message.startsWith('openGithubIssue skipped:')) return 'github.issue_failed'
  if (message.startsWith('sendDevNotificationEmail skipped:')) return 'email.failed'

  return EVENT_BY_MESSAGE[message] ?? null
}

export function shouldPersistLog(message: string): boolean {
  return normalizeEvent(message) !== null
}

export class RecordStore {
  private readonly db: Database.Database

  private readonly insertInvestigationStmt: Database.Statement<
    [string, InvestigationStatus, number | null, string]
  >

  private readonly insertLogEventStmt: Database.Statement<
    [string, string | null, LogLevel, string, string, string | null]
  >

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()

    this.insertInvestigationStmt = this.db.prepare(`
      INSERT INTO investigations (id, status, message_length, created_at)
      VALUES (?, ?, ?, ?)
    `)

    this.insertLogEventStmt = this.db.prepare(`
      INSERT INTO log_events (timestamp, investigation_id, level, event, message, contents)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
  }

  migrate(): void {
    this.db.exec(SCHEMA_SQL)
  }

  close(): void {
    this.db.close()
  }

  acceptInvestigation(input: { id: string; messageLength?: number; createdAt?: string }): InvestigationRow {
    const createdAt = input.createdAt ?? nowIso()
    this.insertInvestigationStmt.run(input.id, 'accepted', input.messageLength ?? null, createdAt)
    return this.getInvestigationOrThrow(input.id)
  }

  updateInvestigation(id: string, patch: InvestigationPatch): InvestigationRow {
    const assignments: string[] = []
    const values: unknown[] = []

    for (const column of INVESTIGATION_PATCH_COLUMNS) {
      if (!(column in patch)) continue
      assignments.push(`${column} = ?`)
      values.push(patch[column])
    }

    if (assignments.length === 0) {
      return this.getInvestigationOrThrow(id)
    }

    const result = this.db
      .prepare(`UPDATE investigations SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values, id)

    if (result.changes === 0) {
      throw new Error(`investigation not found: ${id}`)
    }

    return this.getInvestigationOrThrow(id)
  }

  insertLogEvent(input: InsertLogEventInput): LogEventRow | null {
    const event = input.event ?? normalizeEvent(input.message, input.contents)
    if (!event) return null

    const contentsJson = input.contents ? JSON.stringify(input.contents) : null
    const timestamp = input.timestamp ?? nowIso()
    const result = this.insertLogEventStmt.run(
      timestamp,
      input.investigationId ?? null,
      input.level,
      event,
      input.message,
      contentsJson,
    )

    return this.getLogEvent(Number(result.lastInsertRowid))
  }

  recordLog(level: LogLevel, message: string, meta?: Record<string, unknown>): LogEventRow | null {
    const contents = sanitizeContents(meta)
    const event = normalizeEvent(message, contents)
    if (!event) return null

    const investigationId =
      typeof meta?.investigationRequestId === 'string' ? meta.investigationRequestId : null

    const row = this.insertLogEvent({
      level,
      message,
      investigationId,
      event,
      contents: contents ?? undefined,
    })

    if (row && investigationId) {
      this.applyInvestigationEffects(investigationId, event, message, contents, meta)
    }

    return row
  }

  getInvestigation(id: string): InvestigationRow | undefined {
    return this.db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as
      | InvestigationRow
      | undefined
  }

  getInvestigationOrThrow(id: string): InvestigationRow {
    const row = this.getInvestigation(id)
    if (!row) throw new Error(`investigation not found: ${id}`)
    return row
  }

  listLogEvents(investigationId: string, limit = 100): LogEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM log_events
         WHERE investigation_id = ?
         ORDER BY timestamp ASC, id ASC
         LIMIT ?`,
      )
      .all(investigationId, limit) as LogEventRow[]
  }

  private getLogEvent(id: number): LogEventRow {
    return this.db.prepare('SELECT * FROM log_events WHERE id = ?').get(id) as LogEventRow
  }

  private applyInvestigationEffects(
    investigationId: string,
    event: string,
    _message: string,
    contents: Record<string, unknown> | null,
    meta?: Record<string, unknown>,
  ): void {
    const patch: InvestigationPatch = {}

    switch (event) {
      case 'investigation.started':
        patch.status = 'running'
        patch.started_at = nowIso()
        patch.message_length = asOptionalNumber(contents?.messageLength)
        patch.repo_url = asOptionalString(contents?.repoUrl)
        break
      case 'agent.created':
        patch.agent_id = asOptionalString(contents?.agentId)
        break
      case 'agent.prompt_sent':
      case 'agent.retry_prompt_sent':
        patch.run_id = asOptionalString(contents?.runId)
        break
      case 'agent.run_finished':
      case 'agent.retry_run_finished':
        patch.agent_id = asOptionalString(contents?.agentId)
        patch.run_id = asOptionalString(contents?.runId)
        patch.cursor_request_id = asOptionalString(contents?.requestId)
        break
      case 'verdict.valid':
      case 'verdict.notification':
      case 'verdict.spam':
        patch.status = 'finished'
        patch.finished_at = nowIso()
        patch.verdict = asOptionalString(contents?.verdict)
        patch.title = asOptionalString(contents?.title)
        patch.effort = asOptionalString(contents?.effort)
        break
      case 'investigation.parse_failed':
        patch.status = 'finished'
        patch.finished_at = nowIso()
        break
      case 'investigation.failed':
        patch.status = 'failed'
        patch.finished_at = nowIso()
        patch.error = meta?.error !== undefined ? serializeError(meta.error) : null
        break
      case 'github.issue_created': {
        const issueUrl = asOptionalString(contents?.issueUrl)
        if (issueUrl) patch.github_issue_url = issueUrl
        break
      }
      default:
        break
    }

    if (Object.keys(patch).length > 0) {
      this.updateInvestigation(investigationId, patch)
    }
  }
}

export function openRecordStore(dbPath: string): RecordStore {
  return new RecordStore(dbPath)
}

let singleton: RecordStore | null | undefined

/** Lazily opens the configured SQLite record store, or null when disabled. */
export function getRecordStore(): RecordStore | null {
  if (singleton !== undefined) return singleton

  singleton = config.recordStoreEnabled
    ? openRecordStore(config.recordStoreSqlitePath)
    : null

  return singleton
}

export function closeRecordStore(): void {
  singleton?.close()
  singleton = undefined
}

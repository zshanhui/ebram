import { config as loadEnv } from 'dotenv'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBugTriageConfig } from './ebram-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

loadEnv({ path: join(repoRoot, '.env') })

const REQUIRED_ENV_VARS = [
  'EBRAM_API_ACCESS_KEY',
  'CURSOR_API_KEY',
  'GITHUB_TOKEN',
  'RESEND_API_KEY',
  'MAIL_FROM',
] as const

type RequiredEnvVar = typeof REQUIRED_ENV_VARS[number]

function loadRequiredEnvVars(): Record<RequiredEnvVar, string> {
  const missing: string[] = []
  const result = {} as Record<RequiredEnvVar, string>

  for (const name of REQUIRED_ENV_VARS) {
    const trimmed = process.env[name]?.trim()
    if (!trimmed) {
      missing.push(name)
    } else {
      result[name] = trimmed
    }
  }

  if (missing.length > 0) {
    console.error(
      `Missing required environment variables:\n${missing.map((name) => `  - ${name}`).join('\n')}`,
    )
    process.exit(1)
  }

  return result
}

const env = loadRequiredEnvVars()

// agent_backend / agent_model / github_repo / store_records /
// dev_notification_email come from ebram.config.yaml (orchestrator.bug_triage);
// secrets like CURSOR_API_KEY stay in env vars.
let bugTriage
try {
  bugTriage = loadBugTriageConfig(repoRoot)
} catch (error) {
  console.error(`Invalid ebram.config.yaml:\n${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  apiAccessKey: env.EBRAM_API_ACCESS_KEY,
  cursorApiKey: env.CURSOR_API_KEY,
  agentBackend: bugTriage.agentBackend,
  agentModel: bugTriage.agentModel,
  githubRepo: bugTriage.githubRepo,
  githubToken: env.GITHUB_TOKEN,
  devNotificationEmail: bugTriage.devNotificationEmail,
  resendApiKey: env.RESEND_API_KEY,
  mailFrom: env.MAIL_FROM,
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 2),
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
  logLevel: (process.env.LOG_LEVEL?.toLowerCase() ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  recordStoreEnabled: bugTriage.storeRecords,
  recordStoreSqlitePath: process.env.RECORD_STORE_SQLITE_PATH?.trim() || join(repoRoot, 'data', 'bugfixagent.db'),
  recordStoreDuckdbPath: process.env.RECORD_STORE_DUCKDB_PATH?.trim() || join(repoRoot, 'data', 'analytics.duckdb'),
} as const

export type Config = typeof config

import { config as loadEnv } from 'dotenv'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

loadEnv({ path: join(__dirname, '.env') })

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`missing required env var: ${name}`)
  }
  return trimmed
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  apiAccessKey: required('API_ACCESS_KEY', process.env.API_ACCESS_KEY),
  cursorApiKey: required('CURSOR_API_KEY', process.env.CURSOR_API_KEY),
  devNotificationEmail: required('DEV_NOTIFICATION_EMAIL', process.env.DEV_NOTIFICATION_EMAIL),
  githubRepo: required('GITHUB_REPO', process.env.GITHUB_REPO),
  githubToken: optional(process.env.GITHUB_TOKEN),
  resendApiKey: optional(process.env.RESEND_API_KEY),
  mailFrom: optional(process.env.MAIL_FROM),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 2),
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
  logLevel: (process.env.LOG_LEVEL?.toLowerCase() ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const

export type Config = typeof config

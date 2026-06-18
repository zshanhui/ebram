import { config } from './config.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const configuredLevel = config.logLevel as LogLevel
const minLevel = LEVEL_RANK[configuredLevel] ?? LEVEL_RANK.info
const pretty = config.nodeEnv !== 'production'

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

function serializeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    out[key] = serializeValue(value)
  }
  return out
}

function write(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
  if (LEVEL_RANK[level] < minLevel) return

  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'bugfixagent',
    msg,
    ...serializeMeta(meta),
  }

  const line = pretty
    ? `${entry.ts} ${level.toUpperCase()} ${msg}${meta ? ` ${JSON.stringify(serializeMeta(meta))}` : ''}`
    : JSON.stringify(entry)

  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
}

export function investigationLogMeta(
  investigationRequestId: string,
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  return { investigationRequestId, ...meta }
}

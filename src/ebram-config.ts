// Loader for ebram.config.yaml (repo root) — the shared ebram config file.
//
// The email worker (efw) bundles this file at BUILD time via wrangler; the
// orchestrator service reads it from disk at RUNTIME (startup, fail fast).
// The file must therefore ship next to the app (the Dockerfile copies it
// into the runtime image).
//
// Only the orchestrator.bug_triage section is consumed here; the spam
// section belongs to the worker (see efw/src/spam-config.ts).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as yamlLoad } from 'js-yaml'

export const SUPPORTED_AGENT_BACKENDS = ['cursor'] as const

export type AgentBackend = (typeof SUPPORTED_AGENT_BACKENDS)[number]

export type BugTriageConfig = {
  agentBackend: AgentBackend
  agentModel: string
  githubRepo: string
  /** Persist investigation logs to SQLite (default: true). */
  storeRecords: boolean
  /** Where investigation result notifications are sent. */
  devNotificationEmail: string
}

type EbramConfigFile = {
  orchestrator?: {
    bug_triage?: {
      agent_backend?: unknown
      agent_model?: unknown
      github_repo?: unknown
      store_records?: unknown
      dev_notification_email?: unknown
    }
  }
}

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Parse and validate the orchestrator.bug_triage section from yaml text. */
export function parseBugTriageConfig(yamlText: string): BugTriageConfig {
  let parsed: EbramConfigFile
  try {
    parsed = yamlLoad(yamlText) as EbramConfigFile
  } catch (err) {
    throw new Error(
      `ebram.config.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const bugTriage = parsed?.orchestrator?.bug_triage
  if (!bugTriage || typeof bugTriage !== 'object') {
    throw new Error("ebram.config.yaml is missing the 'orchestrator.bug_triage' section")
  }

  const agentBackend = bugTriage.agent_backend
  if (
    typeof agentBackend !== 'string' ||
    !SUPPORTED_AGENT_BACKENDS.includes(agentBackend as AgentBackend)
  ) {
    throw new Error(
      `ebram.config.yaml orchestrator.bug_triage.agent_backend must be one of ` +
        `${SUPPORTED_AGENT_BACKENDS.join(', ')} (got: ${JSON.stringify(agentBackend)})`,
    )
  }

  const agentModel = bugTriage.agent_model
  if (typeof agentModel !== 'string' || !agentModel.trim()) {
    throw new Error(
      `ebram.config.yaml orchestrator.bug_triage.agent_model must be a non-empty string ` +
        `(got: ${JSON.stringify(agentModel)})`,
    )
  }

  const githubRepo = bugTriage.github_repo
  if (typeof githubRepo !== 'string' || !GITHUB_REPO_RE.test(githubRepo.trim())) {
    throw new Error(
      'ebram.config.yaml orchestrator.bug_triage.github_repo must be in owner/repo format ' +
        `(got: ${JSON.stringify(githubRepo)})`,
    )
  }

  // Optional: absent means "keep recording" (matches the old
  // RECORD_STORE_ENABLED env behaviour). A present but non-boolean value is
  // a config error — fail fast rather than guessing intent.
  const storeRecords = (() => {
    if (typeof bugTriage.store_records === 'undefined') return true
    if (typeof bugTriage.store_records === 'boolean') return bugTriage.store_records
    throw new Error(
      `ebram.config.yaml orchestrator.bug_triage.store_records must be a boolean ` +
        `(got: ${JSON.stringify(bugTriage.store_records)})`,
    )
  })()

  const devNotificationEmail = bugTriage.dev_notification_email
  if (
    typeof devNotificationEmail !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(devNotificationEmail.trim())
  ) {
    throw new Error(
      'ebram.config.yaml orchestrator.bug_triage.dev_notification_email must be a valid email ' +
        `(got: ${JSON.stringify(devNotificationEmail)})`,
    )
  }

  return {
    agentBackend: agentBackend as AgentBackend,
    agentModel: agentModel.trim(),
    githubRepo: githubRepo.trim(),
    storeRecords,
    devNotificationEmail: devNotificationEmail.trim(),
  }
}

/** Read ebram.config.yaml from disk (repo root) and parse the bug_triage section. */
export function loadBugTriageConfig(repoRoot: string): BugTriageConfig {
  const configPath = join(repoRoot, 'ebram.config.yaml')
  let yamlText: string
  try {
    yamlText = readFileSync(configPath, 'utf8')
  } catch (err) {
    throw new Error(
      `ebram.config.yaml not found at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return parseBugTriageConfig(yamlText)
}

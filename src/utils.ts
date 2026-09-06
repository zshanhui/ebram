import { randomBytes, randomUUID } from 'node:crypto'
import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest'
import { config } from './config.js'
import { investigationLogMeta, logger } from './logger.js'
import { type InvestigationVerdict } from './verdicts.js'

type GithubIssue = RestEndpointMethodTypes['issues']['create']['response']['data']

type OpenGithubIssueFailureReason =
  | 'missing_github_token'
  | 'missing_github_repo'
  | 'github_api_error'

type OpenGithubIssueSuccess = {
  ok: true
  issue: GithubIssue
}

type OpenGithubIssueFailure = {
  ok: false
  reason: OpenGithubIssueFailureReason
  error?: unknown
}

export type OpenGithubIssueResult = OpenGithubIssueSuccess | OpenGithubIssueFailure

export type InvestigationReport = {
  verdict: InvestigationVerdict
  title: string
  summary: string
  affectedPaths: string[]
  proposedFix: string
  effort: 'EASY' | 'MEDIUM' | 'HARD'
  risks: string
}

/** Extract the inner JSON string from a markdown ```json ... ``` fence, if present. */
export function extractJsonFenceBlock(text: string): string | undefined {
  const jsonFenceRe = /```json[ \t]*\r?\n([\s\S]*?)```/gi

  for (const match of text.matchAll(jsonFenceRe)) {
    const candidate = match[1]?.trim()
    if (candidate && (candidate.startsWith('{') || candidate.startsWith('['))) {
      return candidate
    }
  }

  return undefined
}

/** Prefer ```json fenced content; fall back to trimmed raw text for JSON.parse. */
export function resolveJsonPayload(raw: string | undefined): string | undefined {
  if (!raw) return undefined

  const trimmed = raw.trim()
  if (!trimmed) return undefined

  return extractJsonFenceBlock(trimmed) ?? trimmed
}

export function generateSecurityNonce(): string {
  return randomBytes(16).toString('hex')
}

export function generateInvestigationRequestId(): string {
  return randomUUID()
}


function githubIssueSuccess(issue: GithubIssue): OpenGithubIssueSuccess {
  return { ok: true, issue }
}


function githubIssueFailure(
  reason: OpenGithubIssueFailureReason,
  error?: unknown,
): OpenGithubIssueFailure {
  return { ok: false, reason, error }
}

function parseGithubRepo(): { owner: string; repo: string } | null {
  const repoPath = config.githubRepo
  if (!repoPath) return null

  const [owner, repo] = repoPath.split('/')
  if (!owner || !repo) return null

  return { owner, repo }
}

export function githubRepoUrl(): string | null {
  const parsed = parseGithubRepo()
  if (!parsed) return null

  return `https://github.com/${parsed.owner}/${parsed.repo}`
}


function formatGithubIssueBody(investigation: InvestigationReport): string {
  const paths = investigation.affectedPaths.length
    ? investigation.affectedPaths.map((p) => `- \`${p}\``).join('\n')
    : '- _(none listed)_'

  return `Investigated by: 🤖email-bugfix-agent

## Summary

${investigation.summary}

## Affected paths

${paths}

## Proposed fix

${investigation.proposedFix || '_(none)_'}

## Effort

${investigation.effort}

## Risks

${investigation.risks || '_(none)_'}

---
_Automated triage by bugfixagent · verdict: ${investigation.verdict}_`
}


export async function openGithubIssue(
  inv: InvestigationReport,
  investigationRequestId: string,
): Promise<OpenGithubIssueResult> {
  const token = config.githubToken
  const githubRepo = parseGithubRepo()

  if (!token) {
    logger.error('openGithubIssue skipped: missing GITHUB_TOKEN', investigationLogMeta(investigationRequestId))
    return githubIssueFailure('missing_github_token')
  }

  if (!githubRepo) {
    logger.error(
      'openGithubIssue skipped: missing or invalid orchestrator.bug_triage.github_repo in ebram.config.yaml',
      investigationLogMeta(investigationRequestId),
    )
    return githubIssueFailure('missing_github_repo')
  }

  const { owner, repo } = githubRepo
  const octokit = new Octokit({ auth: token })

  try {
    const { data } = await octokit.rest.issues.create({
      owner,
      repo,
      title: inv.title,
      body: formatGithubIssueBody(inv),
      labels: ['agent-triage', `effort:${inv.effort.toLowerCase()}`],
    })

    logger.info(
      'GitHub issue created',
      investigationLogMeta(investigationRequestId, {
        issueNumber: data.number,
        issueUrl: data.html_url,
      }),
    )

    return githubIssueSuccess(data)
  } catch (err) {
    logger.error(
      'openGithubIssue failed',
      investigationLogMeta(investigationRequestId, { owner, repo, error: err }),
    )
    return githubIssueFailure('github_api_error', err)
  }
}


export type InvestigationEmailBodyOptions = {
  githubIssueUrl?: string
  githubIssueError?: string
  originalUserReport?: string
}

/** Short, human-readable summary of why the GitHub issue could not be opened. */
export function describeGithubIssueError(result: OpenGithubIssueFailure): string {
  const { reason, error } = result
  let detail = ''
  if (error instanceof Error) detail = error.message
  else if (error) detail = String(error)
  const short = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail
  return short ? `${reason}: ${short}` : reason
}

export function formatInvestigationEmailBody(
  parsed: InvestigationReport,
  options?: InvestigationEmailBodyOptions,
): string {
  const paths = parsed.affectedPaths.length
    ? parsed.affectedPaths.map((p) => `  - ${p}`).join('\n')
    : '  (none listed)'

  const githubIssueLine = options?.githubIssueUrl
    ? `GitHub issue: ${options.githubIssueUrl}\n`
    : options?.githubIssueError
      ? `GitHub issue: NOT OPENED — ${options.githubIssueError}\n`
      : ''
  const originalUserReport = options?.originalUserReport?.trim() || '(none)'

  return `Bug investigation report

Verdict: ${parsed.verdict}
Title: ${parsed.title}
${githubIssueLine}
Original user report
--------------------
${originalUserReport}

Summary
-------
${parsed.summary}

Affected paths
--------------
${paths}

Proposed fix
------------
${parsed.proposedFix || '(none)'}

Effort: ${parsed.effort}

Risks
-----
${parsed.risks || '(none)'}`
}

type DevNotificationEmailInput = {
  subject: string
  text: string
  investigationRequestId: string
}


export async function sendDevNotificationEmail(input: DevNotificationEmailInput): Promise<void> {
  const { resendApiKey: apiKey, devNotificationEmail: to, mailFrom: from } = config
  const { investigationRequestId } = input

  if (!apiKey || !to || !from) {
    logger.error(
      'sendDevNotificationEmail skipped: missing RESEND_API_KEY, dev_notification_email, or MAIL_FROM',
      investigationLogMeta(investigationRequestId),
    )
    return
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: input.subject,
      text: input.text,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    logger.error(
      'Resend error',
      investigationLogMeta(investigationRequestId, { status: res.status, errText }),
    )
    return
  }

  logger.info(
    'dev notification email sent',
    investigationLogMeta(investigationRequestId, { to, subject: input.subject }),
  )
}

import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest'
import { config } from './config.js'
import { logger } from './logger.js'

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
  verdict: string
  title: string
  summary: string
  affectedPaths: string[]
  proposedFix: string
  effort: 'EASY' | 'MEDIUM' | 'HARD'
  risks: string
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

  return `## Summary

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


export async function openGithubIssue(inv: InvestigationReport): Promise<OpenGithubIssueResult> {
  const token = config.githubToken
  const githubRepo = parseGithubRepo()

  if (!token) {
    logger.error('openGithubIssue skipped: missing GITHUB_TOKEN')
    return githubIssueFailure('missing_github_token')
  }

  if (!githubRepo) {
    logger.error('openGithubIssue skipped: missing or invalid GITHUB_REPO')
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

    logger.info('GitHub issue created', {
      issueNumber: data.number,
      issueUrl: data.html_url,
    })

    return githubIssueSuccess(data)
  } catch (err) {
    logger.error('openGithubIssue failed', { owner, repo, error: err })
    return githubIssueFailure('github_api_error', err)
  }
}


export function formatInvestigationEmailBody(parsed: InvestigationReport): string {
  const paths = parsed.affectedPaths.length
    ? parsed.affectedPaths.map((p) => `  - ${p}`).join('\n')
    : '  (none listed)'

  return `Bug investigation report

Verdict: ${parsed.verdict}
Title: ${parsed.title}

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
}


export async function sendDevNotificationEmail(input: DevNotificationEmailInput): Promise<void> {
  const { resendApiKey: apiKey, devNotificationEmail: to, mailFrom: from } = config

  if (!apiKey || !to || !from) {
    logger.error('sendDevNotificationEmail skipped: missing RESEND_API_KEY, DEV_NOTIFICATION_EMAIL, or MAIL_FROM')
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
    logger.error('Resend error', { status: res.status, errText })
    return
  }

  logger.info('dev notification email sent', { to, subject: input.subject })
}

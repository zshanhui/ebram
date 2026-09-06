import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBugTriageConfig, SUPPORTED_AGENT_BACKENDS } from './ebram-config.js'

const VALID_YAML = `
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model: composer-2.5
    github_repo: zshanhui/levelchinesenews-mobile-apps
    store_records: true
    dev_notification_email: shanhui.dev@proton.me
`

test('parses a valid orchestrator.bug_triage section', () => {
  const parsed = parseBugTriageConfig(VALID_YAML)
  assert.deepEqual(parsed, {
    agentBackend: 'cursor',
    agentModel: 'composer-2.5',
    githubRepo: 'zshanhui/levelchinesenews-mobile-apps',
    storeRecords: true,
    devNotificationEmail: 'shanhui.dev@proton.me',
  })
})

test('ignores unrelated sections (spam belongs to the worker)', () => {
  const parsed = parseBugTriageConfig(`
spam:
  enableDeepSpamGate: true
  minMatches: 2
  words:
    - seo
${VALID_YAML}`)
  assert.equal(parsed.agentBackend, 'cursor')
  assert.equal(parsed.agentModel, 'composer-2.5')
})

test('trims surrounding whitespace from values', () => {
  const parsed = parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model:  my-model-1
    github_repo:  owner/repo
    dev_notification_email:  dev@example.com
`)
  assert.equal(parsed.agentModel, 'my-model-1')
  assert.equal(parsed.githubRepo, 'owner/repo')
  assert.equal(parsed.devNotificationEmail, 'dev@example.com')
})

test('store_records defaults to true when absent', () => {
  const parsed = parseBugTriageConfig(VALID_YAML)
  assert.equal(parsed.storeRecords, true)
})

test('store_records: false disables the record store', () => {
  const parsed = parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model: composer-2.5
    github_repo: owner/repo
    store_records: false
    dev_notification_email: dev@example.com
`)
  assert.equal(parsed.storeRecords, false)
})

test('rejects non-boolean store_records', () => {
  assert.throws(
    () =>
      parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model: composer-2.5
    github_repo: owner/repo
    store_records: "yes"
    dev_notification_email: dev@example.com
`),
    /store_records must be a boolean/,
  )
})

test('rejects missing dev_notification_email', () => {
  assert.throws(
    () =>
      parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model: composer-2.5
    github_repo: owner/repo
`),
    /dev_notification_email must be a valid email/,
  )
})

test('rejects malformed dev_notification_email', () => {
  for (const email of ['not-an-email', 'a@b', '@example.com', '']) {
    assert.throws(
      () =>
        parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model: composer-2.5
    github_repo: owner/repo
    dev_notification_email: "${email}"
`),
        /dev_notification_email must be a valid email/,
    )
  }
})

test('rejects invalid yaml', () => {
  assert.throws(() => parseBugTriageConfig('not: [valid: yaml'), /not valid YAML/)
})

test('rejects missing orchestrator.bug_triage section', () => {
  assert.throws(
    () => parseBugTriageConfig('spam:\n  minMatches: 2\n'),
    /missing the 'orchestrator.bug_triage' section/,
  )
})

test('rejects unsupported agent_backend', () => {
  assert.throws(
    () =>
      parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: pi
    agent_model: composer-2.5
    github_repo: owner/repo
`),
    /agent_backend must be one of cursor/,
  )
})

test('rejects empty agent_model', () => {
  assert.throws(
    () =>
      parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model: ""
    github_repo: owner/repo
`),
    /agent_model must be a non-empty string/,
  )
})

test('rejects non-string agent_model', () => {
  assert.throws(
    () =>
      parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model: 123
    github_repo: owner/repo
`),
    /agent_model must be a non-empty string/,
  )
})

test('rejects malformed github_repo', () => {
  for (const repo of ['justowner', 'owner/', '/repo', 'owner/repo/extra', '']) {
    assert.throws(
      () =>
        parseBugTriageConfig(`
orchestrator:
  bug_triage:
    agent_backend: cursor
    agent_model: composer-2.5
    github_repo: "${repo}"
`),
        /github_repo must be in owner\/repo format/,
    )
  }
})

test('supported backends list is cursor-only for now', () => {
  assert.deepEqual(SUPPORTED_AGENT_BACKENDS, ['cursor'])
})

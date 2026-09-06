import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

// config.js (imported via store.js) exits if required env vars are missing,
// so stub them before the dynamic import below (static imports are hoisted
// and would evaluate config.js first).
process.env.EBRAM_API_ACCESS_KEY ??= 'test-key'
process.env.CURSOR_API_KEY ??= 'test-cursor-key'
process.env.GITHUB_TOKEN ??= 'test-github-token'
process.env.RESEND_API_KEY ??= 'test-resend-key'
process.env.MAIL_FROM ??= 'test@example.com'

const { normalizeEvent, openRecordStore, sanitizeContents, shouldPersistLog } = await import(
  './store.js'
)

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bugfixagent-store-'))
  return join(dir, 'test.db')
}

test('creates schema and accepts an investigation', () => {
  const dbPath = tempDbPath()
  const store = openRecordStore(dbPath)

  try {
    const row = store.acceptInvestigation({ id: 'inv-1', messageLength: 42 })
    assert.equal(row.id, 'inv-1')
    assert.equal(row.status, 'accepted')
    assert.equal(row.message_length, 42)
    assert.ok(row.created_at)
  } finally {
    store.close()
    rmSync(dirname(dbPath), { recursive: true, force: true })
  }
})

test('recordLog persists events and updates investigation state', () => {
  const dbPath = tempDbPath()
  const store = openRecordStore(dbPath)

  try {
    store.acceptInvestigation({ id: 'inv-2', messageLength: 10 })

    store.recordLog('info', 'investigation started', {
      investigationRequestId: 'inv-2',
      messageLength: 10,
      repoUrl: 'https://github.com/o/r',
    })

    store.recordLog('info', 'cursor agent created', {
      investigationRequestId: 'inv-2',
      agentId: 'bc-agent',
    })

    store.recordLog('info', 'investigation prompt', {
      investigationRequestId: 'inv-2',
      agentId: 'bc-agent',
      prompt: 'full prompt text v1',
    })

    store.recordLog('info', 'investigation prompt sent', {
      investigationRequestId: 'inv-2',
      runId: 'run-1',
    })

    assert.equal(shouldPersistLog('investigation prompt'), true)

    const investigation = store.getInvestigation('inv-2')
    assert.equal(investigation?.status, 'running')
    assert.equal(investigation?.agent_id, 'bc-agent')
    assert.equal(investigation?.run_id, 'run-1')
    assert.equal(investigation?.repo_url, 'https://github.com/o/r')

    const events = store.listLogEvents('inv-2')
    assert.equal(events.length, 4)
    assert.equal(events[0]?.event, 'investigation.started')
    assert.equal(events[2]?.event, 'agent.prompt_prepared')
    assert.equal(JSON.parse(events[2]?.contents ?? '{}').prompt, 'full prompt text v1')
    assert.equal(events[3]?.event, 'agent.prompt_sent')
  } finally {
    store.close()
    rmSync(dirname(dbPath), { recursive: true, force: true })
  }
})

test('sanitizeContents strips raw agent result but keeps prompt', () => {
  const out = sanitizeContents({
    investigationRequestId: 'inv-3',
    prompt: 'full prompt',
    result: 'huge result',
    agentId: 'bc-1',
  })

  assert.deepEqual(out, { prompt: 'full prompt', agentId: 'bc-1' })
})

test('normalizeEvent maps report rejected to verdict.spam', () => {
  assert.equal(normalizeEvent('report rejected', { verdict: 'SPAM' }), 'verdict.spam')
  assert.equal(normalizeEvent('report rejected', { verdict: 'NOT_VALID' }), 'verdict.notification')
})

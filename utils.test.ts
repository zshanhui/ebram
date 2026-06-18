import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.API_ACCESS_KEY ??= 'test-key'
process.env.CURSOR_API_KEY ??= 'test-cursor-key'
process.env.DEV_NOTIFICATION_EMAIL ??= 'dev@example.com'
process.env.GITHUB_REPO ??= 'owner/repo'
process.env.GITHUB_TOKEN ??= 'test-github-token'
process.env.RESEND_API_KEY ??= 'test-resend-key'
process.env.MAIL_FROM ??= 'test@example.com'

const { InvestigationVerdict } = await import('./verdicts.js')
const { extractJsonFenceBlock, generateInvestigationRequestId, generateSecurityNonce, resolveJsonPayload } = await import('./utils.js')

test('returns undefined for empty string', () => {
  assert.equal(extractJsonFenceBlock(''), undefined)
})

test('returns undefined when no fence is present', () => {
  assert.equal(extractJsonFenceBlock('plain text without a fence'), undefined)
})

test('returns undefined for bare json without a fence', () => {
  assert.equal(extractJsonFenceBlock('{"a":1}'), undefined)
})

test('extracts json from a ```json fence', () => {
  const input = `Summary here.

\`\`\`json
{"verdict":"${InvestigationVerdict.VALID}","title":"Bug"}
\`\`\`
`
  assert.equal(extractJsonFenceBlock(input), `{"verdict":"${InvestigationVerdict.VALID}","title":"Bug"}`)
})

test('json fence label is case insensitive', () => {
  const input = `\`\`\`JSON
{"a":1}
\`\`\``
  assert.equal(extractJsonFenceBlock(input), '{"a":1}')
})

test('handles CRLF line endings', () => {
  const input = `\`\`\`json\r\n{"b":2}\r\n\`\`\``
  assert.equal(extractJsonFenceBlock(input), '{"b":2}')
})

test('returns the first non-empty fenced block', () => {
  const input = `\`\`\`json
{"first":1}
\`\`\`

\`\`\`json
{"second":2}
\`\`\``
  assert.equal(extractJsonFenceBlock(input), '{"first":1}')
})

test('skips empty json fences', () => {
  const input = `\`\`\`json

\`\`\`

\`\`\`json
{"ok":true}
\`\`\``
  assert.equal(extractJsonFenceBlock(input), '{"ok":true}')
})

test('trims inner content', () => {
  const input = `\`\`\`json

  {"trimmed": true}

\`\`\``
  assert.equal(extractJsonFenceBlock(input), '{"trimmed": true}')
})

test('resolveJsonPayload prefers fenced json over surrounding prose', () => {
  const input = `Investigation complete.

\`\`\`json
{"verdict":"${InvestigationVerdict.VALID}","title":"Bug","summary":"Details"}
\`\`\``
  assert.equal(
    resolveJsonPayload(input),
    `{"verdict":"${InvestigationVerdict.VALID}","title":"Bug","summary":"Details"}`,
  )
})

test('resolveJsonPayload falls back to bare json', () => {
  const payload = `{"verdict":"${InvestigationVerdict.SPAM}","title":"x","summary":"y"}`
  assert.equal(resolveJsonPayload(payload), payload)
})

test('resolveJsonPayload returns undefined for empty input', () => {
  assert.equal(resolveJsonPayload(undefined), undefined)
  assert.equal(resolveJsonPayload('   '), undefined)
})

test('generateSecurityNonce returns 32 hex chars', () => {
  const nonce = generateSecurityNonce()
  assert.match(nonce, /^[0-9a-f]{32}$/)
  assert.notEqual(generateSecurityNonce(), generateSecurityNonce())
})

test('generateInvestigationRequestId returns a UUID', () => {
  const id = generateInvestigationRequestId()
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
})

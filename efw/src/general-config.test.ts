import assert from 'node:assert/strict'
import { test } from 'node:test'

const { parseGeneralConfig } = await import('./general-config.js')

test('parseGeneralConfig reads a valid contact_email', () => {
  const cfg = parseGeneralConfig(`
general:
  contact_email: admin@example.com
`)
  assert.deepEqual(cfg, { contactEmail: 'admin@example.com' })
})

test('parseGeneralConfig trims surrounding whitespace', () => {
  const cfg = parseGeneralConfig(`
general:
  contact_email:   admin@example.com
`)
  assert.equal(cfg?.contactEmail, 'admin@example.com')
})

test('parseGeneralConfig returns null when the general section is missing', () => {
  assert.equal(parseGeneralConfig('spam:\n  minMatches: 2\n'), null)
})

test('parseGeneralConfig returns null when contact_email is missing', () => {
  assert.equal(parseGeneralConfig('general:\n  other: value\n'), null)
})

test('parseGeneralConfig returns null for invalid emails', () => {
  for (const bad of ['not-an-email', 'a@b', '@example.com', '""', '123']) {
    const cfg = parseGeneralConfig(`general:\n  contact_email: ${bad}\n`)
    assert.equal(cfg, null, `contact_email: ${bad} must be rejected`)
  }
})

test('parseGeneralConfig tolerates other sections alongside general', () => {
  const cfg = parseGeneralConfig(`
spam:
  minMatches: 2
  words:
    - seo

general:
  contact_email: admin@example.com

orchestrator:
  bug_triage:
    github_repo: owner/repo
`)
  assert.deepEqual(cfg, { contactEmail: 'admin@example.com' })
})

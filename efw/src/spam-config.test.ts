import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const { parseSpamConfig } = await import('./spam-config.js')

test('parseSpamConfig reads words and minMatches', () => {
  const cfg = parseSpamConfig(`
spam:
  minMatches: 3
  words:
    - seo
    - promo code
    - jackpot
`)
  assert.deepEqual(cfg, {
    words: ['seo', 'promo code', 'jackpot'],
    minMatches: 3,
    enableDeepSpamGate: false,
  })
})

test('parseSpamConfig honors enableDeepSpamGate: true', () => {
  const cfg = parseSpamConfig(`
spam:
  enableDeepSpamGate: true
  words:
    - seo
`)
  assert.deepEqual(cfg, { words: ['seo'], minMatches: 2, enableDeepSpamGate: true })
})

test('enableDeepSpamGate must be a boolean — missing or invalid disables the deep filter', () => {
  for (const bad of ['1', '"true"', 'yes', 'null']) {
    const cfg = parseSpamConfig(`\nspam:\n  enableDeepSpamGate: ${bad}\n  words:\n    - seo\n`)
    assert.ok(cfg)
    assert.equal(cfg.enableDeepSpamGate, false, `enableDeepSpamGate: ${bad} must not enable the filter`)
  }
})

test('parseSpamConfig defaults minMatches to 2 when absent', () => {
  const cfg = parseSpamConfig(`
spam:
  words:
    - seo
`)
  assert.deepEqual(cfg, { words: ['seo'], minMatches: 2, enableDeepSpamGate: false })
})

test('parseSpamConfig handles comments, quoting and blank entries', () => {
  const cfg = parseSpamConfig(`
# a comment
spam:
  words:
    - "Mark Colins"   # quoted with trailing comment
    - telegra.ph

    - 42 # non-string entries are dropped
`)
  assert.deepEqual(cfg, { words: ['Mark Colins', 'telegra.ph'], minMatches: 2, enableDeepSpamGate: false })
})

test('parseSpamConfig trims whitespace around words', () => {
  const cfg = parseSpamConfig(`
spam:
  words:
    -   seo
    - jackpot
`)
  assert.deepEqual(cfg, { words: ['seo', 'jackpot'], minMatches: 2, enableDeepSpamGate: false })
})

test('parseSpamConfig rejects invalid minMatches and falls back to 2', () => {
  for (const bad of ['0', '-1', '1.5', '"two"', 'true']) {
    const cfg = parseSpamConfig(`\nspam:\n  minMatches: ${bad}\n  words:\n    - seo\n`)
    assert.ok(cfg, `config should parse with minMatches: ${bad}`)
    assert.equal(cfg.minMatches, 2, `minMatches: ${bad} should fall back to 2`)
  }
})

test('parseSpamConfig returns null for missing spam section', () => {
  assert.equal(parseSpamConfig('other: true\n'), null)
})

test('parseSpamConfig returns null for empty or non-array words', () => {
  assert.equal(parseSpamConfig('spam:\n  words: []\n'), null)
  assert.equal(parseSpamConfig('spam:\n  words: seo\n'), null)
})

test('parseSpamConfig returns null for invalid yaml', () => {
  assert.equal(parseSpamConfig('spam: [unclosed'), null)
})

test('the real ebram.config.yaml is valid and sane (bundled at build time)', () => {
  const yamlPath = path.resolve(import.meta.dirname, '../../ebram.config.yaml')
  const config = parseSpamConfig(readFileSync(yamlPath, 'utf8'))
  assert.ok(config, 'repo-root ebram.config.yaml must parse — fix it before merging')
  assert.ok(config.words.length >= 10, 'word list suspiciously small')
  assert.ok(config.words.every((w) => w.length >= 3), 'every spam word needs >= 3 chars (word-boundary matching)')
  assert.equal(config.minMatches, 2)
  assert.equal(config.enableDeepSpamGate, true)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  KEY_WORDS,
  MIN_REPORT_WORDS,
  SPAM_WORDS,
  countSpamMatches,
  countWords,
  containsAllKeywords,
  investigationSkipReason,
  shouldBlockAsSpam,
  shouldInvestigateReport,
} = await import('./gate.js')

const VALID_REPORT =
  'bug report one two three four five six seven eight nine ten eleven twelve thirteen'

test('countWords ignores surrounding whitespace', () => {
  assert.equal(countWords('  one two three  '), 3)
})

test('countWords returns zero for empty text', () => {
  assert.equal(countWords(''), 0)
  assert.equal(countWords('   '), 0)
})

test('containsAllKeywords is case insensitive', () => {
  assert.equal(containsAllKeywords('BUG REPORT here', KEY_WORDS), true)
})

test('containsAllKeywords requires every keyword as a whole word', () => {
  assert.equal(containsAllKeywords('please report this bug', KEY_WORDS), true)
  assert.equal(containsAllKeywords('please report this issue', KEY_WORDS), false)
  assert.equal(containsAllKeywords('debugging issue report', KEY_WORDS), false)
})

test('investigationSkipReason rejects missing keywords before length check', () => {
  const fifteenWordsWithoutKeywords =
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'

  assert.equal(
    investigationSkipReason(fifteenWordsWithoutKeywords),
    'missing_keywords',
  )
})

test('investigationSkipReason rejects reports that are too short', () => {
  assert.equal(
    investigationSkipReason('bug report with only seven words total'),
    'too_short',
  )
})

test('investigationSkipReason accepts subject and body with keywords and enough words', () => {
  const subject = 'bug report'
  const body =
    'The app crashes when opening settings after login on iOS seventeen words here now'

  assert.equal(investigationSkipReason(`${subject}\n${body}`), null)
})

test('shouldInvestigateReport mirrors investigationSkipReason', () => {
  assert.equal(shouldInvestigateReport(VALID_REPORT), true)
  assert.equal(shouldInvestigateReport('bug report too short'), false)
  assert.equal(countWords(VALID_REPORT), MIN_REPORT_WORDS)
})

test('countSpamMatches counts distinct spam signals', () => {
  assert.equal(countSpamMatches('seo tips for your website'), 1)
  assert.equal(
    countSpamMatches('seo analysis to improve your google ranking'),
    3,
  )
})

test('shouldBlockAsSpam requires at least two spam signals', () => {
  assert.equal(shouldBlockAsSpam('seo services only'), false)
  assert.equal(
    shouldBlockAsSpam('seo analysis for your business and services'),
    true,
  )
  assert.equal(
    shouldBlockAsSpam('one match', ['seo', 'analysis'], 2),
    false,
  )
})

test('shouldBlockAsSpam matches multi-word spam phrases', () => {
  const pitch =
    'Your steps are incomplete. Book a phone call to attract more clients.'

  assert.equal(countSpamMatches(pitch, SPAM_WORDS), 4)
  assert.equal(shouldBlockAsSpam(pitch), true)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const {
  callerOrigin,
  contactFormToken,
  contactTokenMatches,
  isAllowedContactCaller,
  originsFromRedirects,
  parseEnableFormToken,
} = await import('./contact-guard.js')

const ALLOWED = ['https://levelchinese.app']

test('originsFromRedirects keeps the origin of each redirect', () => {
  assert.deepEqual(
    originsFromRedirects([
      'https://levelchinese.app/contact?success=1',
      'https://levelchinese.app/contact?error=1',
      'https://ebramforms.com/contact?success=1',
    ]),
    ['https://levelchinese.app', 'https://ebramforms.com'],
  )
})

test('originsFromRedirects skips invalid urls', () => {
  assert.deepEqual(originsFromRedirects(['not a url', '']), [])
})

test('callerOrigin prefers the Origin header', () => {
  assert.equal(
    callerOrigin('https://levelchinese.app', 'https://evil.example/contact'),
    'https://levelchinese.app',
  )
})

test('callerOrigin falls back to the Referer origin', () => {
  assert.equal(callerOrigin(null, 'https://levelchinese.app/contact'), 'https://levelchinese.app')
  assert.equal(callerOrigin('  ', 'https://levelchinese.app/contact'), 'https://levelchinese.app')
})

test('isAllowedContactCaller rejects a missing or foreign origin', () => {
  assert.equal(isAllowedContactCaller(null, null, ALLOWED), false)
  assert.equal(isAllowedContactCaller('https://evil.example', null, ALLOWED), false)
  assert.equal(isAllowedContactCaller('https://levelchinese.app', null, ALLOWED), true)
  assert.equal(isAllowedContactCaller(null, 'https://levelchinese.app/contact?error=1', ALLOWED), true)
})

test('contactFormToken hashes the worker origin and mail-from address', async () => {
  const { createHash } = await import('node:crypto')
  const expected = createHash('sha256')
    .update('https://contact-ebram.levelchinese.app\ncontact@levelchinese.app')
    .digest('hex')

  assert.equal(
    await contactFormToken('https://contact-ebram.levelchinese.app/anything', '  Contact@levelchinese.app '),
    expected,
  )
})

test('parseEnableFormToken is true only for a boolean true', () => {
  assert.equal(parseEnableFormToken('enable_form_token: true\n'), true)
  assert.equal(parseEnableFormToken('enable_form_token: false\n'), false)
  assert.equal(parseEnableFormToken('spam:\n  words:\n    - seo\n'), false)
  assert.equal(parseEnableFormToken('enable_form_token: "true"\n'), false)
  assert.equal(parseEnableFormToken('enable_form_token: [unclosed'), false)
})

test('the real ebram.config.yaml enables the form token check', () => {
  const yamlPath = path.resolve(import.meta.dirname, '../../ebram.config.yaml')
  assert.equal(parseEnableFormToken(readFileSync(yamlPath, 'utf8')), true)
})

test('contactTokenMatches requires a configured token', () => {
  assert.equal(contactTokenMatches('secret', ''), false)
  assert.equal(contactTokenMatches('', 'secret'), false)
  assert.equal(contactTokenMatches('nope', 'secret'), false)
  assert.equal(contactTokenMatches('  secret  ', 'secret'), true)
})

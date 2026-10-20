import { strict as assert } from 'node:assert'
import { compareDigest, extensionDownloadUrl, extensionZipName, sha256Of } from '../src/bridge/extension-package.ts'

const bytes = new TextEncoder().encode('PK\x03\x04fake-zip-body')
assert.equal(sha256Of(bytes), sha256Of(bytes), 'hash is stable')
assert.equal(sha256Of(bytes).length, 64, 'sha256 hex length')
assert.notEqual(sha256Of(bytes), sha256Of(new TextEncoder().encode('other')), 'different bytes differ')

assert.equal(extensionZipName('0.4.9'), 'dsh-eda-bridge-extension-0.4.9.zip')
assert.equal(
  extensionDownloadUrl('http://159.75.130.207/eda', '0.4.9'),
  'http://159.75.130.207/eda/dsh-eda-bridge-extension-0.4.9.zip',
  'base without a trailing slash gets one',
)
assert.equal(
  extensionDownloadUrl('https://example.test/dl/', '1.2.3'),
  'https://example.test/dl/dsh-eda-bridge-extension-1.2.3.zip',
  'trailing slash is not doubled',
)

assert.equal(compareDigest('ABC', 'abc'), 'match', 'case-insensitive')
assert.equal(compareDigest('aa', 'bb'), 'mismatch')
assert.equal(compareDigest(null, 'bb'), 'unverified', 'missing expected is not a pass')
assert.equal(compareDigest('aa', undefined), 'unverified')
assert.equal(compareDigest('', ''), 'unverified')

console.log('ALL PASS extension-package')

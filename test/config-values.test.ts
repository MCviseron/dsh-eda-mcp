/**
 * Live-value unwrapping test (DSH >= 0.2 `volatile` config fields).
 *
 * `node --experimental-strip-types test/config-values.test.ts`
 */
import { booleanField, isLiveValue, numberField, readConfigValue, unwrapConfig } from '../src/config-values.ts'

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) console.log(`     got      ${JSON.stringify(actual)}\n     expected ${JSON.stringify(expected)}`)
}

/**
 * A stand-in for the host's live reference, built exactly like cosmokit does:
 * a frozen handle carrying `get` and the registry-scoped `write` symbol.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
function live<T>(initial: T) {
  let current = initial
  return Object.freeze({
    get: () => current,
    [VOLATILE_WRITE]: (next: T) => { current = next },
  })
}

check('plain values pass through', unwrapConfig({ enabled: true, toolCallTimeoutMs: 60000 }), { enabled: true, toolCallTimeoutMs: 60000 })
check('number handle resolves', readConfigValue(live(60000)), 60000)
check('boolean handle resolves', readConfigValue(live(false)), false)
check('string handle resolves', readConfigValue(live('1')), '1')
check('handle readable after write', (() => {
  const h = live(1) as { get: () => number } & Record<symbol, (next: number) => void>
  h[VOLATILE_WRITE](2)
  return readConfigValue(h)
})(), 2)

check('mixed config unwraps every field', unwrapConfig({
  enabled: live(true),
  announceToAgent: live(false),
  toolCallTimeoutMs: live(30000),
  allowRawApi: live(true),
}), { enabled: true, announceToAgent: false, toolCallTimeoutMs: 30000, allowRawApi: true })

check('booleanField falls back for a handle-free object', booleanField({}, true), true)
check('booleanField reads a handle', booleanField(live(false), true), false)
check('numberField reads a handle', numberField(live(1234), 60000), 1234)
check('numberField falls back for a wrapped-but-unreadable value', numberField({}, 60000), 60000)

// A plain object with a `get` method but no `write` is NOT a live reference and
// must survive untouched (the protocol marker is what identifies it).
const notALiveValue = { get: () => 'nope' }
check('object with get but no write is left alone', readConfigValue(notALiveValue), notALiveValue)
check('isLiveValue rejects it', isLiveValue(notALiveValue), false)
check('isLiveValue accepts a handle', isLiveValue(live(0)), true)
check('null and scalars are left alone', [readConfigValue(null), readConfigValue(5), readConfigValue('x')], [null, 5, 'x'])

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

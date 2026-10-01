/**
 * Config-value normalization for the DSH settings generations.
 *
 * DSH >= 0.2 hands a plugin's `volatile` config fields over as live references
 * instead of plain values. `@deepseek-ai/cosmokit` builds them as
 * `Object.freeze({ get: () => current, [write]: (value) => { current = value } })`
 * with `const write = Symbol.for("cosmokit.volatile.write")`, and marks them with
 * `isVolatile(value) = typeof value === "object" && value !== null && write in value`.
 *
 * `@deepseek-ai/dsh-settings` folds those references with
 * `isVolatile(value) ? value.get() : value` before serializing. A plugin that
 * consumes a handle directly sees `{}` for a number field, and `"[object
 * Object]"` once stringified — exactly how a config validation failure silently
 * stopped the bridge spawn.
 *
 * The marker is looked up through the global symbol registry, so this needs no
 * dependency on cosmokit (nor on the copy the host happened to load).
 */

/** The shared reference marker (`Symbol.for` keeps one instance per process). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a value is one of those live references. */
export function isLiveValue(value: unknown): value is { get: () => unknown } {
  if (value === null || typeof value !== 'object') return false
  return VOLATILE_WRITE in value
}

/** Resolve one config field to its plain value; other generations pass through. */
export function readConfigValue(value: unknown): unknown {
  if (!isLiveValue(value)) return value
  try {
    return value.get()
  } catch {
    return value
  }
}

/** Resolve every own enumerable field of a config object. */
export function unwrapConfig<T extends object>(source: T): T {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) plain[key] = readConfigValue(value)
  return plain as T
}

/**
 * Read a boolean config field, falling back to the default when the value is not
 * a boolean — so a future settings generation that hands over a new wrapper can
 * never push an object into a consumer that validates types.
 */
export function booleanField(value: unknown, fallback: boolean): boolean {
  const plain = readConfigValue(value)
  return typeof plain === 'boolean' ? plain : fallback
}

/** Read a number config field, falling back to the default for non-numbers. */
export function numberField(value: unknown, fallback: number): number {
  const plain = readConfigValue(value)
  return typeof plain === 'number' && Number.isFinite(plain) ? plain : fallback
}

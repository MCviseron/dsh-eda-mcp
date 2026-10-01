import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * Snapshot of one settings namespace as this card consumes it. Declared locally
 * instead of importing DSH's own type so one build spans generations: 0.1.x
 * exported `SettingsScopeSnapshot` from `@deepseek-ai/dsh-client-ui-settings/client`,
 * while 0.2 replaced that scope with `ConfigFormSnapshot` (same fields).
 */
export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/**
 * The namespace scope this card writes through. Structural for the same reason:
 * 0.1.x `SettingsScope` and 0.2 `ConfigForm` carry these exact members (0.2's
 * writes additionally resolve to a boolean, which this face ignores).
 */
export interface SettingsScope<T> {
  getSnapshot: () => SettingsScopeSnapshot<T>
  subscribe: (listener: () => void) => () => void
  mutate: (ops: readonly SettingsOp[], expectedRevision?: number) => Promise<void>
  set: (field: string, value: unknown) => Promise<void>
  unset: (field: string) => Promise<void>
}

interface BridgeView {
  ns: string
  value: unknown
  base?: unknown
  user?: unknown
  revision: number
  secrets?: Array<{ path: string[]; set: boolean }>
}

interface DescribeResponse {
  namespaces: BridgeView[]
  writable: boolean
}

interface MutateResponse {
  ok: boolean
  value?: BridgeView
  code?: string
  message?: string
}

interface SettingsOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

const API = {
  describe: '/api/dsh-eda-mcp/settings/describe',
  mutate: '/api/dsh-eda-mcp/settings/mutate',
} as const

/**
 * A minimal SettingsScope backed by the dsh-eda-mcp Host settings bridge.
 * Mirrors the official settings apiproxy shape so the Web GUI card can read and
 * write the plugin namespace without depending on apiproxy exposing it.
 */
export function createEdaMcpSettingsScope<T>(): SettingsScope<T> {
  const store = createSnapshotStore<SettingsScopeSnapshot<T>>({
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'host',
  })

  let tail = Promise.resolve()
  let disposed = false

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return await response.json()
  }

  const read = async (): Promise<void> => {
    if (disposed) return
    try {
      const body = await post(API.describe, {}) as { ok?: boolean; value?: DescribeResponse }
      if (body.ok !== true || body.value === undefined) throw new Error('settings bridge unavailable')
      const view = body.value.namespaces.find(candidate => candidate.ns === 'eda-mcp')
      if (view === undefined) throw new Error('eda-mcp settings namespace not exposed')
      accept(view, body.value.writable)
    } catch {
      if (!disposed) store.update((draft) => { draft.status = 'unavailable' })
    }
  }

  const accept = (view: BridgeView, writable: boolean): void => {
    if (disposed) return
    store.set({
      status: 'ready',
      value: view.value as T | undefined,
      base: view.base,
      user: view.user,
      revision: view.revision,
      writable,
      mode: 'host',
    })
  }

  const write = async (ops: SettingsOp[], expectedRevision?: number): Promise<void> => {
    if (disposed) return
    const revision = expectedRevision ?? store.getSnapshot().revision
    try {
      const body = await post(API.mutate, {
        ns: 'eda-mcp',
        ops,
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      }) as MutateResponse
      if (body.ok !== true || body.value === undefined) {
        await read()
        throw new Error(body.message ?? body.code ?? 'settings write failed')
      }
      accept(body.value, store.getSnapshot().writable)
    } catch {
      await read().catch(() => {})
      throw new Error('settings write failed')
    }
  }

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    if (disposed) return Promise.resolve()
    const task = tail.then(operation, operation)
    tail = task.catch(() => {})
    return task
  }

  void read()

  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    mutate: (ops, expectedRevision) => enqueue(() => write(
      ops.map(op => (op.op === 'set'
        ? { op: 'set' as const, path: [...op.path], value: op.value }
        : { op: 'unset' as const, path: [...op.path] })),
      expectedRevision,
    )),
    set: (field, value) => enqueue(() => write([{ op: 'set', path: [field], value }])),
    unset: field => enqueue(() => write([{ op: 'unset', path: [field] }])),
  }
}

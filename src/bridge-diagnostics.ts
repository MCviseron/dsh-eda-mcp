import { spawn } from 'node:child_process'

/**
 * Runtime record of how the bridge child is doing, so a failure is readable
 * from the loopback routes instead of only from host logs that the desktop app
 * does not write to disk.
 */
export interface BridgeDiagnosticsSnapshot {
  /** Whether the `tools` service became visible (the 0.2 mcp-client requires it). */
  toolsServiceSeen: boolean
  /** How many times the MCP client mount was attempted in this process. */
  mountAttempts: number
  /** Last mount/inject error, if any. */
  mountError: string | null
  /** Cordis fiber state of the mounted client, read live when diagnostics are requested. */
  clientFiberState: number | null
  /** Whether the client fiber's startup promise already settled. */
  clientSettled: boolean
  /** Startup failure of the client fiber, with its cause chain. */
  clientStartupError: string | null
  /** Last `/healthz` observation of the bridge. */
  bridgeHealth: 'unknown' | 'ok' | 'unreachable'
  /** Error text of the last failed probe. */
  probeError: string | null
  /** When the last probe ran (epoch ms). */
  probedAt: number | null
}

/** Render an error together with its `cause` chain, which carries the real failure. */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`)
      current = (current as { cause?: unknown }).cause
      continue
    }
    parts.push(String(current))
    break
  }
  return parts.join(' <- ')
}

/** One spawn attempt of the bridge script from THIS process. */
export interface BridgeSelfTestResult {
  command: string
  args: string[]
  spawned: boolean
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  stderr: string
  stdout: string
  healthz: string
  spawnError: string | null
  pid: number | null
}

const BRIDGE_PORT = 39009

export class BridgeDiagnostics {
  readonly snapshot: BridgeDiagnosticsSnapshot = {
    toolsServiceSeen: false,
    mountAttempts: 0,
    mountError: null,
    clientFiberState: null,
    clientSettled: false,
    clientStartupError: null,
    bridgeHealth: 'unknown',
    probeError: null,
    probedAt: null,
  }

  /** The mounted client fiber, so its state can be read live. */
  #clientFiber: { state?: number } | null = null

  /** Forget per-mount facts before a fresh mount attempt. */
  beginMount(): void {
    this.snapshot.toolsServiceSeen = false
    this.snapshot.mountError = null
    this.snapshot.clientSettled = false
    // A remount's outcome replaces the previous one, otherwise a startup remount
    // race leaves a stale error next to a healthy connection.
    this.snapshot.clientStartupError = null
    this.snapshot.mountAttempts += 1
  }

  recordToolsServiceSeen(): void {
    this.snapshot.toolsServiceSeen = true
  }

  recordError(error: unknown): void {
    this.snapshot.mountError = describeError(error)
  }

  /** Record the client fiber and observe its startup settlement (a failure carries `cause`). */
  observeClientFiber(fiber: unknown): void {
    const record = fiber as { state?: number; then?: unknown }
    this.#clientFiber = typeof record?.state === 'number' || record !== null ? record as { state?: number } : null
    this.snapshot.clientFiberState = typeof record?.state === 'number' ? record.state : null
    if (typeof record?.then !== 'function') return
    void Promise.resolve(fiber).then(() => {
      this.snapshot.clientSettled = true
    }).catch((error: unknown) => {
      this.snapshot.clientSettled = true
      this.snapshot.clientStartupError = describeError(error)
    })
  }

  /** Read the live fiber state now (mount-time snapshots are always "starting"). */
  liveSnapshot(): BridgeDiagnosticsSnapshot {
    const state = this.#clientFiber?.state
    return { ...this.snapshot, clientFiberState: typeof state === 'number' ? state : this.snapshot.clientFiberState }
  }

  /** Ask the bridge's own health endpoint over loopback. */
  async probe(): Promise<'ok' | 'unreachable'> {
    this.snapshot.probedAt = Date.now()
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) {
        this.snapshot.bridgeHealth = 'unreachable'
        this.snapshot.probeError = `healthz responded ${response.status}`
        return 'unreachable'
      }
      this.snapshot.bridgeHealth = 'ok'
      this.snapshot.probeError = null
      return 'ok'
    } catch (error) {
      this.snapshot.bridgeHealth = 'unreachable'
      this.snapshot.probeError = error instanceof Error ? error.message : String(error)
      return 'unreachable'
    }
  }

  /**
   * Spawn the bridge straight from the plugin host process, watch it for a
   * moment, and report what happened. This separates "the host cannot start the
   * bridge executable" from "the MCP client never got to start it".
   */
  async selfTest(command: string, args: string[], timeoutMs = 2500): Promise<BridgeSelfTestResult> {
    const result: BridgeSelfTestResult = {
      command, args, spawned: false, exited: false, exitCode: null, exitSignal: null,
      stderr: '', stdout: '', healthz: 'n/a', spawnError: null, pid: null,
    }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    result.spawned = true
    result.pid = child.pid ?? null
    let settled = false
    const finished = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        result.spawnError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        settled = true
        resolve()
      })
      child.once('exit', (code, signal) => {
        result.exited = true
        result.exitCode = code
        result.exitSignal = signal ?? null
        settled = true
        resolve()
      })
    })
    child.stdout?.on('data', (chunk) => { result.stdout = (result.stdout + String(chunk)).slice(-2000) })
    child.stderr?.on('data', (chunk) => { result.stderr = (result.stderr + String(chunk)).slice(-2000) })

    const deadline = Date.now() + timeoutMs
    let health = 'unreachable'
    while (Date.now() < deadline && !settled) {
      await new Promise(resolve => setTimeout(resolve, 300))
      try {
        const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`, { signal: AbortSignal.timeout(1000) })
        health = `${response.status} ${await response.text()}`
        break
      } catch { /* not up yet */ }
    }
    result.healthz = health
    if (!settled) {
      try { child.kill() } catch { /* already gone */ }
      await Promise.race([finished, new Promise(resolve => setTimeout(resolve, 1000))])
    }
    return result
  }
}

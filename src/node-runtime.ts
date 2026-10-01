import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/**
 * How the bridge child process is launched. `source` names the rule that chose
 * the executable, so a failed spawn can be diagnosed from the route response.
 */
export interface BridgeRuntime {
  /** Executable that runs the bridge script. */
  command: string
  /** Environment that must be added for `command` to behave as Node. */
  extraEnv: Record<string, string>
  /** Human-readable rule that produced this executable. */
  source: string
}

/** Inputs the resolution reads; injected so the rules are unit-testable. */
export interface RuntimeProbe {
  env?: Record<string, string | undefined>
  execPath?: string
  versions?: { electron?: string }
  exists?: (path: string) => boolean
  pathDelimiter?: string
}

/** Bundled Node locations shipped inside the DSH desktop payload. */
const DESKTOP_NODE_CANDIDATES = [
  ['resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'],
  ['resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node'],
  ['resources', 'runtime', 'bin', 'node.exe'],
  ['resources', 'runtime', 'node', 'node.exe'],
  ['resources', 'node', 'node.exe'],
] as const

/** Executable names to look for when falling back to `PATH`. */
const PATH_NODE_NAMES = process.platform === 'win32' ? ['node.exe'] : ['node']

/**
 * Pick the executable that must run `lib/bridge.mjs`.
 *
 * The bridge is a plain Node program, so on a Node host `process.execPath` is
 * exact. Under the DSH desktop app the host process is Electron, where
 * `process.execPath` is `DeepSeek Harness.exe`: spawning it starts (or
 * single-instance-aborts) a second app instead of running the script, which is
 * why the bridge never listened. The desktop payload ships a real Node, so it
 * is probed first; the platform launcher variables and an explicit override come
 * before that, and Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`) is the last resort.
 */
export function resolveBridgeRuntime(probe: RuntimeProbe = {}): BridgeRuntime {
  const env = probe.env ?? process.env
  const execPath = probe.execPath ?? process.execPath
  const exists = probe.exists ?? existsSync
  const isElectron = (probe.versions ?? process.versions).electron !== undefined

  const override = env.DSH_EDA_MCP_NODE
  if (override !== undefined && override !== '' && exists(override)) {
    return { command: override, extraEnv: {}, source: 'DSH_EDA_MCP_NODE override' }
  }

  // The desktop launcher exports the app binary under these names and expects
  // callers to set ELECTRON_RUN_AS_NODE (see its own runtime/bin/node.cmd).
  for (const name of ['DSH_NODE_EXECUTABLE', 'DSH_DESKTOP_NODE_EXECUTABLE']) {
    const value = env[name]
    if (value !== undefined && value !== '' && exists(value)) {
      return { command: value, extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, source: `${name}` }
    }
  }

  if (!isElectron) {
    return { command: execPath, extraEnv: {}, source: 'process.execPath (Node host)' }
  }

  const root = dirname(execPath)
  for (const parts of DESKTOP_NODE_CANDIDATES) {
    const candidate = join(root, ...parts)
    if (exists(candidate)) return { command: candidate, extraEnv: {}, source: 'desktop runtime Node' }
  }

  const pathValue = env.PATH ?? env.Path ?? ''
  for (const entry of pathValue.split(probe.pathDelimiter ?? delimiter)) {
    const dir = entry.replace(/^"|"$/g, '').trim()
    if (dir === '') continue
    for (const name of PATH_NODE_NAMES) {
      const candidate = join(dir, name)
      if (exists(candidate)) return { command: candidate, extraEnv: {}, source: 'PATH Node' }
    }
  }

  return {
    command: execPath,
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    source: 'process.execPath + ELECTRON_RUN_AS_NODE (Electron as Node)',
  }
}

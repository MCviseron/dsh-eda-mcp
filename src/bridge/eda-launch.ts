/**
 * Launching JLCEDA Pro (EasyEDA Pro) from a tool call.
 *
 * Nothing here is machine-specific: the executable is resolved from an explicit
 * override, an environment variable, the registry entry the installer creates, a
 * list of conventional install directories, and finally PATH. Every step is
 * skipped when its inputs are absent.
 *
 * String operations only (no regex literals): the discovery rules stay readable
 * and the resolution order is unit-tested without spawning anything.
 */

export type Platform = 'win32' | 'darwin' | 'linux' | (string & {})

/** Everything the resolver needs from the outside world. */
export interface LaunchProbe {
  platform: Platform
  env: Record<string, string | undefined>
  exists: (path: string) => boolean
  /** Raw stdout of the registry query, or undefined when the key does not exist. */
  registryQuery: (key: string, valueName?: string) => string | undefined
}

export interface ResolveOptions {
  executable?: string
  project?: string
}

export type ExecutableSource = 'config' | 'env' | 'registry' | 'install-dir' | 'path'

export interface ResolvedLaunch {
  executable: string
  source: ExecutableSource
}

export const EXECUTABLE_ENV_KEYS = ['DSH_EDA_EXECUTABLE', 'JLCEDA_EXECUTABLE'] as const
export const EXECUTABLE_NAMES = ['lceda-pro.exe', 'lceda-pro', 'LCEDA Pro'] as const
export const PROJECT_EXTENSIONS = ['.eprj2', '.eprj'] as const

const CN_PRO_EDITION = '嘉立创EDA专业版'
const CLASSES = 'Software\\Classes'

export const INSTALL_SUFFIXES = [
  'lceda-pro',
  'Program Files\\lceda-pro',
  'Program Files (x86)\\lceda-pro',
  'Program Files\\' + CN_PRO_EDITION,
  'Program Files (x86)\\' + CN_PRO_EDITION,
] as const

/** Strip trailing path separators from a directory. */
function trimSeparator(value: string): string {
  let end = value.length
  while (end > 0) {
    const ch = value[end - 1]
    if (ch !== '\\' && ch !== '/') break
    end -= 1
  }
  return value.slice(0, end)
}

/** Strip leading path separators. */
function trimLeadingSeparators(value: string): string {
  let start = 0
  while (start < value.length && (value[start] === '\\' || value[start] === '/')) start += 1
  return value.slice(start)
}

function joinPath(platform: Platform, ...parts: string[]): string {
  const separator = platform === 'win32' ? '\\' : '/'
  return parts
    .filter(part => part !== '')
    .map((part, index) => (index === 0 ? part : trimLeadingSeparators(part)))
    .join(separator)
}

/** Split an install suffix into path segments, on either separator. */
function splitSegments(value: string): string[] {
  return value.split('\\').join('/').split('/').filter(part => part !== '')
}

/**
 * Pull the executable out of a registered open command such as
 * `"D:\\lceda-pro\\lceda-pro.exe" "%1"` or `C:\\App\\lceda-pro.exe %1`.
 */
export function parseExecutableFromCommand(command: string | undefined): string | undefined {
  const text = (command ?? '').trim()
  if (text === '') return undefined
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    if (end === -1) return undefined
    const quoted = text.slice(1, end).trim()
    return quoted === '' ? undefined : quoted
  }
  const space = text.indexOf(' ')
  const tab = text.indexOf(String.fromCharCode(9))
  const stops = [space, tab].filter(index => index > 0)
  const end = stops.length === 0 ? text.length : Math.min(...stops)
  const first = text.slice(0, end).trim()
  return first === '' ? undefined : first
}

/** Take the string payload of a registry line (`... REG_SZ  <value>`). */
export function parseRegStringValue(output: string | undefined): string | undefined {
  for (const raw of (output ?? '').split(String.fromCharCode(10))) {
    const line = raw.trim()
    const index = line.toUpperCase().indexOf('REG_SZ')
    if (index === -1) continue
    const value = line.slice(index + 'REG_SZ'.length).trim()
    // `reg query` prints "(value not set)" for an unset default; it is not a value.
    if (value === '' || value.startsWith('(')) continue
    return value
  }
  return undefined
}

/** Value names of a registry listing (the first column of every value line). */
export function parseRegValueNames(output: string | undefined): string[] {
  const names: string[] = []
  for (const raw of (output ?? '').split(String.fromCharCode(10))) {
    const line = raw.trim()
    const marker = line.indexOf('REG_')
    if (marker <= 0) continue
    const name = line.slice(0, marker).trim()
    if (name !== '' && !name.startsWith('HKEY')) names.push(name)
  }
  return names
}

function firstExisting(probe: LaunchProbe, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== '' && probe.exists(candidate)) return candidate
  }
  return undefined
}

/** Candidate executables derived from environment variables (no registry access). */
export function envCandidates(probe: LaunchProbe): string[] {
  const env = probe.env
  const roots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA === undefined ? undefined : joinPath(probe.platform, env.LOCALAPPDATA, 'Programs'),
    env.APPDATA === undefined ? undefined : joinPath(probe.platform, env.APPDATA, 'Programs'),
    env.SystemDrive,
    env.USERPROFILE,
    env.HOME,
  ].filter((root): root is string => typeof root === 'string' && root !== '')

  const candidates: string[] = []
  for (const root of roots) {
    for (const suffix of INSTALL_SUFFIXES) {
      for (const name of EXECUTABLE_NAMES) {
        candidates.push(joinPath(probe.platform, trimSeparator(root), ...splitSegments(suffix), name))
      }
    }
  }
  return candidates
}

/** Look for the executable in the directories listed on PATH. */
export function pathCandidates(probe: LaunchProbe): string[] {
  const raw = probe.env.PATH ?? probe.env.Path ?? ''
  const separator = probe.platform === 'win32' ? ';' : ':'
  return raw
    .split(separator)
    .filter(dir => dir.trim() !== '')
    .flatMap(dir => EXECUTABLE_NAMES.map(name => joinPath(probe.platform, trimSeparator(dir), name)))
}

/**
 * Ask the registry where the installer registered the project handler.
 *
 * The extension's default progid is often empty while `OpenWithProgids` lists the
 * real one, so both are consulted. HKCU wins over HKLM; HKCR is skipped because
 * it merges the two.
 */
export function registryCandidates(probe: LaunchProbe): string[] {
  if (probe.platform !== 'win32') return []
  const found: string[] = []
  for (const hive of ['HKCU', 'HKLM']) {
    for (const extension of PROJECT_EXTENSIONS) {
      const base = hive + '\\' + CLASSES + '\\' + extension
      const defaults = [parseRegStringValue(probe.registryQuery(base, '')), parseRegStringValue(probe.registryQuery(base))]
      const progids = [
        ...defaults.filter((value): value is string => value !== undefined),
        ...parseRegValueNames(probe.registryQuery(base + '\\OpenWithProgids')),
      ]
      for (const progid of progids) {
        if (progid.startsWith('Applications' + '\\')) continue
        const command = parseRegStringValue(
          probe.registryQuery(hive + '\\' + CLASSES + '\\' + progid + '\\shell\\open\\command'),
        )
        const executable = parseExecutableFromCommand(command)
        if (executable !== undefined) found.push(executable)
      }
    }
  }
  return found
}

/** Resolve the executable, or undefined when nothing on this machine matches. */
export function resolveExecutable(probe: LaunchProbe, options: ResolveOptions = {}): ResolvedLaunch | undefined {
  const override = options.executable?.trim()
  if (override !== undefined && override !== '' && probe.exists(override)) {
    return { executable: override, source: 'config' }
  }

  for (const key of EXECUTABLE_ENV_KEYS) {
    const value = probe.env[key]?.trim()
    if (value !== undefined && value !== '' && probe.exists(value)) return { executable: value, source: 'env' }
  }

  const fromRegistry = firstExisting(probe, registryCandidates(probe))
  if (fromRegistry !== undefined) return { executable: fromRegistry, source: 'registry' }

  const fromInstallDir = firstExisting(probe, envCandidates(probe))
  if (fromInstallDir !== undefined) return { executable: fromInstallDir, source: 'install-dir' }

  const fromPath = firstExisting(probe, pathCandidates(probe))
  if (fromPath !== undefined) return { executable: fromPath, source: 'path' }

  return undefined
}

/** Arguments used to open the app (and optionally a project) on each platform. */
export function buildLaunchArgs(platform: Platform, executable: string, project?: string): { command: string; args: string[] } {
  const target = project?.trim()
  const hasProject = target !== undefined && target !== ''
  if (platform === 'darwin') {
    return hasProject
      ? { command: 'open', args: ['-a', executable, target as string] }
      : { command: 'open', args: ['-a', executable] }
  }
  return hasProject ? { command: executable, args: [target as string] } : { command: executable, args: [] }
}

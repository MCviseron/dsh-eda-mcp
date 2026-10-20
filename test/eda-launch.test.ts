/**
 * eda-launch: executable discovery and launch argument shaping.
 *
 * `node --experimental-strip-types test/eda-launch.test.ts`
 *
 * No process is spawned: the resolver takes a `LaunchProbe` seam and the registry
 * output is fed as text, so the cases below run identically on any machine.
 */
import {
  buildLaunchArgs, envCandidates, parseExecutableFromCommand, parseRegStringValue,
  parseRegValueNames, pathCandidates, registryCandidates, resolveExecutable,
  type LaunchProbe,
} from '../src/bridge/eda-launch.ts'

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) console.log(`     got      ${JSON.stringify(actual)}\n     expected ${JSON.stringify(expected)}`)
}

function probe(overrides: Partial<LaunchProbe> & { files?: string[] } = {}): LaunchProbe {
  const files = new Set(overrides.files ?? [])
  return {
    platform: overrides.platform ?? 'win32',
    env: overrides.env ?? {},
    exists: overrides.exists ?? ((path: string) => files.has(path)),
    registryQuery: overrides.registryQuery ?? (() => undefined),
  }
}

// --- command line parsing ------------------------------------------------
check('quoted exe with %1', parseExecutableFromCommand('"D:\\lceda-pro\\lceda-pro.exe" "%1"'), 'D:\\lceda-pro\\lceda-pro.exe')
check('unquoted exe with %1', parseExecutableFromCommand('C:\\App\\lceda-pro.exe %1'), 'C:\\App\\lceda-pro.exe')
check('quoted exe without args', parseExecutableFromCommand('"C:\\Program Files\\LCEDA Pro\\lceda-pro.exe"'), 'C:\\Program Files\\LCEDA Pro\\lceda-pro.exe')
check('empty command', parseExecutableFromCommand(''), undefined)
check('undefined command', parseExecutableFromCommand(undefined), undefined)
check('unterminated quote is rejected', parseExecutableFromCommand('"C:\\broken'), undefined)

// --- registry output parsing --------------------------------------------
const regDefault = `\r\nHKEY_CURRENT_USER\\Software\\Classes\\嘉立创EDA库文件\\shell\\open\\command\r\n    (默认)    REG_SZ    "D:\\lceda-pro\\lceda-pro.exe" "%1"\r\n\r\n`
check('REG_SZ payload', parseRegStringValue(regDefault), '"D:\\lceda-pro\\lceda-pro.exe" "%1"')
check('missing REG_SZ', parseRegStringValue('no such key'), undefined)
check('OpenWithProgids names', parseRegValueNames('HKEY_CURRENT_USER\\Software\\Classes\\.eprj2\\OpenWithProgids\r\n    MyProgid    REG_NONE\r\n    Other    REG_NONE\r\n'), ['MyProgid', 'Other'])
check('empty OpenWithProgids', parseRegValueNames(''), [])

// --- resolution order ----------------------------------------------------
const exeFromRegistry = 'D:\\lceda-pro\\lceda-pro.exe'
const registryOutput = (key: string): string | undefined => {
  if (key.endsWith('.eprj2\\OpenWithProgids')) return '    JlcProEdaFile    REG_NONE\r\n'
  if (key.endsWith('JlcProEdaFile\\shell\\open\\command')) return '    (默认)    REG_SZ    "D:\\lceda-pro\\lceda-pro.exe" "%1"\r\n'
  return undefined
}

check('registry hit', resolveExecutable(probe({ files: [exeFromRegistry], registryQuery: registryOutput })), { executable: exeFromRegistry, source: 'registry' })

check('config override wins', resolveExecutable(
  probe({ files: ['C:\\custom\\lceda.exe', exeFromRegistry], registryQuery: registryOutput }),
  { executable: 'C:\\custom\\lceda.exe' },
), { executable: 'C:\\custom\\lceda.exe', source: 'config' })

check('a missing config override is skipped', resolveExecutable(
  probe({ files: [exeFromRegistry], registryQuery: registryOutput }),
  { executable: 'C:\\does\\not\\exist.exe' },
), { executable: exeFromRegistry, source: 'registry' })

check('env var used when config is absent', resolveExecutable(
  probe({ env: { DSH_EDA_EXECUTABLE: 'E:\\eda\\lceda-pro.exe' }, files: ['E:\\eda\\lceda-pro.exe', exeFromRegistry], registryQuery: registryOutput }),
), { executable: 'E:\\eda\\lceda-pro.exe', source: 'env' })

check('second env key is honoured', resolveExecutable(
  probe({ env: { JLCEDA_EXECUTABLE: 'E:\\eda2\\lceda-pro.exe' }, files: ['E:\\eda2\\lceda-pro.exe'] }),
), { executable: 'E:\\eda2\\lceda-pro.exe', source: 'env' })

const programFilesExe = 'C:\\Program Files\\lceda-pro\\lceda-pro.exe'
check('install dir candidate', resolveExecutable(
  probe({ env: { ProgramFiles: 'C:\\Program Files' }, files: [programFilesExe] }),
), { executable: programFilesExe, source: 'install-dir' })

check('PATH candidate', resolveExecutable(
  probe({ env: { PATH: 'C:\\tools;D:\\bin' }, files: ['D:\\bin\\lceda-pro.exe'] }),
), { executable: 'D:\\bin\\lceda-pro.exe', source: 'path' })

check('nothing found', resolveExecutable(probe({ env: {} })), undefined)
check('registry is ignored off Windows', registryCandidates(probe({ platform: 'linux' })), [])

// --- candidate generation ------------------------------------------------
check('install candidates include Program Files', envCandidates(probe({ env: { ProgramFiles: 'C:\\Program Files' } })).includes(programFilesExe), true)
check('PATH candidates split on ;', pathCandidates(probe({ env: { PATH: 'A;B' } })), ['A\\lceda-pro.exe', 'A\\lceda-pro', 'A\\LCEDA Pro', 'B\\lceda-pro.exe', 'B\\lceda-pro', 'B\\LCEDA Pro'])
check('PATH candidates split on : off Windows', pathCandidates(probe({ platform: 'linux', env: { PATH: '/usr/bin:/opt' } })).slice(0, 2), ['/usr/bin/lceda-pro.exe', '/usr/bin/lceda-pro'])

// --- launch arguments ----------------------------------------------------
check('windows without project', buildLaunchArgs('win32', 'D:\\lceda-pro\\lceda-pro.exe'), { command: 'D:\\lceda-pro\\lceda-pro.exe', args: [] })
check('windows with project', buildLaunchArgs('win32', 'D:\\lceda-pro\\lceda-pro.exe', 'D:\\p\\a.eprj2'), { command: 'D:\\lceda-pro\\lceda-pro.exe', args: ['D:\\p\\a.eprj2'] })
check('blank project is ignored', buildLaunchArgs('win32', 'X.exe', '   '), { command: 'X.exe', args: [] })
check('macOS opens the app bundle', buildLaunchArgs('darwin', '/Applications/LCEDA Pro.app'), { command: 'open', args: ['-a', '/Applications/LCEDA Pro.app'] })
check('macOS opens the document', buildLaunchArgs('darwin', '/Applications/LCEDA Pro.app', '/p/a.eprj2'), { command: 'open', args: ['-a', '/Applications/LCEDA Pro.app', '/p/a.eprj2'] })
check('linux runs the binary', buildLaunchArgs('linux', '/opt/lceda-pro', '/p/a.eprj2'), { command: '/opt/lceda-pro', args: ['/p/a.eprj2'] })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

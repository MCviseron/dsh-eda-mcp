/**
 * Seam compatibility test: the exact shapes this plugin probes at runtime.
 *
 * `node --experimental-strip-types test/seams.test.ts`
 * `DSH_SEAM_ROOT=<dir with node_modules> node --experimental-strip-types test/seams.test.ts`
 *
 * The second form runs the same assertions against another DSH generation — that
 * is how a new `@deepseek-ai/*` version line is checked before widening the
 * supported ranges (see `scripts/seam-check.mjs`).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const seamRoot = process.env.DSH_SEAM_ROOT ?? process.cwd()
let failures = 0

// --- extension version single source of truth ----------------------------
// The extension announces its version over the WebSocket. It once carried a
// hand-written constant that went stale (manifest 0.3.6, runtime 0.3.5), so the
// bridge reported a version mismatch no matter what was imported. The build
// injects the manifest version into the placeholder; keep it that way.
{
  const extensionDir = join(process.cwd(), 'jlc-extension')
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'extension.json'), 'utf8')) as { version: string }
  const bridgeSource = readFileSync(join(extensionDir, 'api-bridge.js'), 'utf8')
  report('extension manifest declares a version', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version)
  report('api-bridge.js keeps the version placeholder', bridgeSource.includes('__EXTENSION_VERSION__'))
  report('api-bridge.js has no hard-coded version constant', !/var VERSION = '\d/.test(bridgeSource))
}

function report(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ' — ' + detail}`)
}

/** Resolve a package's entry point the way Node would, without installing it. */
function packageEntry(name: string): string | undefined {
  const dir = join(seamRoot, 'node_modules', ...name.split('/'))
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return undefined
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  const exported = pkg.exports?.['.'] ?? pkg.exports
  const target = typeof exported === 'string'
    ? exported
    : (typeof exported === 'object' ? (exported.import ?? exported.default ?? exported.require) : undefined)
  const main = typeof target === 'string' ? target : (pkg.main ?? 'index.js')
  return join(dir, main)
}

async function load(name: string): Promise<{ version: string; module: Record<string, unknown> } | undefined> {
  const entry = packageEntry(name)
  if (entry === undefined) return undefined
  const pkg = JSON.parse(readFileSync(join(seamRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
  const module = await import(pathToFileURL(entry).href)
  return { version: pkg.version, module: module as Record<string, unknown> }
}

const PACKAGES = [
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-host-webserver',
]

console.log(`seam root: ${seamRoot}`)
const loaded = new Map<string, { version: string; module: Record<string, unknown> }>()

for (const name of PACKAGES) {
  const result = await load(name)
  if (result === undefined) {
    console.log(`SKIP ${name} — not installed under ${seamRoot}`)
    continue
  }
  loaded.set(name, result)
  console.log(`  ${name} = ${result.version}`)
}

// --- dsh-mcp-client: inject ['tools'], stdio config keys, serverName guard ----
{
  const client = loaded.get('@deepseek-ai/dsh-mcp-client')
  if (client !== undefined) {
    const plugin = (client.module.default ?? client.module.apply ?? client.module) as Record<string, unknown>
    const inject = (plugin.inject ?? (client.module as Record<string, unknown>).inject) as string[] | undefined
    report('mcp-client exposes an inject list containing "tools"', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject))
    const config = plugin.Config ?? (client.module as Record<string, unknown>).Config
    let schemaText = ''
    try { schemaText = JSON.stringify(config?.toJSON?.() ?? '') } catch { schemaText = '' }
    for (const key of ['serverName', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect']) {
      report(`mcp-client Config declares "${key}"`, schemaText.includes(`"${key}"`), '')
    }
  }
}

// --- dsh-settings: the three generation faces our installer probes ----------
{
  const settings = loaded.get('@deepseek-ai/dsh-settings')
  if (settings !== undefined) {
    const m = settings.module
    const provider = (m.default ?? m.SettingsForms ?? m.Settings ?? m) as unknown
    const faces = typeof provider === 'function' ? (provider as unknown as { prototype?: Record<string, unknown> }).prototype ?? {} : (provider as Record<string, unknown>)
    const hasAny = ['configure', 'installSection', 'register'].filter(key => typeof (faces as Record<string, unknown>)[key] === 'function')
    report('dsh-settings still exposes a settings face (configure / installSection / register)', hasAny.length > 0, hasAny.join(',') || 'none')
    const entryPoints = ['default', 'SettingsProvider', 'SettingsForms', 'Settings', 'installSettingsSection']
      .filter(key => typeof (m as Record<string, unknown>)[key] === 'function')
    report('dsh-settings exports a provider entry point', entryPoints.length > 0, entryPoints.join(',') || Object.keys(m).slice(0, 12).join(','))
  }
}

// --- dsh-system-prompt: section({ name, order, text }) ----------------------
{
  const prompt = loaded.get('@deepseek-ai/dsh-system-prompt')
  if (prompt !== undefined) {
    const m = prompt.module
    const service = (m.SystemPrompt ?? m.default ?? m.Service) as unknown
    const proto = typeof service === 'function' ? (service as { prototype?: Record<string, unknown> }).prototype ?? {} : (service as Record<string, unknown>)
    report('dsh-system-prompt Service has section()', typeof (proto as Record<string, unknown>).section === 'function', '')
    const source = readFileSync(packageEntry('@deepseek-ai/dsh-system-prompt')!, 'utf8')
    const takesObject = /section\(\{\s*name/.test(source) || /name:\s*["']harness:identity/.test(source)
    report('dsh-system-prompt section() is called with a single { name, order, text } object', takesObject, '')
  }
}

// --- dsh-host-webserver: register({ kind: 'exact', path, handler }) ---------
{
  const webserver = loaded.get('@deepseek-ai/dsh-host-webserver')
  if (webserver !== undefined) {
    const source = readFileSync(packageEntry('@deepseek-ai/dsh-host-webserver')!, 'utf8')
    report('dsh-host-webserver keeps the exact/prefix route tables', /route\.kind === "exact"/.test(source) || /route\.kind === 'exact'/.test(source), '')
    report('dsh-host-webserver register() returns a disposer', /register\(route\)[\s\S]{0,400}table\.delete\(route\.path\)/.test(source), '')
  }
}

// --- client-side packages: nothing is asserted, only recorded --------------
for (const name of ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings']) {
  const entry = packageEntry(name)
  if (entry !== undefined) {
    const pkg = JSON.parse(readFileSync(join(seamRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    console.log(`  (client) ${name} = ${pkg.version}`)
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

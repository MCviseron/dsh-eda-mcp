// Runs the seam compatibility test against an arbitrary DSH version line.
//
//   node scripts/seam-check.mjs                 # npm dist-tag "latest"
//   node scripts/seam-check.mjs next            # npm dist-tag "next"
//   node scripts/seam-check.mjs 0.2.1-rc.2      # explicit version
//
// The seam packages this plugin mounts are installed into a throwaway directory,
// then test/seams.test.ts runs against them with DSH_SEAM_ROOT. Nothing touches
// the repository's own node_modules.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGES = [
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
]

/**
 * Resolve a dist-tag to a concrete version.
 *
 * The dist-tags live on the meta package `@deepseek-ai/dsh`: the individual seam
 * packages publish their own `latest` pointing at an old placeholder
 * (`0.0.1-rc.1`), so resolving through them would test the wrong generation.
 */
async function resolveVersion(requested) {
  if (/^\d+\.\d+\.\d+/.test(requested)) return requested
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2fdsh', { signal: AbortSignal.timeout(20000) })
  if (response.status !== 200) throw new Error('registry request failed with HTTP ' + response.status)
  const doc = await response.json()
  const resolved = doc['dist-tags']?.[requested]
  if (resolved === undefined) {
    throw new Error(`unknown dist-tag "${requested}" on @deepseek-ai/dsh (have: ${Object.keys(doc['dist-tags'] ?? {}).join(', ')})`)
  }
  return resolved
}

const requested = process.argv[2] ?? 'latest'
let version
try {
  version = await resolveVersion(requested)
} catch (error) {
  console.error('seam-check: ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
console.log(`seam-check: ${requested} -> ${version}`)

const workDir = mkdtempSync(join(tmpdir(), 'dsh-seam-'))
try {
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'seam-check', private: true, version: '0.0.0' }, null, 2))
  const specs = PACKAGES.map(name => `${name}@${version}`)
  console.log('installing:', specs.join(' '))
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', '--loglevel=error', ...specs], {
    cwd: workDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  execFileSync(process.execPath, ['--experimental-strip-types', join(root, 'test', 'seams.test.ts')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DSH_SEAM_ROOT: workDir },
  })
  console.log(`\nseam-check: ${version} is compatible with every seam this plugin probes`)
} catch (error) {
  console.error(`\nseam-check: ${version} FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

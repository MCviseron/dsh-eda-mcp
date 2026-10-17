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

/** Resolve a dist-tag to a concrete version so the report names what it tested. */
async function resolveVersion(requested) {
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2fdsh-mcp-client', { signal: AbortSignal.timeout(20000) })
  if (response.status !== 200) throw new Error('registry request failed with HTTP ' + response.status)
  const doc = await response.json()
  const resolved = doc['dist-tags']?.[requested] ?? requested
  return resolved
}

const requested = process.argv[2] ?? 'latest'
const version = await resolveVersion(requested)
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

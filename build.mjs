import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sharedExternal = [
  '@deepseek-ai/*',
  '@deepseek-ai/schemastery',
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
]

/**
 * esbuild writes a `// node_modules/.pnpm/<pkg>_<peer-hash>/…` comment for every
 * inlined module. The peer hash depends on the local pnpm layout, so the same
 * source produces different bytes on different machines — which breaks both a
 * "committed build matches a fresh build" check and reproducible publishing.
 * The comments carry no runtime meaning, so they are stripped.
 */
async function stripBuildComments(file) {
  const text = await readFile(file, 'utf8')
  const kept = text.split('\n').filter(line => !/^\s*\/\/\s*node_modules\//.test(line))
  if (kept.length === text.split('\n').length) return 0
  const stripped = kept.join('\n')
  await writeFile(file, stripped, 'utf8')
  return text.length - stripped.length
}

await mkdir('lib', { recursive: true })

// Host half: one ESM bundle with local source inlined and all shared packages external.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: sharedExternal,
  sourcemap: false,
  logLevel: 'info',
})

// Standalone MCP/WebSocket bridge child process. Everything is bundled so the
// child only needs Node built-ins and never resolves from the profile's
// node_modules at runtime.
await build({
  entryPoints: ['src/bridge/index.ts'],
  outfile: 'lib/bridge.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
})

// Browser half: bundle as CommonJS, then wrap it in the DSH module-loader
// format the Web shell executes. External runtime modules are provided by the
// shell's require(), exactly like the official dsh-* client bundles.
const client = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-locale/client',
    '@deepseek-ai/dsh-client-ui-settings/client',
    '@deepseek-ai/dsh-client-ui-renderer/client',
    '@deepseek-ai/dsh-client-connection/client',
  ],
  sourcemap: false,
  write: false,
  logLevel: 'info',
})

let code = client.outputFiles[0]?.text ?? ''
const useStrict = code.startsWith('"use strict";\n') ? '"use strict";\n' : code.startsWith("'use strict';\n") ? "'use strict';\n" : ''
if (useStrict !== '') code = code.slice(useStrict.length)
const wrapped = [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-eda-mcp",',
  '  factory: (require) => {',
  useStrict,
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  code,
  '    return module.exports;',
  '  }',
  '});',
  '',
].filter(line => line !== '').join('\n')

await writeFile('lib/client.js', wrapped, 'utf8')

// Package the JLCEDA Pro bridge extension as a zip for the "Extensions →
// Import" flow. PowerShell Compress-Archive is available on the Windows
// desktop this plugin targets.
// The extension reports its version over the WebSocket, and a hand-maintained
// constant there silently went stale once (the manifest said 0.3.6 while the
// runtime kept announcing 0.3.5). The version now lives only in extension.json:
// api-bridge.js carries a placeholder that is substituted into a staged copy, so
// the two can never disagree again.
const extensionVersion = JSON.parse(await readFile(join('jlc-extension', 'extension.json'), 'utf8')).version
const versionPlaceholder = '__EXTENSION_VERSION__'
const stage = join(tmpdir(), 'dsh-eda-extension-' + Date.now())
await cp('jlc-extension', stage, { recursive: true })
const stagedBridge = join(stage, 'api-bridge.js')
const bridgeSource = await readFile(stagedBridge, 'utf8')
if (!bridgeSource.includes(versionPlaceholder)) {
  throw new Error('jlc-extension/api-bridge.js must use the ' + versionPlaceholder + ' placeholder for its version')
}
await writeFile(stagedBridge, bridgeSource.split(versionPlaceholder).join(extensionVersion), 'utf8')

const zipTarget = 'dsh-eda-bridge-extension.zip'
await rm(zipTarget, { force: true })
execFileSync('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${join(stage, '*')}' -DestinationPath '${join(process.cwd(), zipTarget)}' -Force`,
], { stdio: 'inherit' })
await rm(stage, { recursive: true, force: true })

console.log('built lib/index.js, lib/client.js, lib/bridge.mjs, and ' + zipTarget)

// Reproducibility: drop the build-machine-specific module comments from every
// bundle (see stripBuildComments) so two machines produce identical bytes.
let strippedBytes = 0
for (const file of ['lib/index.js', 'lib/bridge.mjs', 'lib/client.js']) {
  strippedBytes += await stripBuildComments(file)
}
const leftovers = await readFile('lib/client.js', 'utf8')
const stillEmbedded = (leftovers.match(/^\s*\/\/\s*node_modules\//gm) ?? []).length
console.log('stripped ' + strippedBytes + ' bytes of build-machine paths' + (stillEmbedded === 0 ? '' : ' (WARNING: ' + stillEmbedded + ' left)'))

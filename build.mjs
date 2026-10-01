import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sharedExternal = [
  '@deepseek-ai/*',
  '@deepseek-ai/schemastery',
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
]

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
const zipTarget = 'dsh-eda-bridge-extension.zip'
await rm(zipTarget, { force: true })
execFileSync('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${join(process.cwd(), 'jlc-extension', '*')}' -DestinationPath '${join(process.cwd(), zipTarget)}' -Force`,
], { stdio: 'inherit' })

console.log('built lib/index.js, lib/client.js, lib/bridge.mjs, and ' + zipTarget)

/**
 * Node-executable resolution test.
 *
 * Runs on the Node the plugin requires (`engines.node >= 22.19`), which strips
 * the TS types itself: `node --experimental-strip-types test/node-runtime.test.ts`.
 */
import { resolveBridgeRuntime } from '../src/node-runtime.ts'

const APP = 'D:\\DeepSeek Harness\\DeepSeek Harness.exe'
const PAYLOAD_NODE = 'D:\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe'
const PATH_NODE = 'C:\\tools\\nodejs\\node.exe'

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) console.log(`     got      ${JSON.stringify(actual)}\n     expected ${JSON.stringify(expected)}`)
}

const existsWith = (...paths: string[]) => (candidate: string) => paths.includes(candidate)

check('Node host keeps process.execPath', resolveBridgeRuntime({
  env: {}, execPath: 'C:\\node\\node.exe', versions: {}, exists: existsWith(),
}), { command: 'C:\\node\\node.exe', extraEnv: {}, source: 'process.execPath (Node host)' })

check('Electron host finds the bundled desktop Node', resolveBridgeRuntime({
  env: {}, execPath: APP, versions: { electron: '38.0.0' }, exists: existsWith(APP, PAYLOAD_NODE),
}), { command: PAYLOAD_NODE, extraEnv: {}, source: 'desktop runtime Node' })

check('explicit override wins', resolveBridgeRuntime({
  env: { DSH_EDA_MCP_NODE: PATH_NODE }, execPath: APP, versions: { electron: '38.0.0' }, exists: existsWith(APP, PAYLOAD_NODE, PATH_NODE),
}), { command: PATH_NODE, extraEnv: {}, source: 'DSH_EDA_MCP_NODE override' })

check('missing override falls through', resolveBridgeRuntime({
  env: { DSH_EDA_MCP_NODE: 'C:\\nope\\node.exe' }, execPath: APP, versions: { electron: '38.0.0' }, exists: existsWith(APP, PAYLOAD_NODE),
}), { command: PAYLOAD_NODE, extraEnv: {}, source: 'desktop runtime Node' })

check('desktop launcher variable runs the app binary as Node', resolveBridgeRuntime({
  env: { DSH_DESKTOP_NODE_EXECUTABLE: APP }, execPath: APP, versions: { electron: '38.0.0' }, exists: existsWith(APP),
}), { command: APP, extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, source: 'DSH_DESKTOP_NODE_EXECUTABLE' })

check('PATH fallback when the payload ships no Node', resolveBridgeRuntime({
  env: { PATH: 'C:\\tools\\nodejs;C:\\Windows' }, execPath: APP, versions: { electron: '38.0.0' }, exists: existsWith(APP, PATH_NODE),
}), { command: PATH_NODE, extraEnv: {}, source: 'PATH Node' })

check('last resort: Electron as Node', resolveBridgeRuntime({
  env: { PATH: 'C:\\Windows' }, execPath: APP, versions: { electron: '38.0.0' }, exists: existsWith(APP),
}), { command: APP, extraEnv: { ELECTRON_RUN_AS_NODE: '1' }, source: 'process.execPath + ELECTRON_RUN_AS_NODE (Electron as Node)' })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

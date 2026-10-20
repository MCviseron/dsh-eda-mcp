import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEdaMcpRoutes, EDA_MCP_API } from '../src/routes.ts'
import { sha256Of } from '../src/bridge/extension-package.ts'

// The package ships no zip: only lib/extension-digest.json. These cases pin the contract that
// the download route serves the SERVER copy but only after it matches the build digest.
const goodBytes = Buffer.from('PK\x03\x04 pretending to be the extension zip')
const goodSha = sha256Of(goodBytes)
const digestDir = mkdtempSync(join(tmpdir(), 'dsh-digest-'))
const digestPath = join(digestDir, 'extension-digest.json')
writeFileSync(digestPath, JSON.stringify({
  version: '0.4.9',
  file: 'dsh-eda-bridge-extension-0.4.9.zip',
  bytes: goodBytes.byteLength,
  sha256: goodSha,
}))

function fakeReq(method: string, url = '/') {
  return { method, url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' } }
}
function fakeRes() {
  const captured: { status?: number; headers?: Record<string, string>; body?: unknown; bytes?: Buffer } = {}
  const res = {
    writeHead(status: number, headers: Record<string, string>) { captured.status = status; captured.headers = headers; return res },
    end(payload?: unknown) { if (Buffer.isBuffer(payload)) captured.bytes = payload; else if (typeof payload === 'string') captured.body = payload; return res },
    destroy() { return res }, getHeader() { return undefined }, setHeader() { return res },
  }
  return { res, captured }
}
function deps(base: string) {
  return {
    getConfig: () => ({}),
    extensionDigestPath: digestPath,
    extensionVersion: '0.4.9',
    extensionDownloadBase: base,
    reconnect: () => {},
    bridgeLaunch: () => ({ command: 'node', args: [], source: 'test' }),
    diagnostics: () => ({}),
    launchConfig: () => ({}),
    selfTest: async () => ({}),
  }
}
function routeOf(routes: ReturnType<typeof makeEdaMcpRoutes>, path: string) {
  const route = routes.find(r => r.path === path)
  assert.ok(route, 'route ' + path + ' must exist')
  return route
}
async function withServer(handler: Parameters<typeof createServer>[1], run: (base: string) => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try { await run('http://127.0.0.1:' + port + '/eda/') } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}

// 1. matching served copy -> handed out, labelled as coming from the server
await withServer((_req, res) => { res.writeHead(200); res.end(goodBytes) }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionZip).handler(fakeReq('GET') as never, res as never)
  assert.equal(captured.status, 200)
  assert.equal(captured.headers?.['x-extension-source'], 'server')
  assert.equal(captured.headers?.['x-extension-sha256'], goodSha)
  assert.equal(captured.headers?.['content-disposition'], 'attachment; filename="dsh-eda-bridge-extension-0.4.9.zip"')
  assert.equal(sha256Of(captured.bytes as Buffer), goodSha, 'the bytes handed out are the served ones')
})

// 2. different wire version served -> refused, nothing downloaded
await withServer((_req, res) => { res.writeHead(200); res.end(Buffer.from('some other build')) }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionZip).handler(fakeReq('GET') as never, res as never)
  const body = JSON.parse(String(captured.body))
  assert.equal(captured.status, 502)
  assert.equal(body.expected.sha256, goodSha)
  assert.equal(String(body.error).includes('refusing'), true)
  assert.equal(captured.bytes, undefined, 'no bytes may be handed out on mismatch')
})

// 3. throttled server -> 429 surfaced as throttling
await withServer((_req, res) => { res.writeHead(429); res.end('slow down') }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionZip).handler(fakeReq('GET') as never, res as never)
  const body = JSON.parse(String(captured.body))
  assert.equal(captured.status, 429)
  assert.equal(body.httpStatus, 429)
  assert.equal(String(body.error).includes('throttled'), true)
})

// 4. verify route compares against the digest without any local zip
await withServer((_req, res) => { res.writeHead(200); res.end(goodBytes) }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionVerify).handler(fakeReq('GET') as never, res as never)
  const body = JSON.parse(String(captured.body))
  assert.equal(body.verified, 'match')
  assert.equal(body.expected.sha256, goodSha)
})
await withServer((_req, res) => { res.writeHead(200); res.end(Buffer.from('other')) }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionVerify).handler(fakeReq('GET') as never, res as never)
  const body = JSON.parse(String(captured.body))
  assert.equal(body.verified, 'mismatch')
})

// 5. info route needs no network and reports the build digest
await withServer((_req, res) => { res.writeHead(500); res.end('must not be called') }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionInfo).handler(fakeReq('GET') as never, res as never)
  const body = JSON.parse(String(captured.body))
  assert.equal(body.version, '0.4.9')
  assert.equal(body.sha256, goodSha)
  assert.equal(body.source, 'server')
})

console.log('ALL PASS extension-routes')

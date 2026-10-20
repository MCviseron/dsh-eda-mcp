import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { makeEdaMcpRoutes, EDA_MCP_API } from '../src/routes.ts'
import { sha256Of } from '../src/bridge/extension-package.ts'

const zipPath = 'dsh-eda-bridge-extension-0.4.9.zip'
const localBytes = readFileSync(zipPath)
const localSha = sha256Of(localBytes)

// Minimal IncomingMessage/ServerResponse doubles: the handlers only use method, socket,
// url, writeHead, end and (for errors) destroy.
function fakeReq(method: string) {
  return { method, url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' } }
}
function fakeRes() {
  const captured: { status?: number; headers?: Record<string, string>; body?: unknown; bytes?: Buffer } = {}
  const res = {
    writeHead(status: number, headers: Record<string, string>) { captured.status = status; captured.headers = headers; return res },
    end(payload?: unknown) { if (Buffer.isBuffer(payload)) captured.bytes = payload; else if (typeof payload === 'string') captured.body = payload; return res },
    destroy() { return res },
    getHeader() { return undefined },
    setHeader() { return res },
  }
  return { res, captured }
}

function deps(base: string) {
  return {
    getConfig: () => ({}),
    extensionZipPath: zipPath,
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

// 1. the zip route stamps the digest it is handing out
{
  const routes = makeEdaMcpRoutes(deps('http://127.0.0.1:1/eda/'))
  const { res, captured } = fakeRes()
  await routeOf(routes, EDA_MCP_API.extensionZip).handler(fakeReq('GET') as never, res as never)
  assert.equal(captured.status, 200)
  assert.equal(captured.headers?.['x-extension-sha256'], localSha, 'digest header must describe the bytes served')
  assert.equal(captured.headers?.['content-length'], String(localBytes.byteLength))
  assert.equal(captured.headers?.['content-disposition']?.includes(zipPath), true, 'versioned file name is kept')
  assert.equal(sha256Of(captured.bytes as Buffer), localSha, 'served bytes are the local zip')
}

// 2. identical remote copy -> match
await withServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(localBytes) }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionVerify).handler(fakeReq('GET') as never, res as never)
  const body = JSON.parse(String(captured.body))
  assert.equal(body.verified, 'match', 'identical bytes verify')
  assert.equal(body.local.sha256, localSha)
  assert.equal(body.remote.sha256, localSha)
})

// 3. different remote copy -> mismatch (never silently equal)
await withServer((_req, res) => { res.writeHead(200); res.end(Buffer.from('different bytes')) }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionVerify).handler(fakeReq('GET') as never, res as never)
  const body = JSON.parse(String(captured.body))
  assert.equal(body.verified, 'mismatch')
})

// 4. throttled remote copy -> unverified + status, not a mismatch
await withServer((_req, res) => { res.writeHead(429, { 'content-type': 'text/plain' }); res.end('slow down') }, async (base) => {
  const { res, captured } = fakeRes()
  await routeOf(makeEdaMcpRoutes(deps(base)), EDA_MCP_API.extensionVerify).handler(fakeReq('GET') as never, res as never)
  const body = JSON.parse(String(captured.body))
  assert.equal(body.verified, 'unverified', '429 is throttling, not a checksum mismatch')
  assert.equal(body.httpStatus, 429)
  assert.equal(String(body.error).includes('429'), true)
})

console.log('ALL PASS extension-routes')

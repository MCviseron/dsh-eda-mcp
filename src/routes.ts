import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SettingsConflictError, type SettingsPathOp } from '@deepseek-ai/dsh-settings'

/**
 * One namespace view as the settings service serializes it. Structural on
 * purpose: 0.1.x `SettingsProvider` and 0.2 `SettingsForms` both return these
 * fields (0.2 adds `autoGenerate`/`applies`), so one build spans generations.
 */
export interface SettingsBridgeView {
  ns: unknown
  schema?: unknown
  value?: unknown
  base?: unknown
  user?: unknown
  revision: number
  secrets?: Array<{ path: readonly string[]; set: boolean }>
}

/** The provider face this loopback bridge uses, on every settings generation. */
export interface SettingsBridge {
  readonly writable?: boolean
  describe: (options?: { redactSecrets?: boolean }) => SettingsBridgeView[]
  mutate: (ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number) => Promise<void>
}
import type { EdaMcpConfig } from './index.ts'
import { isLoopbackRequest } from './loopback.ts'
import { compareDigest, extensionDownloadUrl, sha256Of } from './bridge/extension-package.ts'

export const EDA_MCP_API = {
  test: '/api/dsh-eda-mcp/test',
  reconnect: '/api/dsh-eda-mcp/reconnect',
  extensionZip: '/api/dsh-eda-mcp/extension.zip',
  extensionVerify: '/api/dsh-eda-mcp/extension/verify',
  extensionInfo: '/api/dsh-eda-mcp/extension/info',
  diagnostics: '/api/dsh-eda-mcp/diagnostics',
  selfTest: '/api/dsh-eda-mcp/self-test',
  settingsDescribe: '/api/dsh-eda-mcp/settings/describe',
  settingsMutate: '/api/dsh-eda-mcp/settings/mutate',
} as const

const MAX_BODY_BYTES = 64 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: Parameters<WebRoute['handler']>[0]): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Whether a settings write was refused as stale. Class check plus the stable
 * machine code, because the throwing host may run a different copy of
 * `@deepseek-ai/dsh-settings` than this plugin's own dependency — a cross-copy
 * `instanceof` is false even when both copies are the same version.
 */
function isSettingsConflict(error: unknown): error is SettingsConflictError {
  if (error instanceof SettingsConflictError) return true
  return (error as { code?: unknown } | null)?.code === 'SETTINGS_CONFLICT'
}

function toView(descriptor: SettingsBridgeView): unknown {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    ...(descriptor.secrets === undefined ? {} : { secrets: descriptor.secrets.map(secret => ({ path: [...secret.path], set: secret.set })) }),
    revision: descriptor.revision,
  }
}

export interface EdaMcpRouteDeps {
  getConfig: () => EdaMcpConfig
  extensionDigestPath: string
  /** Wire version of the bundled extension zip (from jlc-extension/extension.json). */
  extensionVersion: string
  /** Base URL of the download server; override with DSH_EDA_EXTENSION_BASE. */
  extensionDownloadBase: string
  /** Dispose and recreate the MCP bridge child, then return immediately. */
  reconnect: () => void
  /** Which executable and script the bridge child is started with (diagnostics). */
  bridgeLaunch?: () => { command: string; args: string[]; source: string }
  /** Live record of the MCP client mount and the bridge health probes. */
  diagnostics?: () => unknown
  /** The exact config handed to the MCP client (a validation failure is visible here). */
  launchConfig?: () => unknown
  /** Spawn the bridge from the plugin host process itself and report what happened. */
  selfTest?: () => Promise<unknown>
}

export function makeEdaMcpRoutes(deps: EdaMcpRouteDeps): WebRoute[] {
  const diagnostics: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.diagnostics,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      json(res, 200, {
        ok: true,
        launch: deps.bridgeLaunch?.() ?? null,
        diagnostics: deps.diagnostics?.() ?? null,
        config: deps.getConfig(),
        launchConfig: deps.launchConfig?.() ?? null,
      })
    },
  }

  const selfTest: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.selfTest,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (deps.selfTest === undefined) return json(res, 501, { ok: false, error: 'not-supported' })
      const result = await deps.selfTest()
      json(res, 200, { ok: true, result })
    },
  }

  const test: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.test,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const port = 39009
      const launch = deps.bridgeLaunch?.()
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) })
        if (!response.ok) return json(res, 502, { ok: false, error: 'bridge-unhealthy', port, launch })
        const health = await response.json() as { status?: string; clients?: number }
        json(res, 200, { ok: true, bridgePort: port, health, launch })
      } catch (error) {
        json(res, 503, {
          ok: false, error: 'bridge-unreachable', port, launch,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }

  const reconnect: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.reconnect,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const port = 39009
      const launch = deps.bridgeLaunch?.()
      try {
        deps.reconnect()
      } catch (error) {
        return json(res, 500, { ok: false, error: 'reconnect-failed', launch, message: error instanceof Error ? error.message : String(error) })
      }
      // Give the freshly spawned bridge child a moment to bind its socket.
      await new Promise(resolve => setTimeout(resolve, 1200))
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) })
        if (!response.ok) return json(res, 502, { ok: false, error: 'bridge-unhealthy', port, launch, message: 'reconnect completed but the bridge health endpoint is not OK' })
        const health = await response.json() as { status?: string; version?: string; clients?: number }
        json(res, 200, { ok: true, bridgePort: port, health, launch, message: 'reconnect completed' })
      } catch (error) {
        json(res, 503, {
          ok: false, error: 'bridge-unreachable', port, launch,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }

  // The package ships no zip any more (only lib/extension-digest.json), so the card downloads
  // from the download server. Every served copy is compared against the build-recorded digest
  // first: a different wire version is refused rather than handed to the user, and a 429 is
  // reported as throttling instead of looking like a broken artifact.
  const readExtensionDigest = async (): Promise<{ version: string; file: string; bytes: number; sha256: string } | null> => {
    try {
      const parsed = JSON.parse(await readFile(deps.extensionDigestPath, 'utf8')) as {
        version?: string; file?: string; bytes?: number; sha256?: string
      }
      if (typeof parsed.version !== 'string' || typeof parsed.sha256 !== 'string' || typeof parsed.file !== 'string') return null
      return { version: parsed.version, file: parsed.file, bytes: Number(parsed.bytes ?? 0), sha256: parsed.sha256 }
    } catch {
      return null
    }
  }

  const extensionZip: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.extensionZip,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const digest = await readExtensionDigest()
      if (digest === null) {
        return json(res, 503, { ok: false, error: 'lib/extension-digest.json is missing; run the build before installing the plugin' })
      }
      const requested = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('source')
      const url = extensionDownloadUrl(deps.extensionDownloadBase, digest.version)
      let response: Response
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      } catch (error) {
        return json(res, 502, {
          ok: false,
          error: 'could not reach the download server: ' + (error instanceof Error ? error.message : String(error)),
          url,
        })
      }
      if (!response.ok) {
        const throttled = response.status === 429
        return json(res, throttled ? 429 : 502, {
          ok: false,
          httpStatus: response.status,
          url,
          error: throttled
            ? 'the download server throttled this IP (5 downloads/min per IP). Wait about a minute and click download again.'
            : 'the download server answered HTTP ' + response.status,
        })
      }
      const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()))
      const servedSha256 = sha256Of(bytes)
      const verdict = compareDigest(digest.sha256, servedSha256)
      if (verdict !== 'match') {
        return json(res, 502, {
          ok: false,
          url,
          verified: verdict,
          expected: { version: digest.version, sha256: digest.sha256, bytes: digest.bytes },
          served: { sha256: servedSha256, bytes: bytes.byteLength },
          error: 'the served zip is not the build this plugin ships (wire version ' + digest.version + '); '
            + 'refusing to hand out a different version. Re-upload ' + digest.file + ' to the download server.',
        })
      }
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="' + digest.file + '"',
        'cache-control': 'no-store',
        'content-length': String(bytes.byteLength),
        'x-extension-source': 'server',
        'x-extension-version': digest.version,
        'x-extension-sha256': servedSha256,
        ...(requested === 'local' ? { 'x-extension-note': 'source=local requested; the served copy was verified and used' } : {}),
      })
      res.end(bytes)
    },
  }

  const extensionInfo: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.extensionInfo,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const digest = await readExtensionDigest()
      if (digest === null) return json(res, 503, { ok: false, error: 'lib/extension-digest.json is missing' })
      json(res, 200, {
        version: digest.version,
        file: digest.file,
        bytes: digest.bytes,
        sha256: digest.sha256,
        downloadPath: EDA_MCP_API.extensionZip,
        serverUrl: extensionDownloadUrl(deps.extensionDownloadBase, digest.version),
        source: 'server',
      })
    },
  }

  const extensionVerify: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.extensionVerify,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const digest = await readExtensionDigest()
      if (digest === null) return json(res, 503, { ok: false, error: 'lib/extension-digest.json is missing' })
      const url = extensionDownloadUrl(deps.extensionDownloadBase, digest.version)
      const report = { version: digest.version, file: digest.file, expected: { bytes: digest.bytes, sha256: digest.sha256 }, url }
      let response: Response
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      } catch (error) {
        return json(res, 200, { ...report, verified: 'unverified', error: 'download failed: ' + (error instanceof Error ? error.message : String(error)) })
      }
      if (!response.ok) {
        return json(res, 200, {
          ...report,
          verified: 'unverified',
          httpStatus: response.status,
          error: response.status === 429
            ? 'the download server throttled this IP (HTTP 429, 5 downloads/min). Wait about a minute and verify again.'
            : 'download failed: HTTP ' + response.status,
        })
      }
      const servedBytes = new Uint8Array(await response.arrayBuffer())
      const servedSha256 = sha256Of(servedBytes)
      return json(res, 200, {
        ...report,
        served: { bytes: servedBytes.byteLength, sha256: servedSha256 },
        verified: compareDigest(digest.sha256, servedSha256),
      })
    },
  }
  return [test, reconnect, extensionZip, extensionInfo, extensionVerify, diagnostics, selfTest]
}

export function makeEdaMcpSettingsRoutes(settings: SettingsBridge): WebRoute[] {
  const ns = 'eda-mcp'
  const view = (): SettingsBridgeView | undefined => {
    const descriptors = settings.describe({ redactSecrets: true })
    return descriptors.find(descriptor => String(descriptor.ns) === 'eda-mcp')
  }

  const describe: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.settingsDescribe,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const descriptor = view()
      json(res, 200, {
        ok: true,
        value: {
          namespaces: descriptor === undefined ? [] : [toView(descriptor)],
          writable: settings.writable !== false,
        },
      })
    },
  }

  const mutate: WebRoute = {
    kind: 'exact',
    path: EDA_MCP_API.settingsMutate,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const body = await readJsonBody(req)
      if (body === undefined || typeof body !== 'object' || body === null) {
        return json(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
      }
      const record = body as { ns?: unknown; ops?: unknown; expectedRevision?: unknown }
      if (record.ns !== 'eda-mcp' || !Array.isArray(record.ops)) {
        return json(res, 400, { ok: false, code: 'settings-rejected', message: 'bad settings mutation' })
      }
      const ops = record.ops as SettingsPathOp[]
      try {
        await settings.mutate(ns, ops, typeof record.expectedRevision === 'number' ? record.expectedRevision : undefined)
        const descriptor = view()
        json(res, 200, { ok: true, value: descriptor === undefined ? undefined : toView(descriptor) })
      } catch (error) {
        if (isSettingsConflict(error)) {
          return json(res, 409, { ok: false, code: error.code, message: error.message, expected: error.expected, actual: error.actual })
        }
        json(res, 400, { ok: false, code: 'settings-rejected', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  return [describe, mutate]
}

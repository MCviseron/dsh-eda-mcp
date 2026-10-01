import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-settings'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { EDA_MCP_GUIDANCE, SECTION_ORDER } from './guidance.ts'
import { makeEdaMcpRoutes, makeEdaMcpSettingsRoutes, type SettingsBridge } from './routes.ts'
import { resolveBridgeRuntime } from './node-runtime.ts'
import { BridgeDiagnostics } from './bridge-diagnostics.ts'
import { unwrapConfig, booleanField, numberField } from './config-values.ts'

/** Settings namespace owned by this plugin (a lowercase hyphenated id since DSH 0.1.5). */
export const EDA_MCP_SETTINGS_NAMESPACE = 'eda-mcp'

export interface EdaMcpConfig {
  enabled?: boolean
  announceToAgent?: boolean
  toolCallTimeoutMs?: number
  allowRawApi?: boolean
}

/**
 * Schema of this plugin's profile entry Config — which IS its settings namespace
 * on DSH >= 0.2, where only fields marked `volatile` become live-editable form
 * fields (every field here is applied without a restart). The marker is inert
 * metadata on the older settings seams.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
  toolCallTimeoutMs: z.number().min(1000).max(300000).default(60000).volatile(),
  allowRawApi: z.boolean().default(true).volatile(),
})

/** Hooks a settings registration hands to the DSH settings seam. */
interface SettingsSectionHooks<T> {
  setSource: (source: () => T) => void
  onChange: () => void
}

/**
 * Unwrap one config field.
 *
 * DSH >= 0.2 hands `volatile` fields over as live value references instead of
 * plain values (see `./config-values.ts`); consuming the handle directly made
 * `toolCallTimeoutMs` a `{}` and turned env values into `"[object Object]"`,
 * which failed the mcp-client's config validation so the bridge was never
 * spawned. Older generations pass plain values, which this leaves untouched.
 */

/** Owner handle of one registered namespace, as both settings generations expose it. */
interface SettingsScopeHandle<T> {
  get: () => T
  watch: (callback: () => void) => () => void
}

/**
 * The provider faces this registration probes at runtime, newest first:
 *
 * - `configure` (DSH >= 0.2 `SettingsForms`): a plugin's settings namespace IS its
 *   profile entry Config, so there is no namespace to register — only the
 *   automatic-page policy is ours to set.
 * - `installSection` (DSH >= 0.1.5): the old free `installSettingsSection` moved
 *   onto the provider.
 * - `register` (<= 0.1.1): what that free function used internally.
 */
interface SettingsProviderFaces<T> {
  configure?: (presentation: { auto?: boolean }) => () => void
  installSection?: (owner: Context, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>) => void
  register?: (ns: string, schema: unknown, options: { base: T }) => SettingsScopeHandle<T>
}

/** Fiber states meaning "this plugin is tearing down" (value mirror of FiberState). */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** Whether the owning plugin's fiber is unloading or already disposed. */
function isUnloading(ctx: Context): boolean {
  const state = (ctx as unknown as { fiber?: { state?: number } }).fiber?.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/**
 * Register this plugin's settings namespace on whichever settings seam the
 * running DSH exposes, so one build serves every generation:
 *
 * - DSH >= 0.2: nothing to register (the entry Config is the namespace); the
 *   automatic settings page is switched off so the shipped card is the only page.
 * - the pre-0.1.5 wiring over `settings.register(ns, schema, { base })`, which is
 *   exactly what the removed free `installSettingsSection` did: point the source
 *   thunk at the resolved scope, fall back to the composition entry when the
 *   scope detaches, and re-run `onChange` on every committed change.
 *
 * @param ctx - the plugin context owning the section (its unload releases it).
 * @param scoped - the settings-service context the registration rides.
 * @param ns - this plugin's settings namespace id.
 * @param schema - schemastery schema resolving the namespace value.
 * @param entry - composition entry used as the base layer and fallback value.
 * @param hooks - source sink and change notification.
 */
function installSettingsSection<T>(ctx: Context, scoped: Context, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>): void {
  const provider = scoped.settings as unknown as SettingsProviderFaces<T>
  if (typeof provider.configure === 'function') {
    // DSH >= 0.2: the entry Config in the profile patch is this plugin's settings
    // namespace and the Loader re-applies the plugin on every committed change, so
    // the apply() argument is authoritative — nothing to register. Suppress the
    // auto-generated page because this plugin ships its own settings card.
    ctx.effect(() => provider.configure!({ auto: false }), 'dsh-eda-mcp: settings page policy')
    hooks.onChange()
    return
  }
  if (typeof provider.installSection === 'function') {
    provider.installSection(ctx, ns, schema, entry, hooks)
    return
  }
  if (typeof provider.register === 'function') {
    const scope = provider.register(ns, schema, { base: entry })
    hooks.setSource(() => scope.get())
    scoped.effect(() => () => {
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
    return
  }
  throw new TypeError('dsh-eda-mcp: the running dsh settings service exposes none of configure (>= 0.2), installSection (>= 0.1.5), register (<= 0.1.1)')
}

export const inject = ['webServer', 'systemPrompt']

const BRIDGE_URL = new URL('../lib/bridge.mjs', import.meta.url)
const EXTENSION_ZIP_URL = new URL('../dsh-eda-bridge-extension.zip', import.meta.url)

/** Bridge script path, resolved once. */
const BRIDGE_PATH = fileURLToPath(BRIDGE_URL)

/**
 * Launch description of the bridge child: the executable that can actually run
 * `lib/bridge.mjs` (see `resolveBridgeRuntime`) plus this plugin's settings.
 *
 * `failOnStartupError: true` makes a failed initial connection reject the client
 * fiber instead of only logging to the host logger — the desktop app writes no
 * host log to disk, so a silent failure there is invisible. The bridge is this
 * plugin's own script, so a startup failure is always a real fault worth raising.
 */
function bridgeLaunchFor(active: EdaMcpConfig) {
  const runtime = resolveBridgeRuntime()
  // The typed accessors resolve a live reference if one is still present and fall
  // back to the schema default otherwise, so a stale wrapper can never produce a
  // client config that fails validation.
  const allowRawApi = booleanField(active.allowRawApi, true)
  const toolCallTimeoutMs = numberField(active.toolCallTimeoutMs, 60000)
  return {
    transport: 'stdio' as const,
    serverName: 'jlceda',
    command: runtime.command,
    args: [BRIDGE_PATH],
    env: {
      ...runtime.extraEnv,
      DSH_EDA_MCP_ALLOW_RAW_API: allowRawApi ? '1' : '0',
      DSH_EDA_MCP_TOOL_TIMEOUT_MS: String(toolCallTimeoutMs),
    },
    cwd: dirname(BRIDGE_PATH),
    toolCallTimeoutMs,
    failOnStartupError: true,
    reconnect: {
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30000,
      maxAttempts: 10,
    },
  }
}

/** Diagnostics for the routes: which executable the bridge child is started with. */
function describeBridgeLaunch(): { command: string; args: string[]; source: string } {
  const runtime = resolveBridgeRuntime()
  return { command: runtime.command, args: [BRIDGE_PATH], source: runtime.source }
}

export function apply(ctx: Context, config?: EdaMcpConfig): void {
  // Config values always reach the rest of the plugin unwrapped: on DSH >= 0.2
  // `volatile` fields arrive as live value handles.
  let current: () => EdaMcpConfig = () => unwrapConfig(config ?? {})
  let disposeClient: (() => Promise<void>) | undefined
  let disposeSection: (() => void) | undefined
  let mounting: Promise<void> = Promise.resolve()
  let syncedBySettings = false
  const diagnostics = new BridgeDiagnostics()

  /** Poll the bridge for a while so the diagnostics record reflects reality. */
  const refreshBridgeHealth = (): void => {
    void (async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (await diagnostics.probe() === 'ok') return
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    })()
  }

  const remountClient = (): void => {
    // Mounts are serialized and awaited: the 0.2 mcp-client reserves its
    // `serverName` for as long as its fiber lives and rejects a second mount of
    // the same name with "already in use", so a remount must not start before the
    // previous fiber finished disposing. `sync()` can run twice at startup.
    mounting = mounting.then(async () => {
      if (disposeClient !== undefined) {
        const dispose = disposeClient
        disposeClient = undefined
        await dispose()
      }
      const active = current()
      if (!(active.enabled ?? true)) return
      diagnostics.beginMount()
      try {
        // `@deepseek-ai/dsh-mcp-client` declares `inject: ['tools']` on DSH >= 0.2, so
        // it only applies where the tool registry is reachable. Injecting here
        // waits for that service and records whether it ever appeared.
        const fiber = ctx.inject(['tools'], (toolsCtx) => {
          diagnostics.recordToolsServiceSeen()
          try {
            const client = toolsCtx.plugin(mcpClient, bridgeLaunchFor(active))
            diagnostics.observeClientFiber(client)
            refreshBridgeHealth()
          } catch (error) {
            diagnostics.recordError(error)
          }
        })
        disposeClient = async () => { await fiber.dispose() }
      } catch (error) {
        diagnostics.recordError(error)
      }
    }).catch((error: unknown) => {
      diagnostics.recordError(error)
    })
  }

  ctx.effect(() => {
    const disposers = makeEdaMcpRoutes({
      getConfig: () => current(),
      extensionZipPath: fileURLToPath(EXTENSION_ZIP_URL),
      reconnect: remountClient,
      bridgeLaunch: describeBridgeLaunch,
      diagnostics: () => diagnostics.liveSnapshot(),
      launchConfig: () => bridgeLaunchFor(current()),
      selfTest: async () => {
        const runtime = resolveBridgeRuntime()
        return await diagnostics.selfTest(runtime.command, [BRIDGE_PATH])
      },
    }).map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'eda-mcp: host routes')

  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => {
      const disposers = makeEdaMcpSettingsRoutes(sctx.settings as unknown as SettingsBridge).map(route => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'eda-mcp: settings bridge')
  })

  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const active = current()
    remountClient()
    if (booleanField(active.enabled, true) && booleanField(active.announceToAgent, true)) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:eda-mcp',
        order: SECTION_ORDER,
        text: EDA_MCP_GUIDANCE,
      })
    }
  }

  ctx.inject(['settings'], (sctx) => {
    installSettingsSection(ctx, sctx, EDA_MCP_SETTINGS_NAMESPACE, Config, unwrapConfig(config ?? {}), {
      setSource: (source) => { current = () => unwrapConfig(source()) },
      onChange: () => { syncedBySettings = true; sync() },
    })
  })

  // The settings seam may already have synced (0.2 calls back synchronously from
  // `configure`), and a redundant remount races the previous fiber's disposal.
  if (!syncedBySettings) sync()
}

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { EdaMcpSettingsCard, EdaMcpSettingsCardController, type EdaMcpSettings } from './EdaMcpSettingsCard.tsx'
import { createEdaMcpSettingsScope } from './settings-scope.ts'
import { en, zh, type EdaMcpKey } from './locales.ts'

const NS = 'eda-mcp'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'eda-mcp': EdaMcpKey
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'eda-mcp: dictionaries')

  const settingsScope = createEdaMcpSettingsScope<EdaMcpSettings>()
  const controller = new EdaMcpSettingsCardController(settingsScope)

  ctx.slots.inject('settings.section', () => {
    const unregister = ctx.slots.register({
      name: 'settings.section',
      id: 'eda-mcp',
      order: 40,
      label: () => ctx.locale.bind(NS)('settings.title'),
      locale: NS,
      inject: () => controller.inject(),
    }, EdaMcpSettingsCard)
    return () => {
      controller.dispose()
      unregister()
    }
  })
}

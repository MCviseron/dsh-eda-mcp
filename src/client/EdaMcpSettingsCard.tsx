import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EdaMcpKey } from './locales.ts'
import type { SettingsScope } from './settings-scope.ts'

export interface EdaMcpSettings {
  enabled?: boolean
  announceToAgent?: boolean
  toolCallTimeoutMs?: number
  allowRawApi?: boolean
}

export interface EdaMcpSettingsCardState {
  status: 'loading' | 'ready' | 'unavailable'
  config?: EdaMcpSettings
  writable: boolean
}

export interface EdaMcpSettingsCardFace {
  hooks: {
    edaMcpSettingsCard: SnapshotStore<EdaMcpSettingsCardState>
  }
  save(draft: EdaMcpSettings): Promise<void>
  resetAll(): Promise<void>
  testConnection(): Promise<void>
  reconnect(): Promise<void>
}

export class EdaMcpSettingsCardController {
  private readonly store = createSnapshotStore<EdaMcpSettingsCardState>({ status: 'loading', writable: false })
  private readonly disposeScope: () => void

  constructor(private readonly scope: SettingsScope<EdaMcpSettings>) {
    this.disposeScope = scope.subscribe(() => { this.sync() })
    this.sync()
  }

  private sync(): void {
    const snapshot = this.scope.getSnapshot()
    this.store.set({
      status: snapshot.status,
      config: snapshot.value,
      writable: snapshot.writable,
    })
  }

  inject(): EdaMcpSettingsCardFace {
    return {
      hooks: { edaMcpSettingsCard: this.store },
      save: async (draft) => { await this.save(draft) },
      resetAll: async () => { await this.resetAll() },
      testConnection: async () => { await this.testConnection() },
      reconnect: async () => { await this.reconnect() },
    }
  }

  dispose(): void {
    this.disposeScope()
  }

  private async save(draft: EdaMcpSettings): Promise<void> {
    for (const [field, value] of Object.entries(draft)) {
      if (value === undefined || value === null || value === '') {
        await this.scope.unset(field)
      } else {
        await this.scope.set(field, value)
      }
    }
  }

  private async resetAll(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const user = snapshot.user as Record<string, unknown> | undefined
    if (user === undefined) return
    for (const field of Object.keys(user)) {
      await this.scope.unset(field)
    }
  }

  private async testConnection(): Promise<void> {
    const response = await fetch('/api/dsh-eda-mcp/test', { method: 'POST' })
    let body: { ok?: boolean; error?: string; message?: string; health?: { status?: string; clients?: number } } | undefined
    try {
      body = await response.json() as { ok?: boolean; error?: string; message?: string; health?: { status?: string; clients?: number } }
    } catch {
      body = undefined
    }
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error ?? body?.message ?? `HTTP ${response.status}`)
    }
  }

  private async reconnect(): Promise<void> {
    const response = await fetch('/api/dsh-eda-mcp/reconnect', { method: 'POST' })
    let body: { ok?: boolean; error?: string; message?: string } | undefined
    try {
      body = await response.json() as { ok?: boolean; error?: string; message?: string }
    } catch {
      body = undefined
    }
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error ?? body?.message ?? `HTTP ${response.status}`)
    }
  }
}

export type EdaMcpSettingsCardProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'eda-mcp'>
  & InjectFace<EdaMcpSettingsCardFace>

const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-3)',
  borderRadius: 12,
  color: 'var(--dsw-alias-label-primary)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '14px 16px',
}

const titleStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
}

const descriptionStyle: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 13,
  lineHeight: 1.5,
}

const bodyStyle: CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  padding: '8px 0 12px',
}

const footerStyle: CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  margin: '0 16px',
  padding: '12px 0 16px',
}

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 0',
}

const labelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.5,
}

const hintStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: 1.5,
}

const inputStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 8,
  padding: '0 12px',
  height: 34,
  fontSize: 13,
  lineHeight: 1.5,
  width: '100%',
  boxSizing: 'border-box',
  font: 'inherit',
}

const buttonBaseStyle: CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  cursor: 'pointer',
  border: '1px solid transparent',
  borderRadius: 8,
  padding: '6px 16px',
  fontSize: 13,
  lineHeight: 1.5,
}

const primaryButtonStyle: CSSProperties = {
  ...buttonBaseStyle,
  background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
}

const secondaryButtonStyle: CSSProperties = {
  ...buttonBaseStyle,
  borderColor: 'var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
}

const disabledButtonStyle: CSSProperties = {
  opacity: 0.4,
  cursor: 'default',
}

interface FieldProps {
  label: string
  hint: string
  children: ReactNode
}

function Field(props: FieldProps) {
  return (
    <div style={fieldStyle}>
      <span style={labelStyle}>{props.label}</span>
      {props.children}
      <span style={hintStyle}>{props.hint}</span>
    </div>
  )
}

interface NumberFieldProps {
  label: string
  hint: string
  value: number | undefined
  disabled?: boolean
  onChange: (value: number | undefined) => void
}

function NumberField(props: NumberFieldProps) {
  return (
    <Field label={props.label} hint={props.hint}>
      <input
        type="number"
        value={props.value ?? ''}
        disabled={props.disabled}
        onChange={(event) => {
          const text = event.target.value.trim()
          if (text === '') {
            props.onChange(undefined)
            return
          }
          const parsed = Number(text)
          props.onChange(Number.isFinite(parsed) ? parsed : undefined)
        }}
        style={inputStyle}
      />
    </Field>
  )
}

interface BooleanFieldProps {
  label: string
  hint: string
  value: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}

function BooleanField(props: BooleanFieldProps) {
  const on = props.value
  return (
    <Field label={props.label} hint={props.hint}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => { props.onChange(!on) }}
        style={{
          position: 'relative',
          flex: '0 0 auto',
          width: 40,
          height: 22,
          padding: 0,
          border: 'none',
          borderRadius: 11,
          background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
          cursor: props.disabled === true ? 'not-allowed' : 'pointer',
          opacity: props.disabled === true ? 0.4 : 1,
          transition: 'background 140ms ease',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'var(--dsw-alias-bg-layer-3, #fff)',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
            transition: 'left 140ms ease',
          }}
        />
      </button>
    </Field>
  )
}

export function EdaMcpSettingsCard(props: EdaMcpSettingsCardProps) {
  const { t } = props
  const state = props.useEdaMcpSettingsCard(snapshot => snapshot)
  const [draft, setDraft] = useState<EdaMcpSettings>({})
  const [seeded, setSeeded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>()

  useEffect(() => {
    if (!seeded && state.status === 'ready') {
      setDraft(state.config ?? {})
      setSeeded(true)
    }
  }, [seeded, state.status, state.config])

  if (state.status === 'loading') return null

  const disabled = !state.writable || saving || testing || reconnecting
  const update = (field: keyof EdaMcpSettings, value: unknown): void => {
    setDraft(current => ({ ...current, [field]: value }))
  }
  const clearNotice = (): void => { setNotice(undefined) }

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setNotice(undefined)
    try {
      await props.save(draft)
      setNotice({ kind: 'ok', text: t('settings.saved') })
    } catch (error) {
      setNotice({ kind: 'error', text: t('settings.saveFailed') + ': ' + (error instanceof Error ? error.message : String(error)) })
    } finally {
      setSaving(false)
    }
  }

  const onReset = async (): Promise<void> => {
    setSaving(true)
    setNotice(undefined)
    try {
      await props.resetAll()
      setDraft(state.config ?? {})
      setNotice({ kind: 'ok', text: t('settings.saved') })
    } catch (error) {
      setNotice({ kind: 'error', text: t('settings.saveFailed') + ': ' + (error instanceof Error ? error.message : String(error)) })
    } finally {
      setSaving(false)
    }
  }

  const onTest = async (): Promise<void> => {
    setTesting(true)
    setNotice(undefined)
    try {
      await props.save(draft)
      await props.testConnection()
      setNotice({ kind: 'ok', text: t('settings.testOk') })
    } catch (error) {
      setNotice({ kind: 'error', text: t('settings.testFailed') + ': ' + (error instanceof Error ? error.message : String(error)) })
    } finally {
      setTesting(false)
    }
  }

  const onReconnect = async (): Promise<void> => {
    setReconnecting(true)
    setNotice(undefined)
    try {
      await props.save(draft)
      await props.reconnect()
      setNotice({ kind: 'ok', text: t('settings.reconnectOk') })
    } catch (error) {
      setNotice({ kind: 'error', text: t('settings.reconnectFailed') + ': ' + (error instanceof Error ? error.message : String(error)) })
    } finally {
      setReconnecting(false)
    }
  }

  const noticeStyle: CSSProperties = {
    margin: '8px 0 0',
    fontSize: 12,
    lineHeight: 1.5,
    color: notice?.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-error)',
  }

  return (
    <div style={cardStyle}>
      <header style={headerStyle}>
        <div>
          <h3 style={titleStyle}>{t('settings.title')}</h3>
          <p style={descriptionStyle}>{t('settings.description')}</p>
        </div>
      </header>

      <div style={bodyStyle}>
        <BooleanField
          label={t('settings.enabled')}
          hint={t('settings.enabledHint')}
          value={draft.enabled ?? true}
          disabled={disabled}
          onChange={(value) => { clearNotice(); update('enabled', value) }}
        />
        <BooleanField
          label={t('settings.announceToAgent')}
          hint={t('settings.announceToAgentHint')}
          value={draft.announceToAgent ?? true}
          disabled={disabled}
          onChange={(value) => { clearNotice(); update('announceToAgent', value) }}
        />
        <NumberField
          label={t('settings.toolCallTimeoutMs')}
          hint={t('settings.toolCallTimeoutMsHint')}
          value={draft.toolCallTimeoutMs}
          disabled={disabled}
          onChange={(value) => { clearNotice(); update('toolCallTimeoutMs', value) }}
        />
        <BooleanField
          label={t('settings.allowRawApi')}
          hint={t('settings.allowRawApiHint')}
          value={draft.allowRawApi ?? true}
          disabled={disabled}
          onChange={(value) => { clearNotice(); update('allowRawApi', value) }}
        />

        <p style={{ ...hintStyle, margin: '8px 0 0' }}>{t('settings.portLabel')}</p>

        <Field label={t('settings.downloadExtension')} hint={t('settings.installHint')}>
          <a
            href="/api/dsh-eda-mcp/extension.zip"
            download="dsh-eda-bridge-extension.zip"
            style={{ ...secondaryButtonStyle, textDecoration: 'none', display: 'inline-flex', width: 'fit-content' }}
          >
            {t('settings.downloadExtension')}
          </a>
        </Field>
      </div>

      <footer style={footerStyle}>
        {notice !== undefined
          ? <p style={noticeStyle} role="status">{notice.text}</p>
          : null}
        <button
          type="button"
          disabled={disabled}
          style={disabled ? { ...primaryButtonStyle, ...disabledButtonStyle } : primaryButtonStyle}
          onClick={() => { void onSave() }}
        >
          {t(saving ? 'settings.saving' : 'settings.save')}
        </button>
        <button
          type="button"
          disabled={disabled}
          style={disabled ? { ...secondaryButtonStyle, ...disabledButtonStyle } : secondaryButtonStyle}
          onClick={() => { void onReset() }}
        >
          {t('settings.resetAll')}
        </button>
        <button
          type="button"
          disabled={disabled}
          style={disabled ? { ...secondaryButtonStyle, ...disabledButtonStyle } : secondaryButtonStyle}
          onClick={() => { void onTest() }}
        >
          {t(testing ? 'settings.testingConnection' : 'settings.testConnection')}
        </button>
        <button
          type="button"
          disabled={disabled}
          style={disabled ? { ...secondaryButtonStyle, ...disabledButtonStyle } : secondaryButtonStyle}
          onClick={() => { void onReconnect() }}
        >
          {t(reconnecting ? 'settings.reconnecting' : 'settings.reconnect')}
        </button>
      </footer>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { t } from '../../shared/i18n'
import type { ReactElement } from 'react'
import {
  DEFAULT_PORTS,
  PROTOCOLS,
  protocolLabel,
  type AuthMode,
  type Protocol,
  type SiteConfig,
  type SiteSummary
} from '@shared/types'

export interface SiteDraft {
  id?: string
  name: string
  protocol: Protocol
  host: string
  port: number
  authMode: AuthMode
  user: string
  password: string
  privateKeyPath: string
  passphrase: string
  remoteDir: string
  localDir: string
  sshPort: number
  rejectUnauthorized: boolean
  savePassword: boolean
}

interface SiteDialogProps {
  site: SiteSummary | null
  encryptionAvailable: boolean
  onCancel: () => void
  onSave: (draft: SiteDraft) => Promise<void>
  onSaveAndConnect: (draft: SiteDraft) => Promise<void>
}

function draftFrom(site: SiteSummary | null): SiteDraft {
  if (!site) {
    return {
      name: '',
      protocol: 'sftp',
      host: '',
      port: DEFAULT_PORTS.sftp,
      authMode: 'password',
      user: '',
      password: '',
      privateKeyPath: '',
      passphrase: '',
      remoteDir: '',
      localDir: '',
      sshPort: 22,
      rejectUnauthorized: true,
      savePassword: true
    }
  }
  return {
    id: site.id,
    name: site.name,
    protocol: site.protocol,
    host: site.host,
    port: site.port,
    authMode: site.authMode,
    user: site.user,
    password: '',
    privateKeyPath: site.privateKeyPath ?? '',
    passphrase: '',
    remoteDir: site.remoteDir ?? '',
    localDir: site.localDir ?? '',
    sshPort: site.sshPort ?? (site.protocol === 'sftp' ? site.port : 22),
    rejectUnauthorized: site.rejectUnauthorized,
    savePassword: site.hasStoredPassword || site.hasStoredPassphrase
  }
}

export function SiteDialog(props: SiteDialogProps): ReactElement {
  const { site, encryptionAvailable, onCancel, onSave, onSaveAndConnect } = props
  const [draft, setDraft] = useState<SiteDraft>(() => draftFrom(site))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Tracks whether the port still matches the protocol default, so switching
  // protocol updates it — but a hand-typed port is never clobbered.
  const [portTouched, setPortTouched] = useState(Boolean(site))

  useEffect(() => {
    setDraft(draftFrom(site))
    setPortTouched(Boolean(site))
  }, [site])

  const patch = (values: Partial<SiteDraft>): void => setDraft((d) => ({ ...d, ...values }))

  const setProtocol = (protocol: Protocol): void => {
    patch({
      protocol,
      port: portTouched ? draft.port : DEFAULT_PORTS[protocol],
      authMode: protocol === 'sftp' ? draft.authMode : draft.authMode === 'key' ? 'password' : draft.authMode
    })
  }

  const isSftp = draft.protocol === 'sftp'
  const isFtps = draft.protocol === 'ftps' || draft.protocol === 'ftps-implicit'
  const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535
  const valid =
    draft.host.trim().length > 0 &&
    validPort(draft.port) &&
    validPort(draft.sshPort)

  const submit = async (connect: boolean): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      if (connect) await onSaveAndConnect(draft)
      else await onSave(draft)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pickKey = async (): Promise<void> => {
    const chosen = await window.kreos.dialog.privateKey()
    if (chosen) patch({ privateKeyPath: chosen })
  }

  const pickLocalDir = async (): Promise<void> => {
    const chosen = await window.kreos.dialog.directory(t('Стартовая локальная папка'), draft.localDir || undefined)
    if (chosen) patch({ localDir: chosen })
  }

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label={t('Параметры подключения')}>
        <div className="modal__head">
          <h2 className="modal__title">{site ? t('Изменить подключение') : t('Новое подключение')}</h2>
          <p className="modal__sub">
            
            {t('Пароли шифруются средствами ОС и хранятся только на этом компьютере.')}
          </p>
        </div>

        <div className="modal__body">
          {!encryptionAvailable && (
            <div className="notice notice--warn">
              
              {t('Системное хранилище секретов недоступно, поэтому пароль сохранён не будет — его\n              придётся вводить при каждом подключении.')}
            </div>
          )}

          <div className="field">
            <label className="field__label" htmlFor="site-name">
              
              {t('Название')}
            </label>
            <input
              id="site-name"
              className="input"
              value={draft.name}
              placeholder={draft.host || t('Мой сервер')}
              onChange={(e) => patch({ name: e.target.value })}
              autoFocus
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="site-protocol">
              
              {t('Протокол')}
            </label>
            <select
              id="site-protocol"
              className="select"
              value={draft.protocol}
              onChange={(e) => setProtocol(e.target.value as Protocol)}
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {protocolLabel(p)}
                </option>
              ))}
            </select>
            {draft.protocol === 'ftp' && (
              <span className="field__hint">
                
                {t('Обычный FTP передаёт пароль и данные открытым текстом. По возможности выбирайте\n                SFTP или FTPS.')}
              </span>
            )}
          </div>

          <div className="grid-host">
            <div className="field">
              <label className="field__label" htmlFor="site-host">
                
                {t('Хост')}
              </label>
              <input
                id="site-host"
                className="input input--mono"
                value={draft.host}
                placeholder="ftp.example.com"
                spellCheck={false}
                onChange={(e) => patch({ host: e.target.value.trim() })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="site-port">
                
                {t('Порт')}
              </label>
              <input
                id="site-port"
                className="input input--mono"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) => {
                  setPortTouched(true)
                  patch({ port: Number(e.target.value) || 0 })
                }}
              />
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="site-auth">
              
              {t('Аутентификация')}
            </label>
            <select
              id="site-auth"
              className="select"
              value={draft.authMode}
              onChange={(e) => patch({ authMode: e.target.value as AuthMode })}
            >
              <option value="password">{t('Пароль')}</option>
              {isSftp && <option value="key">{t('Приватный ключ')}</option>}
              {isSftp && <option value="agent">{t('SSH-агент (Pageant / ssh-agent)')}</option>}
              {!isSftp && <option value="anonymous">{t('Анонимно')}</option>}
            </select>
          </div>

          {draft.authMode !== 'anonymous' && (
            <div className="grid-2">
              <div className="field">
                <label className="field__label" htmlFor="site-user">
                  
                  {t('Пользователь')}
                </label>
                <input
                  id="site-user"
                  className="input input--mono"
                  value={draft.user}
                  spellCheck={false}
                  onChange={(e) => patch({ user: e.target.value.trim() })}
                />
              </div>
              {draft.authMode === 'password' && (
                <div className="field">
                  <label className="field__label" htmlFor="site-password">
                    
                    {t('Пароль')}
                  </label>
                  <input
                    id="site-password"
                    className="input"
                    type="password"
                    value={draft.password}
                    placeholder={site?.hasStoredPassword ? t('•••••••• (сохранён)') : ''}
                    onChange={(e) => patch({ password: e.target.value })}
                  />
                </div>
              )}
            </div>
          )}

          {draft.authMode === 'key' && (
            <>
              <div className="field">
                <label className="field__label" htmlFor="site-key">
                  
                  {t('Приватный ключ')}
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    id="site-key"
                    className="input input--mono"
                    value={draft.privateKeyPath}
                    spellCheck={false}
                    placeholder="C:\Users\…\.ssh\id_ed25519"
                    onChange={(e) => patch({ privateKeyPath: e.target.value })}
                  />
                  <button className="btn" onClick={pickKey} type="button">
                    
                    {t('Обзор…')}
                  </button>
                </div>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="site-passphrase">
                  
                  {t('Пароль ключа')}
                </label>
                <input
                  id="site-passphrase"
                  className="input"
                  type="password"
                  value={draft.passphrase}
                  placeholder={site?.hasStoredPassphrase ? t('•••••••• (сохранён)') : t('если ключ без пароля — оставьте пустым')}
                  onChange={(e) => patch({ passphrase: e.target.value })}
                />
              </div>
            </>
          )}

          {(draft.authMode === 'password' || draft.authMode === 'key') && encryptionAvailable && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.savePassword}
                onChange={(e) => patch({ savePassword: e.target.checked })}
              />
              <span>{t('Запомнить пароль')}</span>
            </label>
          )}

          <div className="grid-2">
            <div className="field">
              <label className="field__label" htmlFor="site-remote">
                
                {t('Каталог на сервере')}
              </label>
              <input
                id="site-remote"
                className="input input--mono"
                value={draft.remoteDir}
                spellCheck={false}
                placeholder={t('по умолчанию')}
                onChange={(e) => patch({ remoteDir: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="site-local">
                
                {t('Локальный каталог')}
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  id="site-local"
                  className="input input--mono"
                  value={draft.localDir}
                  spellCheck={false}
                  placeholder={t('по умолчанию')}
                  onChange={(e) => patch({ localDir: e.target.value })}
                />
                <button className="btn" onClick={pickLocalDir} type="button">
                  …
                </button>
              </div>
            </div>
          </div>

          {!isSftp && (
            <div className="field" style={{ maxWidth: 180 }}>
              <label className="field__label" htmlFor="site-ssh-port">
                
                {t('Порт SSH')}
              </label>
              <input
                id="site-ssh-port"
                className="input input--mono"
                type="number"
                min={1}
                max={65535}
                value={draft.sshPort}
                onChange={(e) => patch({ sshPort: Number(e.target.value) })}
              />
            </div>
          )}

          {isFtps && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!draft.rejectUnauthorized}
                onChange={(e) => patch({ rejectUnauthorized: !e.target.checked })}
              />
              <span>{t('Принимать самоподписанные сертификаты')}</span>
            </label>
          )}

          {site?.hostKeyFingerprint && (
            <div className="notice">
              
              {t('Закреплённый ключ хоста:')} <code>{site.hostKeyFingerprint}</code>
            </div>
          )}

          {error && <div className="notice notice--danger">{error}</div>}
        </div>

        <div className="modal__foot">
          <span className="modal__foot-spacer" />
          <button className="btn" onClick={onCancel} disabled={busy}>
            
            {t('Отмена')}
          </button>
          <button className="btn" onClick={() => void submit(false)} disabled={!valid || busy}>
            
            {t('Сохранить')}
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void submit(true)}
            disabled={!valid || busy}
          >
            {busy ? t('Подключение…') : t('Подключиться')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Maps the dialog's form state onto the persisted shape. */
export function draftToSite(draft: SiteDraft): Partial<SiteConfig> & { name: string; host: string } {
  return {
    id: draft.id,
    name: draft.name.trim() || draft.host,
    protocol: draft.protocol,
    host: draft.host,
    port: draft.port,
    authMode: draft.authMode,
    user: draft.user,
    password: draft.savePassword ? draft.password || undefined : undefined,
    passphrase: draft.savePassword ? draft.passphrase || undefined : undefined,
    privateKeyPath: draft.privateKeyPath || undefined,
    remoteDir: draft.remoteDir || undefined,
    localDir: draft.localDir || undefined,
    sshPort: draft.sshPort,
    rejectUnauthorized: draft.rejectUnauthorized
  }
}

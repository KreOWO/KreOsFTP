import { useEffect, useRef, useState } from 'react'
import { LANGUAGES, LANGUAGE_NAMES, t , type Language } from '../../shared/i18n'
import type { ReactElement, ReactNode } from 'react'
import type { AppSettings, ConflictAction, ConflictPolicy, ConflictRequest } from '@shared/types'
import { formatDate, formatSize } from '../format'

/* -------------------------------------------------------------------------- */

interface PromptProps {
  title: string
  subtitle?: string
  label: string
  initialValue?: string
  confirmLabel?: string
  password?: boolean
  extra?: ReactNode
  onCancel: () => void
  onSubmit: (value: string) => void | Promise<void>
}

/** One-line input modal — new folder, rename, and the connect password prompt. */
export function PromptDialog(props: PromptProps): ReactElement {
  const {
    title,
    subtitle,
    label,
    initialValue = '',
    confirmLabel = t('ОК'),
    password,
    extra,
    onCancel,
    onSubmit
  } = props
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    // Preselect the stem so renaming `archive.tar.gz` does not fight the extension.
    const dot = value.lastIndexOf('.')
    if (!password && dot > 0) input.setSelectionRange(0, dot)
    else input.select()
    // Selection is set once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width: 'min(440px, 100%)' }}>
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          {subtitle && <p className="modal__sub">{subtitle}</p>}
        </div>
        <div className="modal__body">
          <div className="field">
            <label className="field__label" htmlFor="prompt-input">
              {label}
            </label>
            <input
              id="prompt-input"
              ref={inputRef}
              className={'input' + (password ? '' : ' input--mono')}
              type={password ? 'password' : 'text'}
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
                if (e.key === 'Escape') onCancel()
              }}
            />
          </div>
          {extra}
          {error && <div className="notice notice--danger">{error}</div>}
        </div>
        <div className="modal__foot">
          <span className="modal__foot-spacer" />
          <button className="btn" onClick={onCancel} disabled={busy}>
            
            {t('Отмена')}
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={busy || value.trim() === ''}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface SyncConfirmProps {
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  onCancel: () => void
  onConfirm: () => void
}

/** In-app confirmation for the potentially destructive version replacement. */
export function SyncConfirmDialog(props: SyncConfirmProps): ReactElement {
  const { direction, localPath, remotePath, onCancel, onConfirm } = props
  const toServer = direction === 'upload'
  const title = toServer ? t('Обновить сервер?') : t('Обновить локальную папку?')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, onConfirm])

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="modal modal--sync-confirm" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <p className="modal__sub">
            {toServer
              ? t('Локальная версия заменит отличающиеся файлы на сервере.')
              : t('Серверная версия заменит отличающиеся локальные файлы.')}
          </p>
        </div>
        <div className="modal__body">
          <dl className="diff-table">
            <dt>{t('Источник')}</dt>
            <dd>{toServer ? localPath : remotePath}</dd>
            <dt>{t('Назначение')}</dt>
            <dd>{toServer ? remotePath : localPath}</dd>
            <dt>{t('Правила')}</dt>
            <dd>{toServer ? t('Локальный .ftpignore') : t('Серверный .ftpignore')}</dd>
          </dl>
          <div className="notice">
            
            {t('Сравнение выполняется по наличию, типу и размеру. Лишние файлы в назначении не удаляются.')}
          </div>
        </div>
        <div className="modal__foot">
          <button className="btn" type="button" onClick={onCancel}>
            
            {t('Отмена')}
          </button>
          <span className="modal__foot-spacer" />
          <button className="btn btn--primary" type="button" autoFocus onClick={onConfirm}>
            {toServer ? t('Обновить сервер') : t('Обновить локально')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface ConflictProps {
  request: ConflictRequest
  onResolve: (action: ConflictAction, applyToAll: boolean, rule?: ConflictPolicy) => void
}

/** Правила, осмысленные как ответ «а дальше решай сам». */
const REST_RULES: ConflictPolicy[] = ['size-differs', 'newer', 'size-or-newer']

export function ConflictDialog({ request, onResolve }: ConflictProps): ReactElement {
  const [applyToAll, setApplyToAll] = useState(false)
  const [rule, setRule] = useState<ConflictPolicy | undefined>(undefined)
  const canResume = request.sourceSize > request.targetSize && request.targetSize > 0

  return (
    <div className="scrim">
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('Файл уже существует')}>
        <div className="modal__head">
          <h2 className="modal__title">{t('Файл уже существует')}</h2>
          <p className="modal__sub">
            {request.direction === 'upload'
              ? t('На сервере уже есть {0}.', request.name)
              : t('Локально уже есть {0}.', request.name)}
          </p>
        </div>
        <div className="modal__body">
          <dl className="diff-table">
            <dt>{t('Путь')}</dt>
            <dd>{request.targetPath}</dd>
            <dt>{t('Источник')}</dt>
            <dd>
              {formatSize(request.sourceSize)}
              {request.sourceModifiedAt ? ` · ${formatDate(request.sourceModifiedAt)}` : ''}
            </dd>
            <dt>{t('Приёмник')}</dt>
            <dd>
              {formatSize(request.targetSize)}
              {request.targetModifiedAt ? ` · ${formatDate(request.targetModifiedAt)}` : ''}
            </dd>
          </dl>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            <span>{t('Применить ко всем оставшимся файлам')}</span>
          </label>

          {/* Те же правила, что и в настройках, но под рукой в момент передачи:
              иначе за ними пришлось бы уходить из диалога. */}
          {applyToAll && (
            <div className="field" style={{ marginTop: 10 }}>
              <label className="field__label" htmlFor="conflict-rule">
                {t('Правило для остальных')}
              </label>
              <select
                id="conflict-rule"
                className="select"
                value={rule ?? ''}
                onChange={(e) =>
                  setRule(e.target.value ? (e.target.value as ConflictPolicy) : undefined)
                }
              >
                <option value="">{t('То же действие')}</option>
                {REST_RULES.map((p) => (
                  <option key={p} value={p}>
                    {policyLabels()[p]}
                  </option>
                ))}
              </select>
              {rule && <span className="field__hint">{policyHints()[rule]}</span>}
            </div>
          )}
        </div>
        <div className="modal__foot" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => onResolve('skip', applyToAll, rule)}>
            
            {t('Пропустить')}
          </button>
          <button className="btn" onClick={() => onResolve('rename', applyToAll, rule)}>
            
            {t('Переименовать')}
          </button>
          <button
            className="btn"
            onClick={() => onResolve('resume', applyToAll, rule)}
            disabled={!canResume}
            title={canResume ? t('Докачать недостающую часть') : t('Докачка возможна только для неполного файла')}
          >
            
            {t('Докачать')}
          </button>
          <button className="btn btn--primary" onClick={() => onResolve('overwrite', applyToAll, rule)}>
            
            {t('Перезаписать')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface DropTargetProps {
  folderName: string
  currentPath: string
  itemCount: number
  onChoose: (into: 'folder' | 'current') => void
  onCancel: () => void
}

/**
 * Asked when a drop lands on a folder row: the gesture is ambiguous, because
 * the cursor was over a folder but the pane's own directory is an equally
 * reasonable destination. Three answers, since declining the folder is itself a
 * meaningful choice rather than a cancel.
 */
export function DropTargetDialog(props: DropTargetProps): ReactElement {
  const { folderName, currentPath, itemCount, onChoose, onCancel } = props
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('Куда передать')}>
        <div className="modal__head">
          <h2 className="modal__title">{t('Куда передать?')}</h2>
          <p className="modal__sub">
            {itemCount === 1
              ? t('Объект брошен на папку {0}.', folderName)
              : t('Объектов брошено: {0}, папка назначения — {1}.', itemCount, folderName)}
          </p>
        </div>
        <div className="modal__body">
          <dl className="diff-table">
            <dt>{t('Внутрь папки')}</dt>
            <dd>{currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`}</dd>
            <dt>{t('В текущий каталог')}</dt>
            <dd>{currentPath}</dd>
          </dl>
        </div>
        <div className="modal__foot">
          <button className="btn" onClick={onCancel}>
            
            {t('Отмена')}
          </button>
          <span className="modal__foot-spacer" />
          <button className="btn" onClick={() => onChoose('current')}>
            
            {t('В текущий каталог')}
          </button>
          <button className="btn btn--primary" onClick={() => onChoose('folder')}>
            {t('Внутрь «{0}»', folderName)}
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface SettingsProps {
  settings: AppSettings
  encryptionAvailable: boolean
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

function policyLabels(): Record<ConflictPolicy, string> {
  return {
    ask: t('Спрашивать каждый раз'),
    overwrite: t('Всегда перезаписывать'),
    skip: t('Всегда пропускать'),
    resume: t('Всегда докачивать'),
    'size-differs': t('Заменить, если отличается размер'),
    newer: t('Заменить, если источник новее'),
    'size-or-newer': t('Заменить, если отличается размер или источник новее')
  }
}

/** Shown under the dropdown so the rule's exact behaviour is not a guess. */
function policyHints(): Partial<Record<ConflictPolicy, string>> {
  return {
    'size-differs':
      t('Файлы одинакового размера пропускаются. Быстро, но не заметит правку, ') +
      t('не изменившую длину файла.'),
    newer:
      t('Заменяется только то, что в источнике свежее. Совпадение с точностью до ') +
      t('двух секунд считается одним и тем же временем.'),
    'size-or-newer':
      t('Самое строгое из трёх: достаточно любого признака различия. Пропускается ') +
      t('только то, что совпало и по размеру, и по дате.')
  }
}

export function SettingsDialog(props: SettingsProps): ReactElement {
  const { settings, encryptionAvailable, onChange, onClose } = props
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('Настройки')}>
        <div className="modal__head">
          <h2 className="modal__title">{t('Настройки')}</h2>
        </div>
        <div className="modal__body">
          <div className="field">
            <label className="field__label" htmlFor="set-language">
              {t('Язык интерфейса')}
            </label>
            <select
              id="set-language"
              className="select"
              value={settings.language}
              onChange={(e) => onChange({ language: e.target.value as Language })}
            >
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {LANGUAGE_NAMES[code]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="set-theme">
              
              {t('Тема')}
            </label>
            <select
              id="set-theme"
              className="select"
              value={settings.theme}
              onChange={(e) => onChange({ theme: e.target.value as AppSettings['theme'] })}
            >
              <option value="dark">{t('Тёмная')}</option>
              <option value="light">{t('Светлая')}</option>
              <option value="system">{t('Как в системе')}</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="set-conflict">
              
              {t('Если файл уже существует')}
            </label>
            <select
              id="set-conflict"
              className="select"
              value={settings.conflictPolicy}
              onChange={(e) => onChange({ conflictPolicy: e.target.value as ConflictPolicy })}
            >
              {(Object.keys(policyLabels()) as ConflictPolicy[]).map((p) => (
                <option key={p} value={p}>
                  {policyLabels()[p]}
                </option>
              ))}
            </select>
            {policyHints()[settings.conflictPolicy] && (
              <span className="field__hint">{policyHints()[settings.conflictPolicy]}</span>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="set-concurrency">
              
              {t('Параллельные передачи')}
            </label>
            <select
              id="set-concurrency"
              className="select"
              value={settings.concurrentTransfers}
              onChange={(e) => onChange({ concurrentTransfers: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
            <span className="field__hint">
              
              {t('Каждая параллельная передача использует отдельное соединение с сервером.')}
            </span>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.showHiddenFiles}
              onChange={(e) => onChange({ showHiddenFiles: e.target.checked })}
            />
            <span>{t('Показывать скрытые файлы (начинающиеся с точки)')}</span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.confirmDelete}
              onChange={(e) => onChange({ confirmDelete: e.target.checked })}
            />
            <span>{t('Подтверждать удаление')}</span>
          </label>

          <div className="notice">
            {encryptionAvailable
              ? t('Пароли шифруются средствами ОС (DPAPI) и привязаны к вашей учётной записи Windows.')
              : t('Системное хранилище секретов недоступно — пароли не сохраняются.')}
          </div>
        </div>
        <div className="modal__foot">
          <span className="modal__foot-spacer" />
          <button className="btn btn--primary" onClick={onClose}>
            
            {t('Готово')}
          </button>
        </div>
      </div>
    </div>
  )
}

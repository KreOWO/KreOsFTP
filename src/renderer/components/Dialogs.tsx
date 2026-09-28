import { useEffect, useRef, useState } from 'react'
import { LANGUAGES, LANGUAGE_NAMES, t , type Language } from '../../shared/i18n'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import type {
  AppSettings,
  AutomationMacro,
  ConflictAction,
  ConflictPolicy,
  ConflictRequest,
  HotkeyAction,
  MacroStep,
  SiteSummary
} from '@shared/types'
import { formatDate, formatSize } from '../format'
import {
  formatHotkey,
  hotkeyActionLabel,
  hotkeyFromEvent,
  modifierHotkeyFromEvent,
  tooltipWithHotkey
} from '../hotkeys'

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
  sites: SiteSummary[]
  encryptionAvailable: boolean
  onChange: (patch: Partial<AppSettings>) => void
  onRunMacro: (macro: AutomationMacro) => void
  onClose: () => void
}

function HotkeyInput(props: {
  value: string
  conflicts: string[]
  onChange: (value: string) => void
}): ReactElement {
  const [capturing, setCapturing] = useState(false)
  const [pressedModifiers, setPressedModifiers] = useState('')
  const capturingRef = useRef(false)
  const conflictMessage = props.conflicts.length > 0
    ? t('Сочетание уже используется: {0}', props.conflicts.join(', '))
    : ''

  const beginCapture = (): void => {
    capturingRef.current = true
    setCapturing(true)
    setPressedModifiers('')
  }
  const endCapture = (): void => {
    capturingRef.current = false
    setCapturing(false)
    setPressedModifiers('')
  }
  const capture = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!capturingRef.current) beginCapture()
    if (event.key === 'Escape') {
      endCapture()
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      props.onChange('')
      endCapture()
      event.currentTarget.blur()
      return
    }
    const modifiers = modifierHotkeyFromEvent(event)
    setPressedModifiers(modifiers)
    const value = hotkeyFromEvent(event)
    if (value) {
      props.onChange(value)
      endCapture()
      event.currentTarget.blur()
    }
  }
  const release = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (!capturingRef.current) return
    event.preventDefault()
    event.stopPropagation()
    setPressedModifiers(modifierHotkeyFromEvent(event))
  }
  const visibleValue = capturing
    ? pressedModifiers
      ? formatHotkey(pressedModifiers)
      : t('Нажмите сочетание клавиш')
    : props.value
      ? formatHotkey(props.value)
      : t('Добавить хоткей')
  return (
    <span
      className={'hotkey-control' + (conflictMessage ? ' hotkey-control--conflict' : '')}
      data-tooltip={conflictMessage || t('Нажмите сочетание; Backspace удаляет его')}
    >
      <input
        className="input input--mono hotkey-input"
        readOnly
        value={visibleValue}
        onKeyDown={capture}
        onKeyUp={release}
        onFocus={beginCapture}
        onClick={beginCapture}
        onBlur={endCapture}
        aria-invalid={Boolean(conflictMessage)}
        aria-label={conflictMessage || t('Горячая клавиша')}
      />
      {conflictMessage && <span className="hotkey-control__warning" aria-hidden="true">!</span>}
    </span>
  )
}

function newMacroStep(type: MacroStep['type'], sites: SiteSummary[]): MacroStep {
  const id = crypto.randomUUID()
  if (type === 'connect') return { id, type, siteId: sites[0]?.id ?? '' }
  if (type === 'command') return { id, type, command: '' }
  return { id, type }
}

function MacroEditor(props: {
  macro: AutomationMacro
  sites: SiteSummary[]
  hotkeyConflicts: string[]
  onChange: (macro: AutomationMacro) => void
  onDelete: () => void
  onRun: () => void
}): ReactElement {
  const { macro, sites, onChange } = props
  const [nextType, setNextType] = useState<MacroStep['type']>('connect')
  const runnable = Boolean(
    macro.name.trim() &&
    macro.steps.length > 0 &&
    macro.steps.every((step) =>
      step.type === 'command' ? step.command.trim() : step.type === 'connect' ? step.siteId : true
    )
  )
  const updateStep = (id: string, patch: Partial<MacroStep>): void => {
    onChange({
      ...macro,
      steps: macro.steps.map((step) => (step.id === id ? ({ ...step, ...patch } as MacroStep) : step))
    })
  }
  const moveStep = (index: number, direction: -1 | 1): void => {
    const target = index + direction
    if (target < 0 || target >= macro.steps.length) return
    const steps = [...macro.steps]
    ;[steps[index], steps[target]] = [steps[target], steps[index]]
    onChange({ ...macro, steps })
  }
  return (
    <section className="macro-card">
      <div className="macro-card__head">
        <input
          className="input"
          value={macro.name}
          maxLength={80}
          onChange={(event) => onChange({ ...macro, name: event.target.value })}
          placeholder={t('Название макроса')}
        />
        <HotkeyInput
          value={macro.hotkey}
          conflicts={props.hotkeyConflicts}
          onChange={(hotkey) => onChange({ ...macro, hotkey })}
        />
        <button
          className="btn"
          type="button"
          disabled={!runnable}
          onClick={props.onRun}
          data-tooltip={tooltipWithHotkey(t('Запустить'), macro.hotkey)}
        >
          {t('Запустить')}
        </button>
        <button className="btn btn--danger" type="button" onClick={props.onDelete}>
          {t('Удалить')}
        </button>
      </div>
      <div className="macro-steps">
        {macro.steps.map((step, index) => (
          <div className="macro-step" key={step.id}>
            <span className="macro-step__number">{index + 1}</span>
            <strong>{macroStepLabel(step.type)}</strong>
            {step.type === 'connect' && (
              <select
                className="select"
                value={step.siteId}
                onChange={(event) => updateStep(step.id, { siteId: event.target.value })}
              >
                {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
            )}
            {step.type === 'command' && (
              <input
                className="input input--mono"
                value={step.command}
                onChange={(event) => updateStep(step.id, { command: event.target.value })}
                placeholder="docker compose up -d"
              />
            )}
            {step.type !== 'connect' && step.type !== 'command' && <span />}
            <div className="macro-step__actions">
              <button className="btn btn--ghost btn--icon" type="button" disabled={index === 0} onClick={() => moveStep(index, -1)}>↑</button>
              <button className="btn btn--ghost btn--icon" type="button" disabled={index === macro.steps.length - 1} onClick={() => moveStep(index, 1)}>↓</button>
              <button className="btn btn--ghost btn--icon" type="button" onClick={() => onChange({ ...macro, steps: macro.steps.filter((item) => item.id !== step.id) })}>×</button>
            </div>
          </div>
        ))}
      </div>
      <div className="macro-card__add">
        <select className="select" value={nextType} onChange={(event) => setNextType(event.target.value as MacroStep['type'])}>
          {(['connect', 'syncToServer', 'syncFromServer', 'command', 'disconnect'] as const).map((type) => (
            <option key={type} value={type}>{macroStepLabel(type)}</option>
          ))}
        </select>
        <button className="btn" type="button" disabled={nextType === 'connect' && sites.length === 0} onClick={() => onChange({ ...macro, steps: [...macro.steps, newMacroStep(nextType, sites)] })}>
          {t('Добавить шаг')}
        </button>
      </div>
    </section>
  )
}

function macroStepLabel(type: MacroStep['type']): string {
  return {
    connect: t('Подключение к серверу'),
    syncToServer: t('Обновление сервера'),
    syncFromServer: t('Обновление локальной папки'),
    command: t('SSH-команда'),
    disconnect: t('Отключение от сервера')
  }[type]
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

const SETTINGS_PAGES = ['general', 'transfers', 'hotkeys', 'macros'] as const
type SettingsPage = (typeof SETTINGS_PAGES)[number]

function settingsPageLabels(): Record<SettingsPage, string> {
  return {
    general: t('Общие'),
    transfers: t('Передачи'),
    hotkeys: t('Горячие клавиши'),
    macros: t('Макросы')
  }
}

export function SettingsDialog(props: SettingsProps): ReactElement {
  const { settings, sites, encryptionAvailable, onChange, onClose } = props
  const [page, setPage] = useState<SettingsPage>('general')
  const hotkeyAssignments = [
    ...(Object.keys(settings.hotkeys) as HotkeyAction[]).map((action) => ({
      owner: `action:${action}`,
      value: settings.hotkeys[action],
      label: hotkeyActionLabel(action)
    })),
    ...settings.macros.map((macro) => ({
      owner: `macro:${macro.id}`,
      value: macro.hotkey,
      label: t('Макрос «{0}»', macro.name)
    }))
  ]
  const conflictsFor = (owner: string, value: string): string[] =>
    value
      ? hotkeyAssignments
          .filter((assignment) => assignment.owner !== owner && assignment.value === value)
          .map((assignment) => assignment.label)
      : []
  const updateMacro = (macro: AutomationMacro): void =>
    onChange({ macros: settings.macros.map((item) => (item.id === macro.id ? macro : item)) })
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal modal--settings" role="dialog" aria-modal="true" aria-label={t('Настройки')}>
        <div className="modal__head">
          <h2 className="modal__title">{t('Настройки')}</h2>
          <div className="settings-tabs" role="tablist" aria-label={t('Разделы настроек')}>
            {SETTINGS_PAGES.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={page === item}
                className={'settings-tabs__button' + (page === item ? ' settings-tabs__button--active' : '')}
                onClick={() => setPage(item)}
              >
                {settingsPageLabels()[item]}
              </button>
            ))}
          </div>
        </div>
        <div className="modal__body">
          {page === 'general' && <div className="settings-page">
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

            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.showHiddenFiles}
                onChange={(e) => onChange({ showHiddenFiles: e.target.checked })}
              />
              <span>{t('Показывать скрытые файлы (начинающиеся с точки)')}</span>
            </label>

            <div className="notice">
              {encryptionAvailable
                ? t('Пароли шифруются средствами ОС (DPAPI) и привязаны к вашей учётной записи Windows.')
                : t('Системное хранилище секретов недоступно — пароли не сохраняются.')}
            </div>
          </div>}

          {page === 'transfers' && <div className="settings-page">
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
                checked={settings.confirmDelete}
                onChange={(e) => onChange({ confirmDelete: e.target.checked })}
              />
              <span>{t('Подтверждать удаление')}</span>
            </label>
          </div>}

          {page === 'hotkeys' && <div className="settings-page">
            <h3>{t('Горячие клавиши')}</h3>
            <span className="field__hint">{t('Щёлкните поле и нажмите сочетание клавиш.')}</span>
            <div className="hotkey-list">
              {(Object.keys(settings.hotkeys) as HotkeyAction[]).map((action) => (
                <label className="hotkey-row" key={action}>
                  <span>{hotkeyActionLabel(action)}</span>
                  <HotkeyInput
                    value={settings.hotkeys[action]}
                    conflicts={conflictsFor(`action:${action}`, settings.hotkeys[action])}
                    onChange={(value) => onChange({ hotkeys: { ...settings.hotkeys, [action]: value } })}
                  />
                </label>
              ))}
            </div>
          </div>}

          {page === 'macros' && <div className="settings-page">
            <div className="settings-section__head">
              <div>
                <h3>{t('Макросы')}</h3>
                <span className="field__hint">{t('Шаги выполняются строго по порядку; передача дожидается завершения.')}</span>
              </div>
              <button
                className="btn"
                type="button"
                onClick={() => onChange({
                  macros: [...settings.macros, { id: crypto.randomUUID(), name: t('Новый макрос'), hotkey: '', steps: [] }]
                })}
              >
                {t('Добавить макрос')}
              </button>
            </div>
            {settings.macros.length === 0 && <div className="empty-note">{t('Макросов пока нет.')}</div>}
            {settings.macros.map((macro) => (
              <MacroEditor
                key={macro.id}
                macro={macro}
                sites={sites}
                hotkeyConflicts={conflictsFor(`macro:${macro.id}`, macro.hotkey)}
                onChange={updateMacro}
                onDelete={() => onChange({ macros: settings.macros.filter((item) => item.id !== macro.id) })}
                onRun={() => props.onRunMacro(macro)}
              />
            ))}
          </div>}
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

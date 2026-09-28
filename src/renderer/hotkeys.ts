import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { t } from '../shared/i18n'
import type { HotkeyAction } from '@shared/types'

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight'
])

export function modifierHotkeyFromEvent(event: KeyboardEvent | ReactKeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  return parts.join('+')
}

export function hotkeyFromEvent(event: KeyboardEvent | ReactKeyboardEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) return null
  const allowed = /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Enter|Space|Tab|Arrow(?:Up|Down|Left|Right)|Home|End|Page(?:Up|Down)|Insert)$/
  if (!allowed.test(event.code)) return null
  const parts = modifierHotkeyFromEvent(event).split('+').filter(Boolean)
  // Plain letters are too easy to trigger while typing; function keys are safe.
  if (parts.length === 0 && !event.code.startsWith('F')) return null
  parts.push(event.code)
  return parts.join('+')
}

export function eventMatchesHotkey(event: KeyboardEvent, hotkey: string): boolean {
  return Boolean(hotkey) && hotkeyFromEvent(event) === hotkey
}

export function formatHotkey(hotkey: string): string {
  return hotkey
    .split('+')
    .map((part) => {
      if (/^Key[A-Z]$/.test(part)) return part.slice(3)
      if (/^Digit[0-9]$/.test(part)) return part.slice(5)
      if (part === 'Meta') return navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Win'
      return part
    })
    .join(' + ')
}

export function tooltipWithHotkey(label: string, hotkey: string): string {
  return hotkey ? `${label}\n${formatHotkey(hotkey)}` : label
}

export function hotkeyActionLabel(action: HotkeyAction): string {
  return {
    connectLast: t('Подключиться к последнему серверу'),
    toggleSsh: t('Открыть или закрыть SSH'),
    syncToServer: t('Загрузить обновление на сервер'),
    syncFromServer: t('Загрузить обновление с сервера'),
    disconnect: t('Разорвать активное соединение')
  }[action]
}

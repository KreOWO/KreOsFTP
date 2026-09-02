import { t } from '../shared/i18n'
/** Читается при вызове, а не при импорте: язык к тому моменту уже известен. */
const units = (): string[] => [t('Б'), t('КБ'), t('МБ'), t('ГБ'), t('ТБ')]

export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes < 0) return '—'
  if (bytes === 0) return t('0 Б')
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units().length - 1)
  const value = bytes / 1024 ** exp
  const digits = exp === 0 ? 0 : value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${units()[exp]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond < 1) return '—'
  return t('{0}/с', formatSize(bytesPerSecond))
}

export function formatDate(epochMs: number | null): string {
  if (!epochMs) return '—'
  const d = new Date(epochMs)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    ...(sameYear ? {} : { year: '2-digit' })
  })
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time}`
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** Remaining time for an in-flight transfer, or an em dash when unknowable. */
export function formatEta(
  size: number | null,
  transferred: number,
  bytesPerSecond: number
): string {
  if (size === null || bytesPerSecond < 1) return '—'
  const remaining = size - transferred
  if (remaining <= 0) return '—'
  const seconds = Math.round(remaining / bytesPerSecond)
  if (seconds < 60) return t('{0} с', seconds)
  if (seconds < 3600) return t('{0} мин {1} с', Math.floor(seconds / 60), seconds % 60)
  return t('{0} ч {1} мин', Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60))
}


import { t } from '../shared/i18n'
/** Читается при вызове, а не при импорте: язык к тому моменту уже известен. */
const units = (): string[] => [t('Б'), t('КБ'), t('МБ'), t('ГБ'), t('ТБ')]

export function formatSize(bytes: number | null | undefined): string {
  return formatSizeAt(bytes, 0)
}

/** Сколько ступеней можно спуститься от самой крупной единицы до байтов. */
export const MAX_SIZE_DETAIL = 4

/**
 * Размер с заданной степенью подробности.
 *
 * Уровень 0 — самая компактная запись (`1.1 МБ`). Каждая следующая ступень
 * опускается на единицу вниз и добавляет знак после запятой: `1126.4 КБ`,
 * затем `1153433 Б`. Это позволяет столбцу использовать освободившееся место
 * для точности, вместо того чтобы оставлять его пустым.
 */
export function formatSizeAt(bytes: number | null | undefined, level: number): string {
  if (bytes === null || bytes === undefined || bytes < 0) return '—'
  if (bytes === 0) return t('0 Б')
  const names = units()
  const natural = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), names.length - 1)
  const exp = Math.max(0, natural - Math.max(0, level))
  const value = bytes / 1024 ** exp
  // Байты дробными не бывают. На спуске десятая доля — смысл затеи, но у
  // многозначного числа она уже ничего не сообщает: 2343750.0 КБ шумит.
  const digits = exp === 0 ? 0 : level > 0 ? (value < 10_000 ? 1 : 0) : value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${names[exp]}`
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


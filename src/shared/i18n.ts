import { EN } from './i18n.en'

export const LANGUAGES = ['ru', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_NAMES: Record<Language, string> = {
  ru: 'Русский',
  en: 'English'
}

/**
 * The Russian source text is itself the key, gettext-style.
 *
 * Two things fall out of that. Untranslated text degrades to readable Russian
 * instead of a bare key or an empty label, and there is no second identifier to
 * drift out of sync with the string it names.
 */
export type Catalog = Record<string, string>

const CATALOGS: Record<Language, Catalog | null> = {
  ru: null, // identity: the source strings are already Russian
  en: EN
}

let current: Language = 'ru'

/** Both processes hold their own copy; the store is the single source of truth. */
export function setLanguage(language: Language): void {
  current = language
}

export function getLanguage(): Language {
  return current
}

/**
 * Translates `text`, substituting `{0}`, `{1}` … with the extra arguments.
 *
 * Positional placeholders keep the mechanical conversion of template literals
 * honest: `` `Файлов: ${n}` `` becomes `t('Файлов: {0}', n)` with no guesswork
 * about what to name the value.
 */
export function t(text: string, ...args: unknown[]): string {
  const catalog = CATALOGS[current]
  const translated = catalog?.[text] ?? text
  if (args.length === 0) return translated
  return translated.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Picks the grammatical number for `count`.
 *
 * Forms are written as one `|`-separated string so a translator sees them
 * together and so the count of forms can differ per language — Russian needs
 * three (объект / объекта / объектов), English two.
 */
export function plural(count: number, forms: string): string {
  const translated = t(forms)
  const parts = translated.split('|')
  const category = new Intl.PluralRules(current).select(count)
  const order: Record<string, number> = { one: 0, few: 1, many: 2, other: 2 }
  // English has no `few`/`many`, so its second form doubles as the plural.
  const index = current === 'en' ? (category === 'one' ? 0 : 1) : (order[category] ?? 2)
  return parts[Math.min(index, parts.length - 1)] ?? parts[0] ?? ''
}

/** `5 объектов` — the count and its agreeing noun in one step. */
export function pluralize(count: number, forms: string): string {
  return `${count} ${plural(count, forms)}`
}

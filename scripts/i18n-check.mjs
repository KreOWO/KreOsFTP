/**
 * Compares the keys actually passed to t() / plural() in the source against the
 * English catalog.
 *
 * A missing entry is silent at runtime — the UI simply shows Russian — so the
 * only way to keep the translation honest is to check it mechanically.
 */
import ts from 'typescript'
import { readFileSync, globSync } from 'node:fs'
import { join, relative } from 'node:path'
import { EN } from '../src/shared/i18n.en.ts'

const ROOT = process.argv[2] ?? '.'
const used = new Map() // key -> [files]

for (const rel of globSync('src/**/*.{ts,tsx}', { cwd: ROOT })) {
  if (rel.includes('i18n')) continue
  const file = join(ROOT, rel)
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText()
      const argIndex = name === 't' ? 0 : name === 'plural' || name === 'pluralize' ? 1 : -1
      if (argIndex >= 0) {
        const arg = node.arguments[argIndex]
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          if (!used.has(arg.text)) used.set(arg.text, [])
          used.get(arg.text).push(relative(ROOT, file))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

const missing = [...used.keys()].filter((k) => !(k in EN))
const unused = Object.keys(EN).filter((k) => !used.has(k))

console.log(`  ключей в коде:      ${used.size}`)
console.log(`  записей в каталоге: ${Object.keys(EN).length}`)
console.log(`  без перевода:       ${missing.length}`)
console.log(`  лишних в каталоге:  ${unused.length}`)

if (missing.length) {
  console.log('\n  ── БЕЗ ПЕРЕВОДА ──')
  for (const k of missing) console.log(`   ${JSON.stringify(k)}  (${used.get(k)[0]})`)
}
if (unused.length) {
  console.log('\n  ── ЛИШНИЕ В КАТАЛОГЕ ──')
  for (const k of unused) console.log(`   ${JSON.stringify(k)}`)
}
process.exit(missing.length ? 1 : 0)

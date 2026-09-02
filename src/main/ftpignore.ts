/** A compact, predictable subset of gitignore syntax for deployment sync. */

interface Rule {
  negate: boolean
  directoryOnly: boolean
  pattern: RegExp
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

function escapeClassChar(char: string): string {
  return /[\\\]\^-]/.test(char) ? `\\${char}` : char
}

function characterClass(glob: string, start: number): { source: string; end: number } | null {
  let end = start + 1
  if (glob[end] === ']' || glob[end] === '-') end++
  while (end < glob.length && glob[end] !== ']') end++
  if (end >= glob.length) return null

  let content = glob.slice(start + 1, end)
  let negate = false
  if (content.startsWith('!') || content.startsWith('^')) {
    negate = true
    content = content.slice(1)
  }
  if (!content) return null

  let source = ''
  for (let index = 0; index < content.length; index++) {
    const char = content[index]
    if (char === '\\' && index + 1 < content.length) {
      source += escapeClassChar(content[++index])
    } else if (char === ']' || char === '\\' || (char === '^' && index === 0)) {
      source += `\\${char}`
    } else {
      // Keep '-' intact: inside a class it deliberately describes a range.
      source += char
    }
  }
  return { source: `[${negate ? '^' : ''}${source}]`, end }
}

function globRegex(glob: string, matchAtAnyDepth: boolean): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        while (glob[i + 1] === '*') i++
        if (glob[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '[') {
      const parsed = characterClass(glob, i)
      if (parsed) {
        source += parsed.source
        i = parsed.end
      } else {
        source += '\\['
      }
    } else if (char === '\\' && i + 1 < glob.length) {
      source += escapeRegex(glob[++i])
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegex(char)
    }
  }
  return new RegExp(matchAtAnyDepth ? `(?:^|/)${source}$` : `^${source}$`)
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}

function parseRule(rawLine: string): Rule | null {
  const trimmed = rawLine.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  let line = trimmed
  let negate = false
  if (line.startsWith('!')) {
    negate = true
    line = line.slice(1)
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    // In gitignore syntax a leading backslash makes ! or # literal.
    line = line.slice(1)
  }

  const anchored = line.startsWith('/')
  if (anchored) line = line.slice(1)
  const directoryOnly = line.endsWith('/')
  if (directoryOnly) line = line.slice(0, -1)
  if (!line) return null

  // A slash in the middle, or a slash at the beginning, anchors a gitignore
  // pattern to the sync root. A basename-only pattern matches at every depth.
  const matchAtAnyDepth = !anchored && !line.includes('/')
  return { negate, directoryOnly, pattern: globRegex(line, matchAtAnyDepth) }
}

export class FtpIgnore {
  private rules: Rule[]

  constructor(text: string) {
    this.rules = text
      .split(/\r?\n/)
      .map(parseRule)
      .filter((rule): rule is Rule => rule !== null)
  }

  ignores(path: string, isDir: boolean): boolean {
    const candidate = normalise(path)
    if (!candidate) return false
    // The control file describes a deployment, but is never part of it.
    // Keep this rule outside the user patterns so even `!.ftpignore` cannot
    // accidentally publish it (the same applies to nested control files).
    if (candidate === '.ftpignore' || candidate.endsWith('/.ftpignore')) return true
    let ignored = false
    const segments = candidate.split('/')
    const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join('/'))

    for (const rule of this.rules) {
      const matchesSelf = (!rule.directoryOnly || isDir) && rule.pattern.test(candidate)
      const matchesParent = ancestors.slice(0, -1).some((parent) => rule.pattern.test(parent))
      if (matchesSelf || matchesParent) ignored = !rule.negate
    }
    return ignored
  }
}

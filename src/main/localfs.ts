import { execFile } from 'node:child_process'
import { t } from '../shared/i18n'
import { promisify } from 'node:util'
import { readdir, stat, lstat, mkdir, rm, rename as fsRename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileEntry } from '@shared/types'

const run = promisify(execFile)

export async function listLocal(dir: string): Promise<FileEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (d): Promise<FileEntry | null> => {
      const full = join(dir, d.name)
      try {
        // lstat first so a broken symlink still shows up rather than killing the listing.
        const link = await lstat(full)
        const info = link.isSymbolicLink() ? await stat(full).catch(() => link) : link
        const isDirectory = !link.isSymbolicLink() && info.isDirectory()
        return {
          name: d.name,
          type: link.isSymbolicLink() ? 'link' : isDirectory ? 'dir' : 'file',
          size: isDirectory ? 0 : info.size,
          modifiedAt: info.mtimeMs,
          permissions: null
        }
      } catch {
        return null
      }
    })
  )
  return entries.filter((e): e is FileEntry => e !== null)
}

/** Newest direct regular file, calculated after the visible listing is sent. */
export async function newestLocalFileMtime(root: string): Promise<number | null> {
  const dirents = await readdir(root, { withFileTypes: true }).catch(() => [])
  const dates = await Promise.all(
    dirents
      .filter((entry) => entry.isFile())
      .map((entry) => stat(join(root, entry.name)).then((info) => info.mtimeMs).catch(() => null))
  )
  return dates.reduce<number | null>(
    (newest, value) =>
      value !== null && (newest === null || value > newest) ? value : newest,
    null
  )
}

/** A server/listing supplied name must remain one literal local path segment. */
export function safeLocalChild(root: string, name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new Error(t('Недопустимое имя файла: {0}', JSON.stringify(name)))
  }
  if (process.platform === 'win32') {
    if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
      throw new Error(t('Имя файла недопустимо в Windows: {0}', JSON.stringify(name)))
    }
    const stem = name.split('.')[0].toUpperCase()
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new Error(t('Зарезервированное имя Windows: {0}', JSON.stringify(name)))
    }
  }

  const base = resolve(root)
  const target = resolve(base, name)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
    throw new Error(t('Путь выходит за пределы выбранной папки: {0}', JSON.stringify(name)))
  }
  return target
}

export async function makeLocalDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function removeLocal(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export async function renameLocal(from: string, to: string): Promise<void> {
  await fsRename(from, to)
}

export function localHome(): string {
  return homedir()
}

export function parentOf(path: string): string {
  const parent = dirname(path)
  return parent === path ? path : parent
}

/**
 * Drive letters on Windows, mount-ish shortcuts elsewhere. `wmic` is gone on
 * recent Windows builds, so this shells out to PowerShell and degrades to a
 * probe of A–Z if even that fails.
 */
export async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-PSDrive -PSProvider FileSystem).Root -join ","'
      ],
      { windowsHide: true, timeout: 5000 }
    )
    const roots = stdout
      .trim()
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
    if (roots.length > 0) return roots
  } catch {
    /* fall through to the probe below */
  }
  const probed: string[] = []
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = String.fromCharCode(c) + ':' + sep
    try {
      await stat(root)
      probed.push(root)
    } catch {
      /* not mounted */
    }
  }
  return probed
}

export interface WalkedFile {
  /** Absolute local path. */
  localPath: string
  /** Path relative to the walk root, using forward slashes. */
  relative: string
  size: number
  /** Epoch ms, for date-based overwrite rules. */
  modifiedAt: number
}

/** Depth-first listing of every regular file under `root`, for folder uploads. */
export async function walkLocalTree(root: string): Promise<{ files: WalkedFile[]; dirs: string[] }> {
  const files: WalkedFile[] = []
  const dirs: string[] = []
  const rootName = basename(root)

  async function visit(dir: string, relativeDir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true })
    for (const d of dirents) {
      const full = join(dir, d.name)
      const rel = relativeDir === '' ? d.name : `${relativeDir}/${d.name}`
      if (d.isDirectory()) {
        dirs.push(rel)
        await visit(full, rel)
      } else if (d.isFile()) {
        const info = await stat(full).catch(() => null)
        if (info) {
          files.push({
            localPath: full,
            relative: rel,
            size: info.size,
            modifiedAt: info.mtimeMs
          })
        }
      }
    }
  }

  await visit(root, rootName)
  dirs.unshift(rootName)
  return { files, dirs }
}

export async function localExists(path: string): Promise<false | 'file' | 'dir'> {
  try {
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : 'file'
  } catch {
    return false
  }
}

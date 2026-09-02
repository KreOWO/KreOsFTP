import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { t } from '../shared/i18n'
import { join } from 'node:path'
import type { Adapter } from './protocols/adapter'
import { rpath } from './protocols/adapter'
import { FtpIgnore } from './ftpignore'
import { safeLocalChild } from './localfs'
import type { FileEntry, VersionSyncPreview } from '@shared/types'

export interface SyncFile {
  relative: string
  localPath: string
  remotePath: string
  size: number
  modifiedAt: number | null
}

export interface SyncPlan {
  files: SyncFile[]
  /** Top-level source entries allowed by .ftpignore (preview only). */
  included: string[]
  /** Source-relative directories that have to be created at the destination. */
  transferDirs: string[]
  localDirs: string[]
  remoteDirs: string[]
  ignored: number
  unchanged: number
}

export type SyncPlanProgress = (plan: SyncPlan) => void

const MAX_SYNC_OBJECTS = 100_000
const MAX_SYNC_DEPTH = 64

/** Convert an internal plan into a renderer-safe, source-side preview. */
export function toSyncPreview(
  direction: 'upload' | 'download',
  plan: SyncPlan
): VersionSyncPreview {
  const directories = new Set<string>()
  const addDirectoryAndAncestors = (relative: string, includeSelf: boolean): void => {
    const segments = relative.split('/')
    const end = includeSelf ? segments.length : segments.length - 1
    for (let index = 1; index <= end; index++) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }
  for (const directory of plan.transferDirs) addDirectoryAndAncestors(directory, true)
  for (const file of plan.files) addDirectoryAndAncestors(file.relative, false)
  return {
    direction,
    included: plan.included,
    files: plan.files.map((file) => file.relative),
    directories: [...directories],
    unchanged: plan.unchanged,
    ignored: plan.ignored
  }
}

interface LocalEntry {
  relative: string
  path: string
  size: number
  modifiedAt: number
}

interface RemoteEntry {
  relative: string
  path: string
  size: number
  modifiedAt: number | null
}

interface Tree<T> {
  files: T[]
  dirs: string[]
  ignored: number
}

async function localIgnore(root: string): Promise<FtpIgnore> {
  const text = await readFile(join(root, '.ftpignore'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error(t('.ftpignore больше 1 МБ'))
  return new FtpIgnore(text)
}

async function remoteIgnore(adapter: Adapter, root: string): Promise<FtpIgnore> {
  const path = rpath.join(root, '.ftpignore')
  try {
    return new FtpIgnore((await adapter.readFile(path)).toString('utf8'))
  } catch (error) {
    const message = (error as Error).message
    if (/\b(ENOENT|550)\b|no such file|not found/i.test(message)) return new FtpIgnore('')
    throw error
  }
}

async function walkLocal(root: string, ignore: FtpIgnore): Promise<Tree<LocalEntry>> {
  const files: LocalEntry[] = []
  const dirs: string[] = []
  let ignored = 0
  let visited = 0

  const visit = async (dir: string, relativeDir: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error(t('Слишком глубокое дерево локальных каталогов'))
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (++visited > 100_000) throw new Error(t('Синхронизация ограничена 100 000 объектов'))
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ignore.ignores(relative, true)) {
          ignored++
          // Gitignore cannot re-include a file while its parent remains
          // excluded. Skipping the subtree avoids scanning .git, virtual
          // environments and runtime data during every hover preview.
          continue
        }
        dirs.push(relative)
        await visit(path, relative, depth + 1)
      } else if (entry.isFile()) {
        if (ignore.ignores(relative, false)) {
          ignored++
          continue
        }
        const info = await stat(path)
        files.push({ relative, path, size: info.size, modifiedAt: info.mtimeMs })
      } else {
        ignored++
      }
    }
  }

  await visit(root, '', 0)
  return { files, dirs, ignored }
}

async function walkRemote(
  adapter: Adapter,
  root: string,
  ignore: FtpIgnore
): Promise<Tree<RemoteEntry>> {
  const files: RemoteEntry[] = []
  const dirs: string[] = []
  const seen = new Set<string>()
  let ignored = 0
  let visited = 0

  const visit = async (dir: string, relativeDir: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error(t('Слишком глубокое дерево каталогов на сервере'))
    if (seen.has(dir)) throw new Error(t('Сервер вернул циклический каталог: {0}', dir))
    seen.add(dir)
    const entries = await adapter.list(dir)
    for (const entry of entries) {
      if (++visited > 100_000) throw new Error(t('Синхронизация ограничена 100 000 объектов'))
      if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/\0]/.test(entry.name)) {
        throw new Error(t('Сервер вернул небезопасное имя: {0}', JSON.stringify(entry.name)))
      }
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const path = rpath.join(dir, entry.name)
      if (entry.type === 'dir') {
        if (ignore.ignores(relative, true)) {
          ignored++
          continue
        }
        dirs.push(relative)
        await visit(path, relative, depth + 1)
      } else if (entry.type === 'file') {
        if (ignore.ignores(relative, false)) ignored++
        else files.push({ relative, path, size: entry.size, modifiedAt: entry.modifiedAt })
      } else {
        ignored++
      }
    }
  }

  await visit(root, '', 0)
  return { files, dirs, ignored }
}

function localPath(root: string, relative: string): string {
  return relative.split('/').reduce((parent, name) => safeLocalChild(parent, name), root)
}

interface LocalLevelEntry {
  name: string
  relative: string
  path: string
  type: 'file' | 'dir'
}

async function listLocalLevel(
  dir: string,
  relativeDir: string,
  ignore: FtpIgnore | null
): Promise<{ entries: LocalLevelEntry[]; ignored: number }> {
  const result: LocalLevelEntry[] = []
  let ignored = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (ignore?.ignores(relative, true)) ignored++
      else result.push({ name: entry.name, relative, path, type: 'dir' })
    } else if (entry.isFile()) {
      if (ignore?.ignores(relative, false)) {
        ignored++
      } else {
        // Size is deliberately read later, one file at a time. This lets the
        // renderer paint the allowed rows first and lets a confirmed folder
        // stop without stat'ing the rest of its files.
        result.push({ name: entry.name, relative, path, type: 'file' })
      }
    } else {
      ignored++
    }
  }
  return { entries: result, ignored }
}

async function listRemoteLevel(adapter: Adapter, dir: string): Promise<FileEntry[]> {
  const entries = await adapter.list(dir)
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/\0]/.test(entry.name)) {
      throw new Error(t('Сервер вернул небезопасное имя: {0}', JSON.stringify(entry.name)))
    }
    if (names.has(entry.name)) {
      throw new Error(t('Сервер вернул повторяющееся имя: {0}', JSON.stringify(entry.name)))
    }
    names.add(entry.name)
  }
  return entries
}

function previewPlan(
  files: SyncFile[],
  included: string[],
  transferDirs: string[],
  localDirs: string[],
  remoteDirs: string[],
  ignored: number,
  unchanged: number
): SyncPlan {
  return {
    files: [...files],
    included: [...included],
    transferDirs: [...transferDirs],
    localDirs: [...localDirs],
    remoteDirs: [...remoteDirs],
    ignored,
    unchanged
  }
}

/**
 * Fast local-only first stage for upload hover. It intentionally runs before
 * opening a second server connection, so .ftpignore candidates can be painted
 * without waiting for SSH/FTP authentication.
 */
export async function previewUploadSeed(localRoot: string): Promise<SyncPlan> {
  const ignore = await localIgnore(localRoot)
  const level = await listLocalLevel(localRoot, '', ignore)
  return previewPlan(
    [],
    level.entries.map((entry) => entry.relative),
    [],
    [],
    [],
    level.ignored,
    0
  )
}

/** Breadth-first, size-only upload preview. Never downloads remote file data. */
export async function previewUpload(
  adapter: Adapter,
  localRoot: string,
  remoteRoot: string,
  onProgress: SyncPlanProgress
): Promise<SyncPlan> {
  const ignore = await localIgnore(localRoot)
  const files: SyncFile[] = []
  const included: string[] = []
  const transferDirs: string[] = []
  const confirmedFolders = new Set<string>()
  let ignored = 0
  let unchanged = 0
  const report = (): void =>
    onProgress(
      previewPlan(files, included, transferDirs, [], transferDirs, ignored, unchanged)
    )

  type Pending = {
    localDir: string
    remoteDir: string
    relativeDir: string
    top: string | null
    depth: number
  }
  const queue: Pending[] = [
    { localDir: localRoot, remoteDir: remoteRoot, relativeDir: '', top: null, depth: 0 }
  ]
  let visited = 0

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.top && confirmedFolders.has(current.top)) continue
    if (current.depth > MAX_SYNC_DEPTH) {
      throw new Error(t('Слишком глубокое дерево локальных каталогов'))
    }

    const localLevel = await listLocalLevel(current.localDir, current.relativeDir, ignore)
    visited += localLevel.entries.length
    if (visited > MAX_SYNC_OBJECTS) {
      throw new Error(t('Синхронизация ограничена {0} объектов', MAX_SYNC_OBJECTS.toLocaleString('ru-RU')))
    }
    ignored += localLevel.ignored
    if (!current.relativeDir) {
      included.push(...localLevel.entries.map((entry) => entry.relative))
      report()
    }
    const remoteEntries = await listRemoteLevel(adapter, current.remoteDir)
    const remoteByName = new Map(remoteEntries.map((entry) => [entry.name, entry]))

    for (const source of localLevel.entries) {
      const target = remoteByName.get(source.name)
      const top = current.top ?? source.name
      if (source.type === 'dir') {
        if (target?.type === 'dir') {
          queue.push({
            localDir: source.path,
            remoteDir: rpath.join(current.remoteDir, source.name),
            relativeDir: source.relative,
            top,
            depth: current.depth + 1
          })
        } else {
          transferDirs.push(source.relative)
          confirmedFolders.add(top)
          report()
          if (current.top) break
        }
      } else {
        const info = await stat(source.path)
        if (target?.type === 'file' && info.size === target.size) {
          unchanged++
          continue
        }
        files.push({
          relative: source.relative,
          localPath: source.path,
          remotePath: rpath.join(current.remoteDir, source.name),
          size: info.size,
          modifiedAt: info.mtimeMs
        })
        if (current.top) confirmedFolders.add(top)
        report()
        if (current.top) break
      }
    }
  }

  return previewPlan(files, included, transferDirs, [], transferDirs, ignored, unchanged)
}

/** Breadth-first, size-only download preview. */
export async function previewDownload(
  adapter: Adapter,
  localRoot: string,
  remoteRoot: string,
  onProgress: SyncPlanProgress
): Promise<SyncPlan> {
  const ignore = await remoteIgnore(adapter, remoteRoot)
  const files: SyncFile[] = []
  const included: string[] = []
  const transferDirs: string[] = []
  const confirmedFolders = new Set<string>()
  let ignored = 0
  let unchanged = 0
  const localDirs = (): string[] => transferDirs.map((dir) => localPath(localRoot, dir))
  const report = (): void =>
    onProgress(previewPlan(files, included, transferDirs, localDirs(), [], ignored, unchanged))

  type Pending = {
    remoteDir: string
    localDir: string
    relativeDir: string
    top: string | null
    depth: number
  }
  const queue: Pending[] = [
    { remoteDir: remoteRoot, localDir: localRoot, relativeDir: '', top: null, depth: 0 }
  ]
  let visited = 0

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.top && confirmedFolders.has(current.top)) continue
    if (current.depth > MAX_SYNC_DEPTH) {
      throw new Error(t('Слишком глубокое дерево каталогов на сервере'))
    }

    const remoteRaw = await listRemoteLevel(adapter, current.remoteDir)
    visited += remoteRaw.length
    if (visited > MAX_SYNC_OBJECTS) {
      throw new Error(t('Синхронизация ограничена {0} объектов', MAX_SYNC_OBJECTS.toLocaleString('ru-RU')))
    }
    const remoteEntries = remoteRaw.filter((entry) => {
      const relative = current.relativeDir ? `${current.relativeDir}/${entry.name}` : entry.name
      const excluded = ignore.ignores(relative, entry.type === 'dir') || entry.type === 'link'
      if (excluded) ignored++
      return !excluded
    })
    if (!current.relativeDir) {
      included.push(...remoteEntries.map((entry) => entry.name))
      report()
    }
    const localLevel = await listLocalLevel(current.localDir, current.relativeDir, null)
    const localByName = new Map(localLevel.entries.map((entry) => [entry.name, entry]))

    for (const source of remoteEntries) {
      const relative = current.relativeDir ? `${current.relativeDir}/${source.name}` : source.name
      const target = localByName.get(source.name)
      const top = current.top ?? source.name
      if (source.type === 'dir') {
        if (target?.type === 'dir') {
          queue.push({
            remoteDir: rpath.join(current.remoteDir, source.name),
            localDir: target.path,
            relativeDir: relative,
            top,
            depth: current.depth + 1
          })
        } else {
          transferDirs.push(relative)
          confirmedFolders.add(top)
          report()
          if (current.top) break
        }
      } else if (source.type === 'file') {
        const targetInfo = target?.type === 'file' ? await stat(target.path) : null
        if (targetInfo && source.size === targetInfo.size) {
          unchanged++
        } else {
          files.push({
            relative,
            localPath: localPath(localRoot, relative),
            remotePath: rpath.join(current.remoteDir, source.name),
            size: source.size,
            modifiedAt: source.modifiedAt
          })
          if (current.top) confirmedFolders.add(top)
          report()
          if (current.top) break
        }
      }
    }
  }

  return previewPlan(files, included, transferDirs, localDirs(), [], ignored, unchanged)
}

export async function planUpload(
  adapter: Adapter,
  localRoot: string,
  remoteRoot: string
): Promise<SyncPlan> {
  const ignore = await localIgnore(localRoot)
  const local = await walkLocal(localRoot, ignore)
  // Ignored server subtrees cannot affect an upload plan, so do not enumerate
  // databases, logs, caches and other runtime-only directories unnecessarily.
  const remote = await walkRemote(adapter, remoteRoot, ignore)
  const remoteFiles = new Map(remote.files.map((file) => [file.relative, file]))
  const remoteDirSet = new Set(remote.dirs)
  const transferDirs = local.dirs.filter((dir) => !remoteDirSet.has(dir))
  const files: SyncFile[] = []
  let unchanged = 0

  for (const source of local.files) {
    const target = remoteFiles.get(source.relative)
    if (target && source.size === target.size) {
      unchanged++
      continue
    }
    files.push({
      relative: source.relative,
      localPath: source.path,
      remotePath: rpath.join(remoteRoot, source.relative),
      size: source.size,
      modifiedAt: source.modifiedAt
    })
  }

  return {
    files,
    included: [],
    transferDirs,
    localDirs: [],
    remoteDirs: transferDirs,
    ignored: local.ignored,
    unchanged
  }
}

export async function planDownload(
  adapter: Adapter,
  localRoot: string,
  remoteRoot: string
): Promise<SyncPlan> {
  const ignore = await remoteIgnore(adapter, remoteRoot)
  const remote = await walkRemote(adapter, remoteRoot, ignore)
  const local = await walkLocal(localRoot, ignore)
  const localFiles = new Map(local.files.map((file) => [file.relative, file]))
  const localDirSet = new Set(local.dirs)
  const transferDirs = remote.dirs.filter((dir) => !localDirSet.has(dir))
  const files: SyncFile[] = []
  let unchanged = 0

  for (const source of remote.files) {
    const target = localFiles.get(source.relative)
    if (target && source.size === target.size) {
      unchanged++
      continue
    }
    files.push({
      relative: source.relative,
      localPath: localPath(localRoot, source.relative),
      remotePath: source.path,
      size: source.size,
      modifiedAt: source.modifiedAt
    })
  }

  return {
    files,
    included: [],
    transferDirs,
    localDirs: transferDirs.map((dir) => localPath(localRoot, dir)),
    remoteDirs: [],
    ignored: remote.ignored,
    unchanged
  }
}

export async function createLocalSyncDirs(paths: string[]): Promise<void> {
  for (const path of paths) await mkdir(path, { recursive: true })
}

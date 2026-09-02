import type { FileEntry, LogLevel, SiteConfig } from '@shared/types'

export interface RemoteStat {
  size: number
  /** Epoch ms, or null when unavailable or not requested. */
  modifiedAt: number | null
}

export interface ProgressReport {
  /** Bytes moved for the current file so far. */
  transferred: number
}

export type ProgressFn = (p: ProgressReport) => void
export type LogFn = (level: LogLevel, text: string) => void

/**
 * The single surface the rest of the app talks to. Both the FTP and SFTP
 * backends implement it, so the queue, the IPC layer and the UI stay
 * protocol-agnostic — adding a protocol means adding one file here.
 *
 * Every implementation must be safe against concurrent calls only in the sense
 * that the caller serialises them: FTP is a single-command-at-a-time protocol,
 * so `SessionManager` funnels all work for one session through a mutex.
 */
export interface Adapter {
  readonly protocolName: string

  connect(): Promise<void>
  disconnect(): Promise<void>
  /** True while the underlying socket is believed usable. */
  isConnected(): boolean

  /** Absolute working directory as the server reports it. */
  pwd(): Promise<string>
  list(remotePath: string): Promise<FileEntry[]>

  download(remotePath: string, localPath: string, onProgress: ProgressFn, startAt?: number): Promise<void>
  upload(localPath: string, remotePath: string, onProgress: ProgressFn, startAt?: number): Promise<void>
  /** Small control files such as .ftpignore. Callers enforce a size limit. */
  readFile(remotePath: string): Promise<Buffer>

  mkdir(remotePath: string): Promise<void>
  removeFile(remotePath: string): Promise<void>
  removeDir(remotePath: string): Promise<void>
  rename(from: string, to: string): Promise<void>

  /**
   * Metadata for one remote path, or null when it does not exist — which is
   * also how callers test existence.
   *
   * `withModified` is opt-in because FTP needs a second round trip (`MDTM`) for
   * the timestamp, and most callers only want the size. Ask for it only when a
   * date comparison actually depends on it.
   */
  statOf(remotePath: string, withModified?: boolean): Promise<RemoteStat | null>
  /** True when the path exists and is a directory. */
  isDir(remotePath: string): Promise<boolean>
}

export interface AdapterDeps {
  site: SiteConfig
  log: LogFn
  /** Resolved secrets, decrypted by the store just before connecting. */
  secrets: { password?: string; passphrase?: string }
}

/** Remote paths are always POSIX, regardless of the local platform. */
export const rpath = {
  join(...parts: string[]): string {
    const joined = parts
      .filter((p) => p !== '' && p !== undefined && p !== null)
      .join('/')
      .replace(/\/{2,}/g, '/')
    return joined === '' ? '/' : joined
  },
  dirname(p: string): string {
    const normalised = p.replace(/\/+$/, '')
    const idx = normalised.lastIndexOf('/')
    if (idx <= 0) return '/'
    return normalised.slice(0, idx)
  },
  basename(p: string): string {
    const normalised = p.replace(/\/+$/, '')
    const idx = normalised.lastIndexOf('/')
    return idx === -1 ? normalised : normalised.slice(idx + 1)
  },
  /** Collapse `.` and `..` so typed paths behave predictably. */
  normalise(p: string): string {
    const absolute = p.startsWith('/')
    const out: string[] = []
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
        else if (!absolute) out.push('..')
        continue
      }
      out.push(seg)
    }
    const joined = out.join('/')
    return absolute ? '/' + joined : joined === '' ? '.' : joined
  }
}

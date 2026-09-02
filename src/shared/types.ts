import { t, type Language } from './i18n'
/** Wire types shared between the Electron main process and the renderer. */

export type Protocol = 'ftp' | 'ftps' | 'ftps-implicit' | 'sftp'

/** Порядок в выпадающем списке. */
export const PROTOCOLS: Protocol[] = ['sftp', 'ftp', 'ftps', 'ftps-implicit']

/** Функция, а не константа: язык выбирается уже после загрузки модулей. */
export function protocolLabel(protocol: Protocol): string {
  const labels: Record<Protocol, string> = {
    ftp: t('FTP (незашифрованный)'),
    ftps: t('FTPS (явный TLS)'),
    'ftps-implicit': t('FTPS (неявный TLS)'),
    sftp: t('SFTP (поверх SSH)')
  }
  return labels[protocol]
}

export const DEFAULT_PORTS: Record<Protocol, number> = {
  ftp: 21,
  ftps: 21,
  'ftps-implicit': 990,
  sftp: 22
}

export type AuthMode = 'password' | 'key' | 'anonymous' | 'agent'

export interface QuickCommand {
  id: string
  label: string
  command: string
}

/** A saved server profile. `password`/`passphrase` never leave the main process
 *  once saved — they are stored encrypted and re-read only at connect time. */
export interface SiteConfig {
  id: string
  name: string
  protocol: Protocol
  host: string
  port: number
  authMode: AuthMode
  user: string
  /** Present only on the wire when the user is entering it. */
  password?: string
  privateKeyPath?: string
  passphrase?: string
  remoteDir?: string
  localDir?: string
  /** Optional companion SSH endpoint for FTP/FTPS profiles. */
  sshPort?: number
  quickCommands?: QuickCommand[]
  /** FTPS only: accept self-signed / mismatched certificates. */
  rejectUnauthorized: boolean
  /** SFTP only: expected host key fingerprint, pinned on first connect. */
  hostKeyFingerprint?: string
  createdAt: number
  lastUsedAt?: number
}

/** What the renderer sees: same as SiteConfig minus secrets, plus a flag. */
export type SiteSummary = Omit<SiteConfig, 'password' | 'passphrase'> & {
  hasStoredPassword: boolean
  hasStoredPassphrase: boolean
}

export type EntryType = 'file' | 'dir' | 'link'

export interface FileEntry {
  name: string
  type: EntryType
  size: number
  /** Epoch ms, or null when the server does not report it. */
  modifiedAt: number | null
  /** Unix-style rwx string when available. */
  permissions: string | null
  /** Resolved target for symlinks, when the adapter can cheaply provide it. */
  linkTarget?: string
}

export interface Listing {
  path: string
  entries: FileEntry[]
}

export interface SessionInfo {
  sessionId: string
  siteId: string
  name: string
  protocol: Protocol
  host: string
  port: number
  user: string
  cwd: string
  connectedAt: number
}

export type TransferDirection = 'upload' | 'download'

export type TransferStatus = 'pending' | 'active' | 'done' | 'error' | 'cancelled'

export interface TransferItem {
  id: string
  sessionId: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  /** Display name (basename). */
  name: string
  /** Total bytes, or null while still unknown. */
  size: number | null
  /** Source mtime in epoch ms, or null when the side could not report one. */
  sourceModifiedAt: number | null
  transferred: number
  status: TransferStatus
  error?: string
  startedAt?: number
  finishedAt?: number
  /** Bytes/sec, smoothed. Only meaningful while active. */
  speed: number
}

export interface VersionSyncResult {
  direction: 'upload' | 'download'
  queued: number
  unchanged: number
  ignored: number
  createdDirectories: number
}

/** Read-only version comparison used to preview what a sync button will send. */
export interface VersionSyncPreview {
  direction: 'upload' | 'download'
  /** Source-root entries allowed by .ftpignore; shown as initial blue rows. */
  included: string[]
  /** Source-side paths, relative to the currently opened sync root. */
  files: string[]
  /** Directories to create, plus every ancestor containing a transferred item. */
  directories: string[]
  unchanged: number
  ignored: number
}

export interface VersionSyncPreviewProgress {
  requestId: string
  preview: VersionSyncPreview
}

export interface SshTerminalState {
  sessionId: string
  status: 'connecting' | 'connected' | 'closed' | 'error'
  message?: string
}

export interface GitRepositoryInfo {
  root: string
  branch: string
  commit: string
  remote: string | null
  /** `origin` normalised to something a browser can open, or null. */
  webUrl: string | null
  changedFiles: number
  /** Short SHA of the remote branch head; null when it could not be read. */
  remoteCommit: string | null
  /** The remote has commits this checkout does not. */
  updateAvailable: boolean
}

export type LogLevel = 'info' | 'send' | 'recv' | 'error' | 'warn'

export interface LogLine {
  id: number
  sessionId: string | null
  level: LogLevel
  text: string
  at: number
}

/**
 * Overwrite policy applied when a transfer target already exists.
 *
 * The last three are conditional: they compare source and target and resolve to
 * either `overwrite` or `skip` without asking. When the data needed for the
 * comparison is missing (a server that does not answer `MDTM`, a listing with
 * no size), they fall back to transferring — a redundant copy is recoverable,
 * a silently skipped file is not.
 */
export type ConflictPolicy =
  | 'ask'
  | 'overwrite'
  | 'skip'
  | 'resume'
  | 'size-differs'
  | 'newer'
  | 'size-or-newer'

/** Timestamps from FTP `MDTM` land on whole seconds, and FAT rounds to two.
 *  Anything inside this window counts as "same moment", not "newer". */
export const MTIME_TOLERANCE_MS = 2000

/** What a single conflict may be resolved to. `ask` is a policy, not an action. */
export type ConflictAction = 'overwrite' | 'skip' | 'resume' | 'rename'

/** Emitted by the queue when policy is `ask` and it needs a decision. */
export interface ConflictRequest {
  requestId: string
  itemId: string
  name: string
  direction: TransferDirection
  targetPath: string
  /** -1 when the source size is unknown. */
  sourceSize: number
  sourceModifiedAt: number | null
  targetSize: number
  targetModifiedAt: number | null
}

export interface ConflictResolution {
  /** Что сделать именно с этим файлом. */
  action: ConflictAction
  applyToAll: boolean
  /**
   * Правило для остальных файлов, когда `applyToAll`. Без него на остальные
   * распространяется само действие — как было раньше. С ним можно ответить
   * «дальше решай по размеру или дате», не открывая настройки.
   */
  rule?: ConflictPolicy
}

export interface AppSettings {
  /** Язык интерфейса; хранилище — единственный источник истины для обоих процессов. */
  language: Language
  theme: 'dark' | 'light' | 'system'
  showHiddenFiles: boolean
  conflictPolicy: ConflictPolicy
  concurrentTransfers: number
  confirmDelete: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'ru',
  theme: 'dark',
  showHiddenFiles: false,
  conflictPolicy: 'ask',
  concurrentTransfers: 3,
  confirmDelete: true
}

/** Uniform failure shape crossing IPC — Error objects do not survive structured clone well. */
export interface IpcFailure {
  ok: false
  error: string
  code?: string
}

export type IpcResult<T> = ({ ok: true } & { value: T }) | IpcFailure

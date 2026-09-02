import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  ConflictRequest,
  ConflictResolution,
  FileEntry,
  GitRepositoryInfo,
  IpcResult,
  LogLine,
  QuickCommand,
  SessionInfo,
  SiteConfig,
  SiteSummary,
  SshTerminalState,
  TransferItem,
  VersionSyncPreview,
  VersionSyncPreviewProgress,
  VersionSyncResult
} from '@shared/types'

/**
 * Main returns `{ ok, value }` / `{ ok, error }` so failures survive the bridge
 * intact. Rethrow here as a real Error, so renderer code can use plain
 * try/catch and still see the server's own wording.
 */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (result.ok) return result.value
  const error = new Error(result.error)
  if (result.code) (error as NodeJS.ErrnoException).code = result.code
  throw error
}

/** Subscribe helper that hands back an unsubscribe function for React effects. */
function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  app: {
    getSettings: () => call<AppSettings>('app:settings:get'),
    saveSettings: (patch: Partial<AppSettings>) => call<AppSettings>('app:settings:save', patch),
    encryptionAvailable: () => call<boolean>('app:encryption-available'),
    gitInfo: () => call<GitRepositoryInfo | null>('app:git-info'),
    openExternal: (url: string) => call<void>('app:open-external', url)
  },
  sites: {
    list: () => call<SiteSummary[]>('sites:list'),
    save: (input: Partial<SiteConfig> & { name: string; host: string }) =>
      call<SiteSummary>('sites:save', input),
    remove: (id: string) => call<void>('sites:delete', id),
    clearSecret: (id: string, which: 'password' | 'passphrase') =>
      call<void>('sites:clear-secret', id, which),
    saveQuickCommands: (id: string, commands: QuickCommand[]) =>
      call<SiteSummary>('sites:quick-commands', id, commands)
  },
  session: {
    list: () => call<SessionInfo[]>('session:list'),
    connect: (siteId: string, overrides?: { password?: string; passphrase?: string }) =>
      call<SessionInfo>('session:connect', siteId, overrides),
    disconnect: (sessionId: string) => call<void>('session:disconnect', sessionId),
    listDir: (sessionId: string, path: string) =>
      call<{ path: string; entries: FileEntry[] }>('session:listdir', sessionId, path),
    mkdir: (sessionId: string, path: string) => call<void>('session:mkdir', sessionId, path),
    rename: (sessionId: string, from: string, to: string) =>
      call<void>('session:rename', sessionId, from, to),
    remove: (sessionId: string, path: string, isDir: boolean) =>
      call<void>('session:remove', sessionId, path, isDir),
    parentOf: (path: string) => call<string>('session:parent', path)
  },
  local: {
    list: (dir: string) => call<FileEntry[]>('local:list', dir),
    home: () => call<string>('local:home'),
    drives: () => call<string[]>('local:drives'),
    parentOf: (dir: string) => call<string>('local:parent', dir),
    join: (dir: string, name: string) => call<string>('local:join', dir, name),
    mkdir: (dir: string, name: string) => call<void>('local:mkdir', dir, name),
    rename: (dir: string, from: string, to: string) => call<void>('local:rename', dir, from, to),
    remove: (path: string) => call<void>('local:remove', path),
    reveal: (path: string) => call<void>('local:reveal', path),
    open: (path: string) => call<void>('local:open', path)
  },
  dialog: {
    directory: (title: string, defaultPath?: string) =>
      call<string | null>('dialog:directory', title, defaultPath),
    files: (title: string, defaultPath?: string) =>
      call<string[]>('dialog:files', title, defaultPath),
    privateKey: () => call<string | null>('dialog:private-key'),
    confirm: (message: string, detail: string, confirmLabel: string) =>
      call<boolean>('dialog:confirm', message, detail, confirmLabel)
  },
  queue: {
    snapshot: () => call<TransferItem[]>('queue:snapshot'),
    download: (
      requests: {
        sessionId: string
        remotePath: string
        localDir: string
        isDir: boolean
        size: number
        modifiedAt: number | null
      }[]
    ) => call<void>('queue:download', requests),
    upload: (requests: { sessionId: string; localPath: string; remoteDir: string }[]) =>
      call<void>('queue:upload', requests),
    previewToServer: (sessionId: string, localRoot: string, remoteRoot: string, requestId: string) =>
      call<VersionSyncPreview>('queue:preview-to-server', sessionId, localRoot, remoteRoot, requestId),
    previewFromServer: (sessionId: string, localRoot: string, remoteRoot: string, requestId: string) =>
      call<VersionSyncPreview>('queue:preview-from-server', sessionId, localRoot, remoteRoot, requestId),
    cancelPreview: (sessionId: string) => call<void>('queue:preview-cancel', sessionId),
    syncToServer: (sessionId: string, localRoot: string, remoteRoot: string) =>
      call<VersionSyncResult>('queue:sync-to-server', sessionId, localRoot, remoteRoot),
    syncFromServer: (sessionId: string, localRoot: string, remoteRoot: string) =>
      call<VersionSyncResult>('queue:sync-from-server', sessionId, localRoot, remoteRoot),
    cancel: (itemId: string) => call<void>('queue:cancel', itemId),
    cancelAll: (sessionId?: string) => call<void>('queue:cancel-all', sessionId),
    retry: (itemId: string) => call<void>('queue:retry', itemId),
    clear: () => call<void>('queue:clear'),
    resolveConflict: (requestId: string, resolution: ConflictResolution) =>
      call<void>('queue:resolve-conflict', requestId, resolution)
  },
  ssh: {
    open: (sessionId: string, columns: number, rows: number) =>
      call<void>('ssh:open', sessionId, columns, rows),
    write: (sessionId: string, data: string) => call<void>('ssh:write', sessionId, data),
    resize: (sessionId: string, columns: number, rows: number) =>
      call<void>('ssh:resize', sessionId, columns, rows),
    close: (sessionId: string) => call<void>('ssh:close', sessionId)
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text: string) => clipboard.writeText(text)
  },
  events: {
    onLog: (handler: (line: LogLine) => void) => on<LogLine>('log:line', handler),
    onQueue: (handler: (items: TransferItem[]) => void) => on<TransferItem[]>('queue:update', handler),
    onConflict: (handler: (request: ConflictRequest) => void) =>
      on<ConflictRequest>('queue:conflict', handler),
    onSyncPreview: (handler: (payload: VersionSyncPreviewProgress) => void) =>
      on<VersionSyncPreviewProgress>('queue:preview-progress', handler),
    onSessionClosed: (handler: (payload: { sessionId: string }) => void) =>
      on<{ sessionId: string }>('session:closed', handler),
    onLocalFolderDate: (
      handler: (payload: { path: string; name: string; modifiedAt: number }) => void
    ) => on<{ path: string; name: string; modifiedAt: number }>('local:folder-date', handler),
    onRemoteFolderDate: (
      handler: (payload: {
        sessionId: string
        path: string
        name: string
        modifiedAt: number
      }) => void
    ) =>
      on<{ sessionId: string; path: string; name: string; modifiedAt: number }>(
        'session:folder-date',
        handler
      ),
    onSshData: (handler: (payload: { sessionId: string; data: string }) => void) =>
      on<{ sessionId: string; data: string }>('ssh:data', handler),
    onSshState: (handler: (payload: SshTerminalState) => void) =>
      on<SshTerminalState>('ssh:state', handler)
  },
  /**
   * Electron 32 removed `File.path`, so a dropped OS file's real path can only
   * be recovered here in the preload context.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  platform: process.platform
}

export type KreOsApi = typeof api

contextBridge.exposeInMainWorld('kreos', api)

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { t } from '../shared/i18n'
import type {
  AppSettings,
  ConflictResolution,
  IpcResult,
  QuickCommand,
  SiteConfig
} from '@shared/types'
import {
  listDrives,
  listLocal,
  localHome,
  makeLocalDir,
  newestLocalFileMtime,
  parentOf,
  removeLocal,
  renameLocal,
  safeLocalChild
} from './localfs'
import { rpath } from './protocols/adapter'
import { TransferQueue } from './queue'
import { SessionManager } from './session'
import { SshTerminalManager } from './ssh-terminal'
import { Store } from './store'
import { readGitInfo } from './git-info'

/**
 * Every handler returns `IpcResult` rather than throwing across the bridge:
 * Electron stringifies rejected IPC errors into an unreadable wrapper, and the
 * UI needs the original server message ("550 Permission denied") verbatim.
 */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      const value = await fn(...(args as never[]))
      return { ok: true, value }
    } catch (err) {
      const error = err as NodeJS.ErrnoException
      return { ok: false, error: error?.message ?? String(err), code: error?.code }
    }
  })
}

export interface Services {
  store: Store
  sessions: SessionManager
  terminals: SshTerminalManager
  queue: TransferQueue
  getWindow: () => BrowserWindow | null
}

export function registerIpc(services: Services): void {
  const { store, sessions, terminals, queue, getWindow } = services
  let localFolderDateScan = 0

  // ------------------------------------------------------------------- app
  handle('app:settings:get', () => store.getSettings())
  handle('app:settings:save', (patch: Partial<AppSettings>) => store.saveSettings(patch))
  handle('app:encryption-available', () => store.isEncryptionAvailable())
  handle('app:git-info', () => readGitInfo())
  handle('app:open-external', async (url: string) => {
    // Адрес приходит из конфигурации git, то есть из файла на диске.
    // Разрешаем только веб-схемы, чтобы file: или подобное не открылось.
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(t('Разрешены только ссылки http и https'))
    }
    await shell.openExternal(parsed.toString())
  })

  // ----------------------------------------------------------------- sites
  handle('sites:list', () => store.listSites())
  handle('sites:save', (input: Partial<SiteConfig> & { name: string; host: string }) =>
    store.saveSite(input)
  )
  handle('sites:delete', (id: string) => store.deleteSite(id))
  handle('sites:clear-secret', (id: string, which: 'password' | 'passphrase') =>
    store.clearSecret(id, which)
  )
  handle('sites:quick-commands', (id: string, commands: QuickCommand[]) =>
    store.saveQuickCommands(id, commands)
  )

  // --------------------------------------------------------------- session
  handle('session:list', () => sessions.list())
  handle('session:connect', (siteId: string, overrides?: { password?: string; passphrase?: string }) =>
    sessions.connect(siteId, overrides)
  )
  handle('session:disconnect', async (sessionId: string) => {
    queue.onSessionClosed(sessionId)
    terminals.close(sessionId)
    await sessions.disconnect(sessionId)
  })
  handle('session:listdir', (sessionId: string, path: string) => sessions.listDir(sessionId, path))
  handle('session:mkdir', (sessionId: string, path: string) => sessions.mkdir(sessionId, path))
  handle('session:rename', (sessionId: string, from: string, to: string) =>
    sessions.rename(sessionId, from, to)
  )
  handle('session:remove', (sessionId: string, path: string, isDir: boolean) =>
    sessions.remove(sessionId, path, isDir)
  )
  handle('session:parent', (path: string) => rpath.dirname(path))

  // ----------------------------------------------------------------- local
  handle('local:list', async (dir: string) => {
    const scan = ++localFolderDateScan
    const entries = await listLocal(dir)
    void (async () => {
      for (const folder of entries.filter((entry) => entry.type === 'dir')) {
        await new Promise((resolve) => setTimeout(resolve, 8))
        if (scan !== localFolderDateScan) return
        let modifiedAt: number | null = null
        try {
          modifiedAt = await newestLocalFileMtime(safeLocalChild(dir, folder.name))
        } catch {
          /* The visible listing remains valid even if one folder is unreadable. */
        }
        if (modifiedAt === null || scan !== localFolderDateScan) continue
        const win = getWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('local:folder-date', {
            path: dir,
            name: folder.name,
            modifiedAt
          })
        }
      }
    })()
    return entries
  })
  handle('local:home', () => localHome())
  handle('local:drives', () => listDrives())
  handle('local:parent', (dir: string) => parentOf(dir))
  handle('local:join', (dir: string, name: string) => safeLocalChild(dir, name))
  handle('local:mkdir', (dir: string, name: string) => makeLocalDir(safeLocalChild(dir, name)))
  handle('local:rename', (dir: string, from: string, to: string) =>
    renameLocal(safeLocalChild(dir, from), safeLocalChild(dir, to))
  )
  handle('local:remove', (path: string) => removeLocal(path))
  handle('local:reveal', (path: string) => {
    shell.showItemInFolder(path)
  })
  handle('local:open', async (path: string) => {
    const problem = await shell.openPath(path)
    if (problem) throw new Error(problem)
  })

  // --------------------------------------------------------------- dialogs
  handle('dialog:directory', async (title: string, defaultPath?: string) => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title,
          defaultPath,
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ title, defaultPath, properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('dialog:files', async (title: string, defaultPath?: string) => {
    const win = getWindow()
    const options: Electron.OpenDialogOptions = {
      title,
      defaultPath,
      properties: ['openFile', 'multiSelections']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  handle('dialog:private-key', async () => {
    const win = getWindow()
    const options: Electron.OpenDialogOptions = {
      title: t('Выберите приватный SSH-ключ'),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: t('Приватные ключи'), extensions: ['pem', 'key', 'ppk', 'openssh'] },
        { name: t('Все файлы'), extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })

  handle('dialog:confirm', async (message: string, detail: string, confirmLabel: string) => {
    const win = getWindow()
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [confirmLabel, t('Отмена')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message,
      detail
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    return result.response === 0
  })

  // ------------------------------------------------------------ SSH terminal
  handle('ssh:open', (sessionId: string, columns: number, rows: number) =>
    terminals.open(sessionId, columns, rows)
  )
  handle('ssh:write', (sessionId: string, data: string) => terminals.write(sessionId, data))
  handle('ssh:resize', (sessionId: string, columns: number, rows: number) =>
    terminals.resize(sessionId, columns, rows)
  )
  handle('ssh:close', (sessionId: string) => terminals.close(sessionId))

  // ----------------------------------------------------------------- queue
  handle('queue:snapshot', () => queue.snapshot())
  handle(
    'queue:download',
    (
      requests: {
        sessionId: string
        remotePath: string
        localDir: string
        isDir: boolean
        size: number
        modifiedAt: number | null
      }[]
    ) => queue.enqueueDownloads(requests)
  )
  handle('queue:upload', (requests: { sessionId: string; localPath: string; remoteDir: string }[]) =>
    queue.enqueueUploads(requests)
  )
  handle('queue:preview-to-server', (sessionId: string, localRoot: string, remoteRoot: string, requestId: string) =>
    queue.previewToRemote(sessionId, localRoot, remoteRoot, requestId)
  )
  handle('queue:preview-from-server', (sessionId: string, localRoot: string, remoteRoot: string, requestId: string) =>
    queue.previewFromRemote(sessionId, localRoot, remoteRoot, requestId)
  )
  handle('queue:preview-cancel', (sessionId: string) => {
    queue.cancelPreview(sessionId)
  })
  handle('queue:sync-to-server', (sessionId: string, localRoot: string, remoteRoot: string) =>
    queue.syncToRemote(sessionId, localRoot, remoteRoot)
  )
  handle('queue:sync-from-server', (sessionId: string, localRoot: string, remoteRoot: string) =>
    queue.syncFromRemote(sessionId, localRoot, remoteRoot)
  )
  handle('queue:cancel', (itemId: string) => {
    queue.cancel(itemId)
  })
  handle('queue:cancel-all', (sessionId?: string) => {
    queue.cancelAll(sessionId)
  })
  handle('queue:retry', (itemId: string) => {
    queue.retry(itemId)
  })
  handle('queue:clear', () => {
    queue.clearFinished()
  })
  handle('queue:resolve-conflict', (requestId: string, resolution: ConflictResolution) => {
    queue.resolveConflict(requestId, resolution)
  })
}

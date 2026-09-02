import { join } from 'node:path'
import { t } from '../shared/i18n'
import { app, BrowserWindow, shell } from 'electron'
import { registerIpc } from './ipc'
import { TransferQueue } from './queue'
import { SessionManager } from './session'
import { SshTerminalManager } from './ssh-terminal'
import { Store } from './store'

let mainWindow: BrowserWindow | null = null

// Предупреждения хранилища идут в тот же журнал, что и протокол, — иначе
// проблема с секретом всплывает только как невнятная ошибка входа.
const store = new Store(undefined, (message) => sessions.log(null, 'warn', message))

/** Fan out main-process events to the renderer; a no-op before the window exists. */
function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

const sessions = new SessionManager(store, broadcast)
const terminals = new SshTerminalManager(sessions, store, broadcast)
const queue = new TransferQueue(
  sessions,
  broadcast,
  () => store.getSettings().conflictPolicy,
  () => store.getSettings().concurrentTransfers
)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1319',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    // Native window buttons stay, but the strip beside them is ours to draw in.
    titleBarOverlay: { color: '#0f1319', symbolColor: '#8b97a8', height: 38 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // A window that never appears is the worst failure mode there is: if first
  // paint never lands, show it anyway so the problem is visible on screen
  // rather than as a missing window.
  const contents = mainWindow.webContents
  contents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show()
  })
  let loadRetries = 0
  contents.on('did-fail-load', (_event, code, description, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    // In dev, Electron can outrun Vite's first listen; retry a few times before
    // giving up rather than parking on an error page.
    if (devServer && loadRetries < 10) {
      loadRetries++
      setTimeout(() => void mainWindow?.loadURL(devServer), 400)
      return
    }
    console.error(t('[renderer] загрузка не удалась ({0} {1}): {2}', code, description, url))
    mainWindow?.show()
  })
  contents.on('preload-error', (_event, preloadPath, error) => {
    console.error(t('[preload] ошибка в {0}:', preloadPath), error)
  })
  contents.on('render-process-gone', (_event, details) => {
    console.error(t('[renderer] процесс завершился:'), details.reason)
  })
  contents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['log', 'warn', 'error', 'debug'][level] ?? 'log'
    console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`)
  })

  // Nothing in this app should ever navigate away or spawn a second window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void mainWindow.loadURL(devServer)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await store.load()
  registerIpc({ store, sessions, terminals, queue, getWindow: () => mainWindow })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Close control sockets politely so servers do not keep half-open sessions.
app.on('before-quit', () => {
  terminals.closeAll()
  void sessions.disconnectAll()
})

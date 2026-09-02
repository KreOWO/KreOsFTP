import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { setLanguage, t, plural } from '../shared/i18n'
import type {
  PointerEvent as ReactPointerEvent,
  ReactElement,
  WheelEvent as ReactWheelEvent
} from 'react'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ConflictAction,
  type ConflictRequest,
  type FileEntry,
  type GitRepositoryInfo,
  type LogLine,
  type SessionInfo,
  type SiteSummary,
  type TransferItem,
  type VersionSyncPreview
} from '@shared/types'
import { useScrollEdges } from './useScrollEdges'
import type { DroppedTransfer } from './dnd'
import {
  ConflictDialog,
  DropTargetDialog,
  PromptDialog,
  SettingsDialog,
  SyncConfirmDialog
} from './components/Dialogs'
import { Dock } from './components/Dock'
import { FilePane } from './components/FilePane'
import { ConnectionTooltip } from './components/ConnectionTooltip'
import { ButtonTooltip } from './components/ButtonTooltip'
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternal,
  IconPlug,
  IconSidebar,
  IconSyncDown,
  IconSyncUp,
  IconTerminal,
  IconX,
  IconGithub
} from './components/Icons'
import { Sidebar } from './components/Sidebar'
import { SiteDialog, draftToSite, type SiteDraft } from './components/SiteDialog'
import { SshTerminal } from './components/SshTerminal'

interface PaneData {
  path: string
  entries: FileEntry[]
  loading: boolean
  error: string | null
  selection: string[]
}

const EMPTY_PANE: PaneData = { path: '', entries: [], loading: false, error: null, selection: [] }

interface PromptState {
  title: string
  subtitle?: string
  label: string
  initialValue?: string
  confirmLabel?: string
  password?: boolean
  onSubmit: (value: string) => Promise<void>
}

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface SyncPreviewState {
  direction: 'upload' | 'download'
  candidateNames: string[]
  names: string[]
  loading: boolean
}

interface SyncPreviewCache {
  key: string
  token: string
  sessionId: string
  state: SyncPreviewState
}

const MAX_LOG_LINES = 3000

/** Remote paths are POSIX regardless of the local platform. */
function remoteJoinAt(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base.replace(/\/+$/, '')}/${name}`
}

/** Visible rows for a preview rooted at the pane's current directory. */
function topLevelPreviewNames(preview: VersionSyncPreview): string[] {
  const names = new Set<string>()
  for (const relative of [...preview.files, ...preview.directories]) {
    const name = relative.split('/')[0]
    if (name) names.add(name)
  }
  return [...names]
}

function topLevelIncludedNames(preview: VersionSyncPreview): string[] {
  return [...new Set(preview.included.map((relative) => relative.split('/')[0]).filter(Boolean))]
}

export function App(): ReactElement {
  const api = window.kreos

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [gitInfo, setGitInfo] = useState<GitRepositoryInfo | null>(null)
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [sites, setSites] = useState<SiteSummary[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [connectingSiteId, setConnectingSiteId] = useState<string | null>(null)
  /**
   * Последнее закрытое соединение остаётся серой вкладкой: повторное
   * подключение — самое частое действие сразу после разрыва, и ради него не
   * стоит открывать боковую панель.
   */
  const [lastClosed, setLastClosed] = useState<SessionInfo | null>(null)
  const [closedTooltip, setClosedTooltip] = useState<{
    anchor: HTMLElement
    left: number
    top: number
  } | null>(null)
  /** Survives until the next attempt: a toast that vanished left people
   *  staring at an empty pane with no idea what went wrong. */
  const [connectFailure, setConnectFailure] = useState<{
    siteId: string
    name: string
    message: string
  } | null>(null)

  const [local, setLocal] = useState<PaneData>(EMPTY_PANE)
  const [remotePanes, setRemotePanes] = useState<Record<string, PaneData>>({})

  const [transfers, setTransfers] = useState<TransferItem[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [conflict, setConflict] = useState<ConflictRequest | null>(null)

  const [siteDialog, setSiteDialog] = useState<{ site: SiteSummary | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dockHeight, setDockHeight] = useState(210)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [bridgePosition, setBridgePosition] = useState(50)
  const [syncing, setSyncing] = useState<'upload' | 'download' | null>(null)
  const [syncConfirm, setSyncConfirm] = useState<'upload' | 'download' | null>(null)
  const [syncPreview, setSyncPreview] = useState<SyncPreviewState | null>(null)
  const [sshSessionId, setSshSessionId] = useState<string | null>(null)
  const [remoteExplorerShare, setRemoteExplorerShare] = useState(58)
  const [sessionTooltip, setSessionTooltip] = useState<{
    session: SessionInfo
    anchor: HTMLElement
    left: number
    top: number
  } | null>(null)
  /** Drop that landed on a folder row and needs a destination decision. */
  const [pendingDrop, setPendingDrop] = useState<{
    side: 'local' | 'remote'
    transfer: DroppedTransfer
    folderName: string
  } | null>(null)

  const toastSeq = useRef(0)
  const sessionStripRef = useRef<HTMLDivElement>(null)
  useScrollEdges(sessionStripRef)
  /** Событие закрытия приносит только id, а для серой вкладки нужны данные сессии. */
  const sessionsRef = useRef<SessionInfo[]>([])
  const panesRef = useRef<HTMLDivElement>(null)
  const bridgeDragRef = useRef<number | null>(null)
  const remoteStackRef = useRef<HTMLDivElement>(null)
  const remoteSplitDragRef = useRef<number | null>(null)
  const syncPreviewRequestRef = useRef(0)
  const syncPreviewSessionRef = useRef<string | null>(null)
  const syncPreviewTokenRef = useRef<string | null>(null)
  const syncPreviewVisibleTokenRef = useRef<string | null>(null)
  const syncPreviewCacheRef = useRef<SyncPreviewCache | null>(null)

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info'): void => {
    const id = ++toastSeq.current
    setToasts((list) => [...list, { id, text, kind }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500)
  }, [])

  /** Профиль для серой вкладки, либо null — если он удалён или уже переподключён. */
  const ghostTab = useMemo(() => {
    if (!lastClosed) return null
    if (sessions.some((s) => s.siteId === lastClosed.siteId)) return null
    return sites.find((s) => s.id === lastClosed.siteId) ?? null
  }, [lastClosed, sessions, sites])

  // Зеркало для обработчика закрытия: он живёт в подписке и не видит свежий стейт.
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  // До отрисовки детей: t() читает модульную переменную, а эффект
  // выполнился бы уже после кадра — интерфейс моргнул бы прошлым языком.
  setLanguage(settings.language)

  const remote = activeSessionId ? (remotePanes[activeSessionId] ?? EMPTY_PANE) : EMPTY_PANE
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) ?? null

  /* ------------------------------------------------------------- bootstrapping */

  useEffect(() => {
    void (async () => {
      const [loadedSettings, loadedSites, canEncrypt, home, repository] = await Promise.all([
        api.app.getSettings(),
        api.sites.list(),
        api.app.encryptionAvailable(),
        api.local.home(),
        api.app.gitInfo()
      ])
      setSettings(loadedSettings)
      setSites(loadedSites)
      setEncryptionAvailable(canEncrypt)
      setGitInfo(repository)
      void loadLocal(home)
    })()
    // Bootstrap runs once; loadLocal is stable enough for this single call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Theme follows the setting, with `system` deferring to the OS preference.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      const theme = settings.theme === 'system' ? (media.matches ? 'light' : 'dark') : settings.theme
      document.documentElement.setAttribute('data-theme', theme)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings.theme])

  useEffect(() => {
    const offLog = api.events.onLog((line) =>
      setLogs((list) => {
        const next = [...list, line]
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
      })
    )
    const offQueue = api.events.onQueue(setTransfers)
    const offConflict = api.events.onConflict(setConflict)
    const offSyncPreview = api.events.onSyncPreview(({ requestId, preview }) => {
      if (syncPreviewTokenRef.current !== requestId) return
      const state: SyncPreviewState = {
        direction: preview.direction,
        candidateNames: topLevelIncludedNames(preview),
        names: topLevelPreviewNames(preview),
        loading: true
      }
      const cached = syncPreviewCacheRef.current
      if (cached?.token === requestId) cached.state = state
      if (syncPreviewVisibleTokenRef.current === requestId) setSyncPreview(state)
    })
    const offLocalFolderDate = api.events.onLocalFolderDate(({ path, name, modifiedAt }) => {
      setLocal((pane) =>
        pane.path !== path
          ? pane
          : {
              ...pane,
              entries: pane.entries.map((entry) =>
                entry.name === name && entry.type === 'dir' ? { ...entry, modifiedAt } : entry
              )
            }
      )
    })
    const offRemoteFolderDate = api.events.onRemoteFolderDate(
      ({ sessionId, path, name, modifiedAt }) => {
        setRemotePanes((panes) => {
          const pane = panes[sessionId]
          if (!pane || pane.path !== path) return panes
          return {
            ...panes,
            [sessionId]: {
              ...pane,
              entries: pane.entries.map((entry) =>
                entry.name === name && entry.type === 'dir' ? { ...entry, modifiedAt } : entry
              )
            }
          }
        })
      }
    )
    const offClosed = api.events.onSessionClosed(({ sessionId }) => {
      const closing = sessionsRef.current.find((s) => s.sessionId === sessionId)
      if (closing) setLastClosed(closing)
      setSessions((list) => list.filter((s) => s.sessionId !== sessionId))
      setRemotePanes((panes) => {
        const next = { ...panes }
        delete next[sessionId]
        return next
      })
      setActiveSessionId((current) => (current === sessionId ? null : current))
      setSshSessionId((current) => (current === sessionId ? null : current))
    })
    return () => {
      offLog()
      offQueue()
      offConflict()
      offSyncPreview()
      offLocalFolderDate()
      offRemoteFolderDate()
      offClosed()
    }
  }, [api])

  // Electron would otherwise navigate the window to a dropped file.
  useEffect(() => {
    const swallow = (e: Event): void => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  /* --------------------------------------------------------------- pane loading */

  const loadLocal = useCallback(
    async (path: string): Promise<void> => {
      setLocal((p) => ({ ...p, loading: true, error: null }))
      try {
        const entries = await api.local.list(path)
        setLocal({ path, entries, loading: false, error: null, selection: [] })
      } catch (err) {
        setLocal((p) => ({ ...p, loading: false, error: (err as Error).message }))
      }
    },
    [api]
  )

  const loadRemote = useCallback(
    async (sessionId: string, path: string): Promise<void> => {
      setRemotePanes((panes) => ({
        ...panes,
        [sessionId]: { ...(panes[sessionId] ?? EMPTY_PANE), loading: true, error: null }
      }))
      try {
        const listing = await api.session.listDir(sessionId, path)
        setRemotePanes((panes) => ({
          ...panes,
          [sessionId]: {
            path: listing.path,
            entries: listing.entries,
            loading: false,
            error: null,
            selection: []
          }
        }))
      } catch (err) {
        setRemotePanes((panes) => ({
          ...panes,
          [sessionId]: {
            ...(panes[sessionId] ?? EMPTY_PANE),
            loading: false,
            error: (err as Error).message
          }
        }))
      }
    },
    [api]
  )

  const refreshRemote = useCallback((): void => {
    if (activeSessionId) void loadRemote(activeSessionId, remote.path)
  }, [activeSessionId, remote.path, loadRemote])

  const refreshLocal = useCallback((): void => {
    void loadLocal(local.path)
  }, [local.path, loadLocal])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F5') {
        e.preventDefault()
        refreshLocal()
        refreshRemote()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refreshLocal, refreshRemote])

  /* ------------------------------------------------------------------ connecting */

  const openSession = useCallback(
    async (siteId: string, overrides?: { password?: string; passphrase?: string }): Promise<void> => {
      setConnectingSiteId(siteId)
      setConnectFailure(null)
      try {
        const info = await api.session.connect(siteId, overrides)
        setSessions((list) => [...list.filter((s) => s.sessionId !== info.sessionId), info])
        setLastClosed((closed) => (closed && closed.siteId === info.siteId ? null : closed))
        setActiveSessionId(info.sessionId)
        setRemotePanes((panes) => ({ ...panes, [info.sessionId]: { ...EMPTY_PANE, path: info.cwd } }))
        await loadRemote(info.sessionId, info.cwd)
        setSites(await api.sites.list())

        const site = sites.find((s) => s.id === siteId)
        if (site?.localDir) void loadLocal(site.localDir)
        notify(t('Подключено: {0}', info.name))
      } finally {
        setConnectingSiteId(null)
      }
    },
    [api, loadRemote, loadLocal, notify, sites]
  )

  const connect = useCallback(
    async (site: SiteSummary): Promise<void> => {
      const needsPassword = site.authMode === 'password' && !site.hasStoredPassword
      if (needsPassword) {
        setPrompt({
          title: t('Пароль для {0}', site.name),
          subtitle: `${site.user || t('анонимно')}@${site.host}:${site.port}`,
          label: t('Пароль'),
          password: true,
          confirmLabel: t('Подключиться'),
          onSubmit: async (password) => {
            setPrompt(null)
            try {
              await openSession(site.id, { password })
            } catch (err) {
              const message = (err as Error).message
              setConnectFailure({ siteId: site.id, name: site.name, message })
              notify(message, 'error')
            }
          }
        })
        return
      }
      try {
        await openSession(site.id)
      } catch (err) {
        const message = (err as Error).message
        setConnectFailure({ siteId: site.id, name: site.name, message })
        notify(message, 'error')
      }
    },
    [openSession, notify]
  )

  /** Retry with a freshly typed password, bypassing whatever is stored. */
  const retryWithPassword = useCallback(
    (siteId: string, name: string): void => {
      setPrompt({
        title: t('Пароль для {0}', name),
        subtitle: t('Введённый пароль будет использован для этого подключения'),
        label: t('Пароль'),
        password: true,
        confirmLabel: t('Подключиться'),
        onSubmit: async (password) => {
          setPrompt(null)
          try {
            await openSession(siteId, { password })
          } catch (err) {
            const message = (err as Error).message
            setConnectFailure({ siteId, name, message })
            notify(message, 'error')
          }
        }
      })
    },
    [openSession, notify]
  )

  const disconnect = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await api.session.disconnect(sessionId)
      } catch (err) {
        notify((err as Error).message, 'error')
      }
    },
    [api, notify]
  )

  const selectSession = useCallback(
    (sessionId: string): void => {
      setSshSessionId((current) => {
        if (current && current !== sessionId) void api.ssh.close(current).catch(() => undefined)
        return current === sessionId ? current : null
      })
      setActiveSessionId(sessionId)
      const pane = remotePanes[sessionId]
      if (pane && pane.entries.length === 0 && !pane.loading) void loadRemote(sessionId, pane.path)
    },
    [api, remotePanes, loadRemote]
  )

  /* -------------------------------------------------------------------- transfers */

  const upload = useCallback(
    async (entries: FileEntry[]): Promise<void> => {
      if (!activeSessionId || entries.length === 0) return
      const requests = await Promise.all(
        entries.map(async (entry) => ({
          sessionId: activeSessionId,
          localPath: await api.local.join(local.path, entry.name),
          remoteDir: remote.path
        }))
      )
      try {
        await api.queue.upload(requests)
      } catch (err) {
        notify((err as Error).message, 'error')
      }
    },
    [activeSessionId, api, local.path, remote.path, notify]
  )

  const download = useCallback(
    async (entries: FileEntry[]): Promise<void> => {
      if (!activeSessionId || entries.length === 0) return
      try {
        await api.queue.download(
          entries.map((entry) => ({
            sessionId: activeSessionId,
            remotePath: remote.path === '/' ? `/${entry.name}` : `${remote.path}/${entry.name}`,
            localDir: local.path,
            isDir: entry.type === 'dir',
            size: entry.size,
            modifiedAt: entry.modifiedAt
          }))
        )
      } catch (err) {
        notify((err as Error).message, 'error')
      }
    },
    [activeSessionId, api, remote.path, local.path, notify]
  )

  // Refresh the receiving pane once a batch of transfers settles.
  const prevActiveCount = useRef(0)
  useEffect(() => {
    const running = transfers.filter((t) => t.status === 'active' || t.status === 'pending').length
    if (prevActiveCount.current > 0 && running === 0) {
      refreshLocal()
      refreshRemote()
    }
    prevActiveCount.current = running
  }, [transfers, refreshLocal, refreshRemote])

  /* ------------------------------------------------------------- file operations */

  const localSelected = useMemo(
    () => local.entries.filter((e) => local.selection.includes(e.name)),
    [local.entries, local.selection]
  )
  const remoteSelected = useMemo(
    () => remote.entries.filter((e) => remote.selection.includes(e.name)),
    [remote.entries, remote.selection]
  )

  const remoteJoin = (name: string): string => remoteJoinAt(remote.path, name)

  /** Hide hover feedback without interrupting the comparison in progress. */
  const hideSyncPreview = useCallback((): void => {
    syncPreviewVisibleTokenRef.current = null
    setSyncPreview(null)
  }, [])

  /** Invalidate a comparison only when its roots/session really changed or sync starts. */
  const resetSyncPreview = useCallback((): void => {
    syncPreviewRequestRef.current++
    const previewSessionId = syncPreviewSessionRef.current
    syncPreviewSessionRef.current = null
    syncPreviewTokenRef.current = null
    syncPreviewVisibleTokenRef.current = null
    syncPreviewCacheRef.current = null
    if (previewSessionId) void api.queue.cancelPreview(previewSessionId).catch(() => undefined)
    setSyncPreview(null)
  }, [api])

  const beginSyncPreview = useCallback(
    (direction: 'upload' | 'download'): void => {
      if (!activeSessionId || !local.path || !remote.path || syncing) return
      const sessionId = activeSessionId
      const localRoot = local.path
      const remoteRoot = remote.path
      const cacheKey = `${sessionId}\0${direction}\0${localRoot}\0${remoteRoot}`
      const cached = syncPreviewCacheRef.current
      if (cached?.key === cacheKey) {
        syncPreviewVisibleTokenRef.current = cached.token
        setSyncPreview(cached.state)
        return
      }

      const previousSessionId = syncPreviewSessionRef.current
      if (previousSessionId) void api.queue.cancelPreview(previousSessionId).catch(() => undefined)

      const requestId = ++syncPreviewRequestRef.current
      const previewToken = `${sessionId}:${direction}:${requestId}`
      syncPreviewSessionRef.current = sessionId
      syncPreviewTokenRef.current = previewToken
      syncPreviewVisibleTokenRef.current = previewToken
      const initialState: SyncPreviewState = {
        direction,
        candidateNames: [],
        names: [],
        loading: true
      }
      syncPreviewCacheRef.current = {
        key: cacheKey,
        token: previewToken,
        sessionId,
        state: initialState
      }
      setSyncPreview(initialState)

      // Start immediately: the first progress event only reads .ftpignore and
      // paints every allowed source row blue. Green results then arrive in BFS order.
      void (async () => {
        try {
          const preview =
            direction === 'upload'
              ? await api.queue.previewToServer(sessionId, localRoot, remoteRoot, previewToken)
              : await api.queue.previewFromServer(sessionId, localRoot, remoteRoot, previewToken)
          if (syncPreviewRequestRef.current !== requestId) return
          syncPreviewSessionRef.current = null
          syncPreviewTokenRef.current = null
          const finalState: SyncPreviewState = {
            direction,
            candidateNames: topLevelIncludedNames(preview),
            names: topLevelPreviewNames(preview),
            loading: false
          }
          const currentCache = syncPreviewCacheRef.current
          if (currentCache?.token === previewToken) currentCache.state = finalState
          if (syncPreviewVisibleTokenRef.current === previewToken) setSyncPreview(finalState)
        } catch (error) {
          // A hover preview is optional UI feedback; transfer errors are still
          // reported normally after the user confirms an actual sync.
          if (syncPreviewRequestRef.current === requestId) {
            syncPreviewSessionRef.current = null
            syncPreviewTokenRef.current = null
            if (syncPreviewCacheRef.current?.token === previewToken) {
              syncPreviewCacheRef.current = null
            }
            if (syncPreviewVisibleTokenRef.current === previewToken) {
              syncPreviewVisibleTokenRef.current = null
              setSyncPreview(null)
              notify(t('Не удалось рассчитать подсветку: {0}', (error as Error).message), 'error')
            }
          }
        }
      })()
    },
    [activeSessionId, api, local.path, remote.path, syncing, notify]
  )

  useEffect(() => resetSyncPreview, [resetSyncPreview])
  useEffect(() => {
    resetSyncPreview()
  }, [activeSessionId, local.path, remote.path, resetSyncPreview])

  const syncVersion = async (direction: 'upload' | 'download'): Promise<void> => {
    if (!activeSessionId || !local.path || !remote.path || syncing) return
    const toServer = direction === 'upload'
    setSyncing(direction)
    try {
      const result = toServer
        ? await api.queue.syncToServer(activeSessionId, local.path, remote.path)
        : await api.queue.syncFromServer(activeSessionId, local.path, remote.path)
      notify(
        result.queued > 0
          ? t('В очередь добавлено: {0}; без изменений: {1}; исключено: {2}', result.queued, result.unchanged, result.ignored)
          : t('Версии совпадают. Без изменений: {0}; исключено: {1}', result.unchanged, result.ignored)
      )
      if (result.queued === 0 && result.createdDirectories > 0) {
        refreshLocal()
        refreshRemote()
      }
    } catch (err) {
      notify((err as Error).message, 'error')
    } finally {
      setSyncing(null)
    }
  }

  const scrollPaneFromBridge = (
    side: 'local' | 'remote',
    event: ReactWheelEvent<HTMLElement>
  ): void => {
    const body = panesRef.current?.querySelector<HTMLElement>(
      `[data-pane-kind="${side}"] .pane__body`
    )
    if (!body) return
    event.stopPropagation()
    const unit = event.deltaMode === 1 ? 34 : event.deltaMode === 2 ? body.clientHeight : 1
    body.scrollBy({ top: event.deltaY * unit, behavior: 'auto' })
  }

  const moveBridge = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (bridgeDragRef.current === null || bridgeDragRef.current !== event.pointerId) return
    const rect = panesRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const percent = ((event.clientX - rect.left) / rect.width) * 100
    setBridgePosition(Math.max(25, Math.min(75, percent)))
  }

  const toggleSsh = (): void => {
    if (!activeSessionId) return
    setSshSessionId((current) => {
      if (current) {
        void api.ssh.close(current).catch(() => undefined)
        return current === activeSessionId ? null : activeSessionId
      }
      return activeSessionId
    })
  }

  const moveRemoteSplit = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      remoteSplitDragRef.current === null ||
      remoteSplitDragRef.current !== event.pointerId
    ) {
      return
    }
    const rect = remoteStackRef.current?.getBoundingClientRect()
    if (!rect || rect.height <= 0) return
    const percent = ((event.clientY - rect.top) / rect.height) * 100
    setRemoteExplorerShare(Math.max(28, Math.min(76, percent)))
  }

  const stopRemoteSplit = (event: ReactPointerEvent<HTMLDivElement>): void => {
    remoteSplitDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('is-resizing-remote-split')
  }

  const stopBridgeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    bridgeDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('is-resizing-horizontal')
  }

  const askDelete = async (side: 'local' | 'remote', entries: FileEntry[]): Promise<void> => {
    if (entries.length === 0) return
    if (settings.confirmDelete) {
      const names = entries.slice(0, 5).map((e) => e.name).join('\n')
      const more = entries.length > 5 ? t('\n…и ещё {0}', entries.length - 5) : ''
      const ok = await api.dialog.confirm(
        t('Удалить {0} {1}?', entries.length, plural(entries.length, 'объект|объекта|объектов')),
        t('{0}{1}\n\nДействие необратимо.', names, more),
        t('Удалить')
      )
      if (!ok) return
    }
    try {
      for (const entry of entries) {
        if (side === 'local') await api.local.remove(await api.local.join(local.path, entry.name))
        else if (activeSessionId)
          await api.session.remove(activeSessionId, remoteJoin(entry.name), entry.type === 'dir')
      }
      if (side === 'local') refreshLocal()
      else refreshRemote()
    } catch (err) {
      notify((err as Error).message, 'error')
    }
  }

  const askNewFolder = (side: 'local' | 'remote'): void => {
    setPrompt({
      title: t('Новая папка'),
      subtitle: side === 'local' ? local.path : remote.path,
      label: t('Имя папки'),
      initialValue: t('Новая папка'),
      confirmLabel: t('Создать'),
      onSubmit: async (name) => {
        const trimmed = name.trim()
        if (!trimmed) return
        if (side === 'local') {
          await api.local.mkdir(local.path, trimmed)
          refreshLocal()
        } else if (activeSessionId) {
          await api.session.mkdir(activeSessionId, remoteJoin(trimmed))
          refreshRemote()
        }
        setPrompt(null)
      }
    })
  }

  const askRename = (side: 'local' | 'remote', entry: FileEntry): void => {
    setPrompt({
      title: t('Переименовать'),
      subtitle: entry.name,
      label: t('Новое имя'),
      initialValue: entry.name,
      confirmLabel: t('Переименовать'),
      onSubmit: async (name) => {
        const trimmed = name.trim()
        if (!trimmed || trimmed === entry.name) {
          setPrompt(null)
          return
        }
        if (side === 'local') {
          await api.local.rename(local.path, entry.name, trimmed)
          refreshLocal()
        } else if (activeSessionId) {
          await api.session.rename(activeSessionId, remoteJoin(entry.name), remoteJoin(trimmed))
          refreshRemote()
        }
        setPrompt(null)
      }
    })
  }

  /* ----------------------------------------------------------------- site CRUD */

  const saveSite = async (draft: SiteDraft, thenConnect: boolean): Promise<void> => {
    const saved = await api.sites.save(draftToSite(draft))
    // An empty password field means "keep what is stored", so unticking
    // "remember" has to erase the secret explicitly.
    if (!draft.savePassword) {
      if (saved.hasStoredPassword) await api.sites.clearSecret(saved.id, 'password')
      if (saved.hasStoredPassphrase) await api.sites.clearSecret(saved.id, 'passphrase')
    }
    setSites(await api.sites.list())
    setSiteDialog(null)
    if (thenConnect) {
      // A password typed but not saved still has to reach this one connection.
      const overrides =
        draft.savePassword || (!draft.password && !draft.passphrase)
          ? undefined
          : { password: draft.password || undefined, passphrase: draft.passphrase || undefined }
      await openSession(saved.id, overrides)
    }
  }

  const deleteSite = async (site: SiteSummary): Promise<void> => {
    const ok = await api.dialog.confirm(
      t('Удалить профиль «{0}»?', site.name),
      t('{0}:{1}\n\nСохранённый пароль тоже будет удалён.', site.host, site.port),
      t('Удалить')
    )
    if (!ok) return
    await api.sites.remove(site.id)
    setSites(await api.sites.list())
  }

  const changeSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    setSettings((s) => ({ ...s, ...patch }))
    await api.app.saveSettings(patch)
  }

  /* ------------------------------------------------------------------ drag/drop */

  /**
   * Runs a completed drop. `intoFolder` is already resolved by this point — the
   * ambiguous "dropped on a folder row" case is settled by the dialog first.
   */
  const runDrop = useCallback(
    async (side: 'local' | 'remote', transfer: DroppedTransfer, intoFolder: string | null): Promise<void> => {
      if (!activeSessionId) return
      const { payload, osPaths } = transfer

      if (side === 'remote') {
        const remoteDir = intoFolder ? remoteJoinAt(remote.path, intoFolder) : remote.path
        if (osPaths.length > 0) {
          await api.queue
            .upload(osPaths.map((localPath) => ({ sessionId: activeSessionId, localPath, remoteDir })))
            .catch((err: Error) => notify(err.message, 'error'))
          return
        }
        if (!payload) return
        if (payload.source !== 'local' || payload.fromPath !== local.path) {
          notify(t('Отклонено неподтверждённое перетаскивание локальных файлов'), 'error')
          return
        }
        const allowedNames = new Set(local.entries.map((entry) => entry.name))
        if (payload.names.some((name) => !allowedNames.has(name))) {
          notify(t('Список перетаскиваемых файлов устарел или подделан'), 'error')
          return
        }
        const requests = await Promise.all(
          payload.names.map(async (name) => ({
            sessionId: activeSessionId,
            localPath: await api.local.join(payload.fromPath, name),
            remoteDir
          }))
        )
        await api.queue.upload(requests).catch((err: Error) => notify(err.message, 'error'))
        return
      }

      // Сюда попадает только перетаскивание с сервера в локальную панель.
      if (!payload) return
      if (payload.source !== 'remote' || payload.fromPath !== remote.path) {
        notify(t('Отклонено неподтверждённое перетаскивание файлов сервера'), 'error')
        return
      }
      const localDir = intoFolder ? await api.local.join(local.path, intoFolder) : local.path
      const dragged = remote.entries.filter((e) => payload.names.includes(e.name))
      await api.queue
        .download(
          dragged.map((entry) => ({
            sessionId: activeSessionId,
            remotePath: remoteJoinAt(remote.path, entry.name),
            localDir,
            isDir: entry.type === 'dir',
            size: entry.size,
            modifiedAt: entry.modifiedAt
          }))
        )
        .catch((err: Error) => notify(err.message, 'error'))
    },
    [activeSessionId, api, remote.path, remote.entries, local.path, local.entries, notify]
  )

  /** A drop on a folder row is ambiguous, so ask before acting on it. */
  const onDropTransfer = useCallback(
    (side: 'local' | 'remote', transfer: DroppedTransfer): void => {
      if (transfer.intoFolder) {
        setPendingDrop({ side, transfer, folderName: transfer.intoFolder })
        return
      }
      void runDrop(side, transfer, null)
    },
    [runDrop]
  )

  /* ---------------------------------------------------------------------- render */

  const connected = Boolean(activeSession)

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar__brand">
          <span className="titlebar__mark">K</span>
          KreOsFTP
        </span>
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => setSidebarOpen((v) => !v)}
          title={t('Показать/скрыть панель подключений')}
        >
          <IconSidebar />
        </button>
        <div className="titlebar__sessions" ref={sessionStripRef}>
          {sessions.map((session) => (
            <span
              key={session.sessionId}
              className={
                'session-tab' + (session.sessionId === activeSessionId ? ' session-tab--active' : '')
              }
              onClick={() => selectSession(session.sessionId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') selectSession(session.sessionId)
              }}
              onMouseEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setSessionTooltip({
                  session,
                  anchor: event.currentTarget,
                  left: Math.min(rect.left, window.innerWidth - 292),
                  top: rect.bottom + 7
                })
              }}
            >
              <span className="session-tab__dot" />
              <span className="session-tab__label">{session.name}</span>
              <button
                className="session-tab__close"
                onClick={(e) => {
                  e.stopPropagation()
                  void disconnect(session.sessionId)
                }}
                title={t('Отключиться')}
              >
                <IconX size={11} />
              </button>
            </span>
          ))}

          {ghostTab && (
            <span
              className="session-tab session-tab--closed"
              role="button"
              tabIndex={0}
              onClick={() => void connect(ghostTab)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void connect(ghostTab)
              }}
              onMouseEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setClosedTooltip({
                  anchor: event.currentTarget,
                  left: Math.min(rect.left, window.innerWidth - 292),
                  top: rect.bottom + 7
                })
              }}
            >
              <span className="session-tab__dot" />
              <span className="session-tab__label">{lastClosed?.name}</span>
              <button
                className="session-tab__close"
                onClick={(e) => {
                  e.stopPropagation()
                  setLastClosed(null)
                  setClosedTooltip(null)
                }}
                title={t('Убрать из панели')}
              >
                <IconX size={11} />
              </button>
            </span>
          )}
        </div>
        {gitInfo && (
          <button
            className={
              'titlebar__git' +
              (gitInfo.updateAvailable ? ' titlebar__git--update' : '') +
              (gitInfo.changedFiles > 0 ? ' titlebar__git--dirty' : '')
            }
            type="button"
            disabled={!gitInfo.webUrl}
            aria-label={t('Открыть репозиторий проекта на GitHub')}
            data-tooltip={[
              t('Ветка: {0} · коммит {1}', gitInfo.branch, gitInfo.commit),
              gitInfo.changedFiles > 0
                ? t('Незакоммиченных файлов: {0}', gitInfo.changedFiles)
                : t('Рабочая копия чистая'),
              gitInfo.updateAvailable
                ? t('Доступно обновление: на сервере коммит {0}', gitInfo.remoteCommit ?? '')
                : gitInfo.remoteCommit
                  ? t('Обновлений нет')
                  : t('Состояние сервера неизвестно — нет связи или доступа'),
              gitInfo.webUrl ?? t('Адрес репозитория не определён'),
              gitInfo.webUrl ? t('Клик — открыть в браузере') : ''
            ]
              .filter(Boolean)
              .join('\n')}
            onClick={() => {
              if (!gitInfo.webUrl) return
              void api.app
                .openExternal(gitInfo.webUrl)
                .catch((error: Error) => notify(error.message, 'error'))
            }}
          >
            <IconGithub size={14} />
          </button>
        )}
      </header>
      {closedTooltip && ghostTab && (
        <ConnectionTooltip
          anchor={closedTooltip.anchor}
          left={closedTooltip.left}
          top={closedTooltip.top}
          title={ghostTab.name}
          endpoint={`${ghostTab.user ? `${ghostTab.user}@` : ''}${ghostTab.host}:${ghostTab.port}`}
          protocol={ghostTab.protocol.toUpperCase()}
          note={t('Не подключено — нажмите, чтобы подключиться')}
          onClose={() => setClosedTooltip(null)}
        />
      )}

      {sessionTooltip && (
        <ConnectionTooltip
          anchor={sessionTooltip.anchor}
          left={sessionTooltip.left}
          top={sessionTooltip.top}
          title={sessionTooltip.session.name}
          endpoint={`${sessionTooltip.session.user ? `${sessionTooltip.session.user}@` : ''}${sessionTooltip.session.host}:${sessionTooltip.session.port}`}
          protocol={sessionTooltip.session.protocol.toUpperCase()}
          onClose={() => setSessionTooltip(null)}
        />
      )}

      <div className={'workspace' + (sidebarOpen ? '' : ' workspace--collapsed')}>
        {sidebarOpen && (
          <Sidebar
            sites={sites}
            activeSiteId={activeSession?.siteId ?? null}
            busySiteId={connectingSiteId}
            onConnect={(site) => void connect(site)}
            onEdit={(site) => setSiteDialog({ site })}
            onDelete={(site) => void deleteSite(site)}
            onCreate={() => setSiteDialog({ site: null })}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}

        <div className="main-column">
          <div
            className="panes"
            ref={panesRef}
            style={{
              gridTemplateColumns: `minmax(260px, ${bridgePosition}fr) 72px minmax(260px, ${100 - bridgePosition}fr)`
            }}
          >
            <div className="pane-wrap">
              <FilePane
                kind="local"
                dropAccepts={connected ? { fromPane: 'remote' } : undefined}
                onDropTransfer={(t) => onDropTransfer('local', t)}
                title={t('Локально')}
                path={local.path}
                entries={local.entries}
                loading={local.loading}
                error={local.error}
                candidateNames={
                  syncPreview?.direction === 'upload' ? syncPreview.candidateNames : []
                }
                previewNames={syncPreview?.direction === 'upload' ? syncPreview.names : []}
                showHidden={settings.showHiddenFiles}
                selection={local.selection}
                onSelectionChange={(selection) => setLocal((p) => ({ ...p, selection }))}
                onNavigate={(path) => void loadLocal(path)}
                onOpenDir={(entry) =>
                  void api.local.join(local.path, entry.name).then((path) => loadLocal(path))
                }
                onOpenFile={(entry) =>
                  void api.local
                    .join(local.path, entry.name)
                    .then((path) => api.local.open(path))
                    .catch((err: Error) => notify(err.message, 'error'))
                }
                onUp={() => void api.local.parentOf(local.path).then((path) => loadLocal(path))}
                onHome={() => void api.local.home().then((path) => loadLocal(path))}
                onRefresh={refreshLocal}
                onNewFolder={() => askNewFolder('local')}
                onRename={(entry) => askRename('local', entry)}
                onDelete={(entries) => void askDelete('local', entries)}
                onTransfer={(entries) => void upload(entries)}
                toolbarExtra={
                  <>
                    <button
                      className="btn btn--ghost btn--icon"
                      onClick={() => void api.local.reveal(local.path)}
                      title={t('Открыть в проводнике')}
                    >
                      <IconExternal size={13} />
                    </button>
                    <button
                      className="btn btn--ghost"
                      onClick={() =>
                        void api.dialog.directory(t('Выберите папку'), local.path).then((path) => {
                          if (path) void loadLocal(path)
                        })
                      }
                    >
                      
                      {t('Диск…')}
                    </button>
                  </>
                }
              />
            </div>

            <div
              className="bridge"
              onWheelCapture={(event) => {
                const button = (event.target as Element).closest<HTMLButtonElement>(
                  'button[data-scroll-pane]'
                )
                const side = button?.dataset.scrollPane
                if (side === 'local' || side === 'remote') scrollPaneFromBridge(side, event)
              }}
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest('button')) return
                bridgeDragRef.current = event.pointerId
                event.currentTarget.setPointerCapture(event.pointerId)
                document.body.classList.add('is-resizing-horizontal')
              }}
              onPointerMove={moveBridge}
              onPointerUp={stopBridgeMove}
              onPointerCancel={stopBridgeMove}
            >
              <button
                className="bridge__btn"
                onClick={() => void upload(localSelected)}
                data-scroll-pane="local"
                disabled={!connected || localSelected.length === 0}
                data-tooltip={t('Загрузить выделенные файлы на сервер')}
                aria-label={t('Загрузить выделенные файлы на сервер')}
              >
                <IconArrowRight size={16} />
              </button>
              <button
                className={
                  'bridge__btn bridge__btn--sync' +
                  (syncPreview?.direction === 'upload' && syncPreview.loading
                    ? ' bridge__btn--previewing'
                    : '')
                }
                onMouseEnter={() => beginSyncPreview('upload')}
                onMouseLeave={hideSyncPreview}
                data-scroll-pane="local"
                onFocus={() => beginSyncPreview('upload')}
                onBlur={hideSyncPreview}
                onClick={() => {
                  resetSyncPreview()
                  setSyncConfirm('upload')
                }}
                disabled={
                  !connected ||
                  syncing !== null ||
                  transfers.some((item) => item.status === 'active' || item.status === 'pending')
                }
                data-tooltip={t('Обновить сервер с учетом .ftpignore')}
                aria-label={t('Обновить сервер с учетом .ftpignore')}
              >
                <IconSyncUp size={17} />
              </button>
              <button
                className="bridge__remote bridge__remote--ssh"
                onClick={toggleSsh}
                disabled={!connected}
                data-tooltip={t('Открыть SSH-терминал внутри серверной панели')}
                aria-label={t('Открыть SSH-терминал')}
              >
                <IconTerminal size={13} /> SSH
              </button>
              <button
                className={
                  'bridge__btn bridge__btn--sync' +
                  (syncPreview?.direction === 'download' && syncPreview.loading
                    ? ' bridge__btn--previewing'
                    : '')
                }
                onMouseEnter={() => beginSyncPreview('download')}
                onMouseLeave={hideSyncPreview}
                data-scroll-pane="remote"
                onFocus={() => beginSyncPreview('download')}
                onBlur={hideSyncPreview}
                onClick={() => {
                  resetSyncPreview()
                  setSyncConfirm('download')
                }}
                disabled={
                  !connected ||
                  syncing !== null ||
                  transfers.some((item) => item.status === 'active' || item.status === 'pending')
                }
                data-tooltip={t('Обновить локально с учетом .ftpignore')}
                aria-label={t('Обновить локально с учетом .ftpignore')}
              >
                <IconSyncDown size={17} />
              </button>
              <button
                className="bridge__btn"
                onClick={() => void download(remoteSelected)}
                data-scroll-pane="remote"
                disabled={!connected || remoteSelected.length === 0}
                data-tooltip={t('Скачать выделенные файлы с сервера')}
                aria-label={t('Скачать выделенные файлы с сервера')}
              >
                <IconArrowLeft size={16} />
              </button>
            </div>

            <div
              ref={remoteStackRef}
              className={sshSessionId === activeSessionId ? 'remote-stack' : 'pane-wrap'}
              style={
                sshSessionId === activeSessionId
                  ? {
                      gridTemplateRows: `minmax(150px, ${remoteExplorerShare}fr) 8px minmax(130px, ${100 - remoteExplorerShare}fr)`
                    }
                  : undefined
              }
            >
              <FilePane
                kind="remote"
                dropAccepts={connected ? { fromPane: 'local', osFiles: true } : undefined}
                onDropTransfer={(t) => onDropTransfer('remote', t)}
                title={activeSession ? activeSession.name : t('Сервер')}
                path={remote.path}
                entries={remote.entries}
                loading={remote.loading}
                error={remote.error}
                candidateNames={
                  syncPreview?.direction === 'download' ? syncPreview.candidateNames : []
                }
                previewNames={syncPreview?.direction === 'download' ? syncPreview.names : []}
                disabled={!connected}
                showHidden={settings.showHiddenFiles}
                selection={remote.selection}
                onSelectionChange={(selection) =>
                  activeSessionId &&
                  setRemotePanes((panes) => ({
                    ...panes,
                    [activeSessionId]: { ...(panes[activeSessionId] ?? EMPTY_PANE), selection }
                  }))
                }
                onNavigate={(path) => activeSessionId && void loadRemote(activeSessionId, path)}
                onOpenDir={(entry) =>
                  activeSessionId && void loadRemote(activeSessionId, remoteJoin(entry.name))
                }
                onUp={() =>
                  activeSessionId &&
                  void api.session
                    .parentOf(remote.path)
                    .then((path) => loadRemote(activeSessionId, path))
                }
                onHome={() =>
                  activeSessionId && activeSession && void loadRemote(activeSessionId, activeSession.cwd)
                }
                onRefresh={refreshRemote}
                onNewFolder={() => askNewFolder('remote')}
                onRename={(entry) => askRename('remote', entry)}
                onDelete={(entries) => void askDelete('remote', entries)}
                onTransfer={(entries) => void download(entries)}
                toolbarExtra={
                  activeSession ? (
                    <button
                      className="btn btn--ghost"
                      onClick={() => void disconnect(activeSession.sessionId)}
                      title={t('Закрыть соединение')}
                    >
                      
                      {t('Отключиться')}
                    </button>
                  ) : null
                }
                placeholder={
                  connected ? null : connectingSiteId ? (
                    <>
                      <div className="spinner" style={{ margin: '0 auto' }} />
                      <div style={{ marginTop: 12, fontSize: 13 }}>{t('Подключение…')}</div>
                      <div style={{ marginTop: 6 }}>
                        
                        {t('Ожидание ответа сервера.')}
                      </div>
                    </>
                  ) : connectFailure ? (
                    <>
                      <div style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 600 }}>
                        
                        {t('Не удалось подключиться к «{0}»', connectFailure.name)}
                      </div>
                      <div className="pane-error" style={{ textAlign: 'left', maxWidth: 460 }}>
                        {connectFailure.message}
                      </div>
                      <div style={{ marginTop: 2, display: 'flex', gap: 8 }}>
                        <button
                          className="btn btn--primary"
                          onClick={() =>
                            retryWithPassword(connectFailure.siteId, connectFailure.name)
                          }
                        >
                          
                          {t('Ввести пароль заново')}
                        </button>
                        <button
                          className="btn"
                          onClick={() => {
                            const site = sites.find((x) => x.id === connectFailure.siteId)
                            if (site) setSiteDialog({ site })
                          }}
                        >
                          
                          {t('Изменить профиль')}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <IconPlug size={26} />
                      <div style={{ marginTop: 12, fontSize: 13 }}>{t('Нет активного подключения')}</div>
                      <div style={{ marginTop: 6 }}>
                        
                        {t('Выберите сервер слева или')}{' '}
                        <button
                          className="btn btn--ghost"
                          style={{ padding: '2px 6px', color: 'var(--accent)' }}
                          onClick={() => setSiteDialog({ site: null })}
                        >
                          
                          {t('создайте новый профиль')}
                        </button>
                      </div>
                    </>
                  )
                }
              />
              {sshSessionId === activeSessionId && activeSession && (
                <>
                  <div
                    className="remote-stack__resize"
                    role="separator"
                    aria-label={t('Изменить высоту SSH-терминала')}
                    aria-orientation="horizontal"
                    onPointerDown={(event) => {
                      remoteSplitDragRef.current = event.pointerId
                      event.currentTarget.setPointerCapture(event.pointerId)
                      document.body.classList.add('is-resizing-remote-split')
                    }}
                    onPointerMove={moveRemoteSplit}
                    onPointerUp={stopRemoteSplit}
                    onPointerCancel={stopRemoteSplit}
                  />
                  <SshTerminal
                    sessionId={activeSession.sessionId}
                    name={activeSession.name}
                    commands={
                      sites.find((site) => site.id === activeSession.siteId)?.quickCommands ?? []
                    }
                    onCommandsChange={async (commands) => {
                      const updated = await api.sites.saveQuickCommands(
                        activeSession.siteId,
                        commands
                      )
                      setSites((current) =>
                        current.map((site) => (site.id === updated.id ? updated : site))
                      )
                    }}
                    onClose={() => setSshSessionId(null)}
                  />
                </>
              )}
            </div>
          </div>

          <Dock
            transfers={transfers}
            preparingSync={syncing}
            logs={logs}
            sessionFilter={activeSessionId}
            onCancel={(id) => void api.queue.cancel(id)}
            onRetry={(id) => void api.queue.retry(id)}
            onClearFinished={() => void api.queue.clear()}
            onClearLog={() => setLogs([])}
            height={dockHeight}
            onResize={setDockHeight}
          />
        </div>
      </div>

      {siteDialog && (
        <SiteDialog
          site={siteDialog.site}
          encryptionAvailable={encryptionAvailable}
          onCancel={() => setSiteDialog(null)}
          onSave={(draft) => saveSite(draft, false)}
          onSaveAndConnect={(draft) => saveSite(draft, true)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          encryptionAvailable={encryptionAvailable}
          onChange={(patch) => void changeSettings(patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {syncConfirm && (
        <SyncConfirmDialog
          direction={syncConfirm}
          localPath={local.path}
          remotePath={remote.path}
          onCancel={() => setSyncConfirm(null)}
          onConfirm={() => {
            const direction = syncConfirm
            setSyncConfirm(null)
            void syncVersion(direction)
          }}
        />
      )}

      {prompt && (
        <PromptDialog
          title={prompt.title}
          subtitle={prompt.subtitle}
          label={prompt.label}
          initialValue={prompt.initialValue}
          confirmLabel={prompt.confirmLabel}
          password={prompt.password}
          onCancel={() => setPrompt(null)}
          onSubmit={prompt.onSubmit}
        />
      )}

      {pendingDrop && (
        <DropTargetDialog
          folderName={pendingDrop.folderName}
          currentPath={pendingDrop.side === 'remote' ? remote.path : local.path}
          itemCount={
            pendingDrop.transfer.payload?.names.length ?? pendingDrop.transfer.osPaths.length
          }
          onCancel={() => setPendingDrop(null)}
          onChoose={(into) => {
            const { side, transfer, folderName } = pendingDrop
            setPendingDrop(null)
            void runDrop(side, transfer, into === 'folder' ? folderName : null)
          }}
        />
      )}

      {conflict && (
        <ConflictDialog
          request={conflict}
          onResolve={(action: ConflictAction, applyToAll, rule) => {
            void api.queue.resolveConflict(conflict.requestId, { action, applyToAll, rule })
            setConflict(null)
          }}
        />
      )}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={'toast' + (toast.kind === 'error' ? ' toast--error' : '')}>
            <span className="toast__icon">{toast.kind === 'error' ? '⚠' : '✓'}</span>
            <span className="toast__text">{toast.text}</span>
          </div>
        ))}
      </div>
      <ButtonTooltip />
    </div>
  )
}

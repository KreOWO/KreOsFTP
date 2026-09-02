import { randomUUID } from 'node:crypto'
import { t } from '../shared/i18n'
import { mkdir, stat, truncate } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  MTIME_TOLERANCE_MS,
  type ConflictAction,
  type ConflictPolicy,
  type ConflictRequest,
  type ConflictResolution,
  type TransferItem,
  type VersionSyncPreview,
  type VersionSyncPreviewProgress,
  type VersionSyncResult
} from '@shared/types'
import { rpath, type Adapter, type RemoteStat } from './protocols/adapter'
import { localExists, safeLocalChild, walkLocalTree } from './localfs'
import {
  createLocalSyncDirs,
  planDownload,
  planUpload,
  previewDownload,
  previewUpload,
  previewUploadSeed,
  toSyncPreview,
  type SyncPlan
} from './sync'
import type { Broadcast, Session, SessionManager } from './session'

interface EnqueueDownload {
  sessionId: string
  remotePath: string
  localDir: string
  isDir: boolean
  size: number
  /** Epoch ms from the listing; null when the server did not report one. */
  modifiedAt: number | null
}

interface EnqueueUpload {
  sessionId: string
  localPath: string
  remoteDir: string
}

interface ConflictDecision {
  action: ConflictAction
  /** Filled in only for skips, to explain which rule matched. */
  reason?: string
}

/** How often progress is pushed to the renderer while a transfer is running. */
const PROGRESS_INTERVAL_MS = 150

export class TransferQueue {
  private items = new Map<string, TransferItem>()
  private order: string[] = []
  private workers = new Map<string, Set<Promise<void>>>()
  private workerAdapters = new Map<string, Set<Adapter>>()
  private conflictTails = new Map<string, Promise<void>>()
  private syncingSessions = new Set<string>()
  private previewAdapters = new Map<string, Adapter>()
  private previewGenerations = new Map<string, number>()
  private cancelRequested = new Set<string>()
  /** Version sync always replaces a differing destination, regardless of UI policy. */
  private forceOverwrite = new Set<string>()
  private conflictWaiters = new Map<
    string,
    { sessionId: string; resolve: (r: ConflictResolution) => void }
  >()
  /** Sticky answer from an "apply to all" conflict decision, per session. */
  private stickyConflict = new Map<string, ConflictPolicy | 'rename'>()
  /** Sessions already told that date comparison is unavailable. */
  private warnedNoMtime = new Set<string>()
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null

  constructor(
    private sessions: SessionManager,
    private broadcast: Broadcast,
    private getPolicy: () => ConflictPolicy,
    private getConcurrency: () => number
  ) {}

  snapshot(): TransferItem[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((i): i is TransferItem => i !== undefined)
  }

  private markDirty(immediate = false): void {
    this.dirty = true
    if (immediate) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      this.flush()
      return
    }
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, PROGRESS_INTERVAL_MS)
  }

  private flush(): void {
    if (!this.dirty) return
    this.dirty = false
    this.broadcast('queue:update', this.snapshot())
  }

  private add(item: TransferItem): void {
    this.items.set(item.id, item)
    this.order.push(item.id)
  }

  private makeItem(
    sessionId: string,
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    size: number | null,
    sourceModifiedAt: number | null
  ): TransferItem {
    return {
      id: randomUUID(),
      sessionId,
      direction,
      localPath,
      remotePath,
      name: direction === 'upload' ? basename(localPath) : rpath.basename(remotePath),
      size,
      sourceModifiedAt,
      transferred: 0,
      status: 'pending',
      speed: 0
    }
  }

  // ---------------------------------------------------------------- enqueueing

  async enqueueDownloads(requests: EnqueueDownload[]): Promise<void> {
    for (const req of requests) {
      if (req.isDir) {
        await this.expandRemoteDir(req)
      } else {
        const local = safeLocalChild(req.localDir, rpath.basename(req.remotePath))
        this.add(
          this.makeItem(
            req.sessionId,
            'download',
            local,
            req.remotePath,
            req.size || null,
            req.modifiedAt
          )
        )
      }
    }
    this.markDirty(true)
    for (const sessionId of new Set(requests.map((r) => r.sessionId))) this.ensureWorker(sessionId)
  }

  /** Mirrors a remote tree into the queue, creating the local directories up front. */
  private async expandRemoteDir(req: EnqueueDownload): Promise<void> {
    const session = this.sessions.get(req.sessionId)
    const rootName = rpath.basename(req.remotePath)

    const visit = async (remoteDir: string, localDir: string): Promise<void> => {
      await mkdir(localDir, { recursive: true })
      const entries = await session.run(() => session.adapter.list(remoteDir))
      for (const entry of entries) {
        const childRemote = rpath.join(remoteDir, entry.name)
        const childLocal = safeLocalChild(localDir, entry.name)
        if (entry.type === 'dir') {
          await visit(childRemote, childLocal)
        } else {
          this.add(
            this.makeItem(
              req.sessionId,
              'download',
              childLocal,
              childRemote,
              entry.size || null,
              entry.modifiedAt
            )
          )
        }
      }
    }

    await visit(req.remotePath, safeLocalChild(req.localDir, rootName))
  }

  async enqueueUploads(requests: EnqueueUpload[]): Promise<void> {
    for (const req of requests) {
      const kind = await localExists(req.localPath)
      if (kind === 'dir') {
        await this.expandLocalDir(req)
      } else if (kind === 'file') {
        const info = await stat(req.localPath)
        const remote = rpath.join(req.remoteDir, basename(req.localPath))
        this.add(
          this.makeItem(req.sessionId, 'upload', req.localPath, remote, info.size, info.mtimeMs)
        )
      }
    }
    this.markDirty(true)
    for (const sessionId of new Set(requests.map((r) => r.sessionId))) this.ensureWorker(sessionId)
  }

  /** Compare only: no directories are created and no transfer is queued. */
  async previewToRemote(
    sessionId: string,
    localRoot: string,
    remoteRoot: string,
    requestId: string
  ): Promise<VersionSyncPreview> {
    const report = this.previewReporter(requestId, 'upload')
    return this.runPreview(
      sessionId,
      async (adapter) =>
        toSyncPreview('upload', await previewUpload(adapter, localRoot, remoteRoot, report)),
      async () => report(await previewUploadSeed(localRoot))
    )
  }

  /** Compare only: no directories are created and no transfer is queued. */
  async previewFromRemote(
    sessionId: string,
    localRoot: string,
    remoteRoot: string,
    requestId: string
  ): Promise<VersionSyncPreview> {
    const report = this.previewReporter(requestId, 'download')
    return this.runPreview(sessionId, async (adapter) =>
      toSyncPreview('download', await previewDownload(adapter, localRoot, remoteRoot, report))
    )
  }

  private previewReporter(
    requestId: string,
    direction: 'upload' | 'download'
  ): (plan: SyncPlan) => void {
    let lastSentAt = 0
    let pending: VersionSyncPreview | null = null
    let timer: NodeJS.Timeout | null = null
    const send = (preview: VersionSyncPreview): void => {
      lastSentAt = Date.now()
      pending = null
      timer = null
      const payload: VersionSyncPreviewProgress = { requestId, preview }
      this.broadcast('queue:preview-progress', payload)
    }
    return (plan): void => {
      const preview = toSyncPreview(direction, plan)
      // Do not let the initial empty scan consume the throttle window: the
      // first real candidate should become visible immediately.
      if (
        preview.included.length === 0 &&
        preview.files.length === 0 &&
        preview.directories.length === 0
      ) {
        return
      }
      const now = Date.now()
      const remaining = 60 - (now - lastSentAt)
      if (lastSentAt === 0 || remaining <= 0) {
        if (timer) clearTimeout(timer)
        send(preview)
        return
      }
      pending = preview
      if (!timer) {
        timer = setTimeout(() => {
          if (pending) send(pending)
        }, remaining)
      }
    }
  }

  private async runPreview(
    sessionId: string,
    compare: (adapter: Adapter) => Promise<VersionSyncPreview>,
    beforeConnect?: () => Promise<void>
  ): Promise<VersionSyncPreview> {
    const generation = (this.previewGenerations.get(sessionId) ?? 0) + 1
    this.previewGenerations.set(sessionId, generation)
    const previous = this.previewAdapters.get(sessionId)
    if (previous) void previous.disconnect().catch(() => undefined)

    await beforeConnect?.()
    if (this.previewGenerations.get(sessionId) !== generation) {
      throw new Error(t('Предпросмотр отменён'))
    }

    const adapter = await this.sessions.createTransferAdapter(sessionId)
    if (this.previewGenerations.get(sessionId) !== generation) {
      await adapter.disconnect().catch(() => undefined)
      throw new Error(t('Предпросмотр отменён'))
    }
    this.previewAdapters.set(sessionId, adapter)
    try {
      return await compare(adapter)
    } finally {
      if (this.previewAdapters.get(sessionId) === adapter) {
        this.previewAdapters.delete(sessionId)
      }
      await adapter.disconnect().catch(() => undefined)
    }
  }

  cancelPreview(sessionId: string): void {
    this.previewGenerations.set(sessionId, (this.previewGenerations.get(sessionId) ?? 0) + 1)
    const adapter = this.previewAdapters.get(sessionId)
    this.previewAdapters.delete(sessionId)
    if (adapter) void adapter.disconnect().catch(() => undefined)
  }

  async syncToRemote(
    sessionId: string,
    localRoot: string,
    remoteRoot: string
  ): Promise<VersionSyncResult> {
    if (this.workers.has(sessionId) || this.syncingSessions.has(sessionId)) {
      throw new Error(t('Дождитесь завершения текущих передач перед обновлением версии'))
    }
    this.syncingSessions.add(sessionId)
    try {
    const session = this.sessions.get(sessionId)
    this.sessions.log(sessionId, 'info', t('Сравнение версии {0} → {1}…', localRoot, remoteRoot))
    const plan = await session.run(async () => {
      const next = await planUpload(session.adapter, localRoot, remoteRoot)
      for (const dir of next.remoteDirs) await session.adapter.mkdir(rpath.join(remoteRoot, dir))
      return next
    })
    for (const file of plan.files) {
      const item = this.makeItem(
        sessionId,
        'upload',
        file.localPath,
        file.remotePath,
        file.size,
        file.modifiedAt
      )
      this.forceOverwrite.add(item.id)
      this.add(item)
    }
    this.markDirty(true)
    if (plan.files.length > 0) this.ensureWorker(sessionId)
    this.sessions.log(
      sessionId,
      'info',
      t('Обновление сервера: в очередь {0}, без изменений {1}, ', plan.files.length, plan.unchanged) +
        t('исключено {0}.', plan.ignored)
    )
    return {
      direction: 'upload',
      queued: plan.files.length,
      unchanged: plan.unchanged,
      ignored: plan.ignored,
      createdDirectories: plan.remoteDirs.length
    }
    } finally {
      this.syncingSessions.delete(sessionId)
    }
  }

  async syncFromRemote(
    sessionId: string,
    localRoot: string,
    remoteRoot: string
  ): Promise<VersionSyncResult> {
    if (this.workers.has(sessionId) || this.syncingSessions.has(sessionId)) {
      throw new Error(t('Дождитесь завершения текущих передач перед обновлением версии'))
    }
    this.syncingSessions.add(sessionId)
    try {
    const session = this.sessions.get(sessionId)
    this.sessions.log(sessionId, 'info', t('Сравнение версии {0} → {1}…', remoteRoot, localRoot))
    const plan = await session.run(() => planDownload(session.adapter, localRoot, remoteRoot))
    await createLocalSyncDirs(plan.localDirs)
    for (const file of plan.files) {
      const item = this.makeItem(
        sessionId,
        'download',
        file.localPath,
        file.remotePath,
        file.size,
        file.modifiedAt
      )
      this.forceOverwrite.add(item.id)
      this.add(item)
    }
    this.markDirty(true)
    if (plan.files.length > 0) this.ensureWorker(sessionId)
    this.sessions.log(
      sessionId,
      'info',
      t('Обновление локальной версии: в очередь {0}, ', plan.files.length) +
        t('без изменений {0}, исключено {1}.', plan.unchanged, plan.ignored)
    )
    return {
      direction: 'download',
      queued: plan.files.length,
      unchanged: plan.unchanged,
      ignored: plan.ignored,
      createdDirectories: plan.localDirs.length
    }
    } finally {
      this.syncingSessions.delete(sessionId)
    }
  }

  private async expandLocalDir(req: EnqueueUpload): Promise<void> {
    const session = this.sessions.get(req.sessionId)
    const { files, dirs } = await walkLocalTree(req.localPath)

    // Create the remote skeleton first; parents always precede children.
    for (const dir of dirs) {
      const remote = rpath.join(req.remoteDir, dir)
      try {
        await session.run(() => session.adapter.mkdir(remote))
      } catch (err) {
        this.sessions.log(
          req.sessionId,
          'warn',
          t('Не удалось создать {0}: {1}', remote, (err as Error).message)
        )
      }
    }
    for (const file of files) {
      const remote = rpath.join(req.remoteDir, file.relative)
      this.add(
        this.makeItem(
          req.sessionId,
          'upload',
          file.localPath,
          remote,
          file.size,
          file.modifiedAt
        )
      )
    }
  }

  // ------------------------------------------------------------------- control

  cancel(itemId: string): void {
    const item = this.items.get(itemId)
    if (!item) return
    if (item.status === 'pending') {
      item.status = 'cancelled'
      item.finishedAt = Date.now()
    } else if (item.status === 'active') {
      // basic-ftp and ssh2 cannot abort a file mid-flight without tearing the
      // connection down, so an active item is stopped after it finishes.
      this.cancelRequested.add(itemId)
    }
    this.markDirty(true)
  }

  cancelAll(sessionId?: string): void {
    for (const item of [...this.items.values()]) {
      if (sessionId && item.sessionId !== sessionId) continue
      if (item.status === 'pending' || item.status === 'active') this.cancel(item.id)
    }
  }

  retry(itemId: string): void {
    const item = this.items.get(itemId)
    if (!item || (item.status !== 'error' && item.status !== 'cancelled')) return
    item.status = 'pending'
    item.transferred = 0
    item.error = undefined
    item.finishedAt = undefined
    this.cancelRequested.delete(itemId)
    this.markDirty(true)
    this.ensureWorker(item.sessionId)
  }

  clearFinished(): void {
    for (const [id, item] of [...this.items]) {
      if (item.status === 'done' || item.status === 'cancelled' || item.status === 'error') {
        this.items.delete(id)
        this.forceOverwrite.delete(id)
      }
    }
    this.order = this.order.filter((id) => this.items.has(id))
    this.markDirty(true)
  }

  resolveConflict(requestId: string, resolution: ConflictResolution): void {
    const waiter = this.conflictWaiters.get(requestId)
    if (!waiter) return
    this.conflictWaiters.delete(requestId)
    waiter.resolve(resolution)
  }

  /** Drop everything belonging to a session that just went away. */
  onSessionClosed(sessionId: string): void {
    this.cancelPreview(sessionId)
    this.stickyConflict.delete(sessionId)
    this.warnedNoMtime.delete(sessionId)
    this.conflictTails.delete(sessionId)
    for (const adapter of this.workerAdapters.get(sessionId) ?? []) {
      void adapter.disconnect()
    }
    // Only unblock the waiters belonging to this session — another session may
    // have its own dialog open and must not be answered on its behalf.
    for (const [requestId, waiter] of [...this.conflictWaiters]) {
      if (waiter.sessionId !== sessionId) continue
      this.conflictWaiters.delete(requestId)
      waiter.resolve({ action: 'skip', applyToAll: false })
    }
    for (const item of this.items.values()) {
      if (item.sessionId !== sessionId) continue
      if (item.status === 'pending' || item.status === 'active') {
        item.status = 'cancelled'
        item.error = t('Соединение закрыто')
        item.finishedAt = Date.now()
      }
    }
    this.markDirty(true)
  }

  // -------------------------------------------------------------------- worker

  private ensureWorker(sessionId: string): void {
    let workers = this.workers.get(sessionId)
    if (!workers) {
      workers = new Set()
      this.workers.set(sessionId, workers)
    }
    const pending = this.order.reduce((count, id) => {
      const item = this.items.get(id)
      return count + (item?.sessionId === sessionId && item.status === 'pending' ? 1 : 0)
    }, 0)
    const wanted = Math.min(Math.max(1, Math.min(6, this.getConcurrency())), pending)
    if (wanted === 0) {
      if (workers.size === 0) this.workers.delete(sessionId)
      return
    }
    while (workers.size < wanted) {
      let worker: Promise<void>
      worker = this.loop(sessionId)
        .catch((error: Error) => this.failPendingAfterConnectionError(sessionId, error))
        .finally(() => {
          const current = this.workers.get(sessionId)
          current?.delete(worker)
          if (current?.size === 0) this.workers.delete(sessionId)
          this.flush()
          if (this.nextPending(sessionId)) this.ensureWorker(sessionId)
        })
      workers.add(worker)
    }
  }

  private failPendingAfterConnectionError(sessionId: string, error: Error): void {
    for (const item of this.items.values()) {
      if (item.sessionId !== sessionId || item.status !== 'pending') continue
      item.status = 'error'
      item.error = t('Не удалось открыть параллельное соединение: {0}', error.message)
      item.finishedAt = Date.now()
    }
    this.sessions.log(sessionId, 'error', t('Параллельные передачи: {0}', error.message))
    this.markDirty(true)
  }

  private nextPending(sessionId: string): TransferItem | undefined {
    for (const id of this.order) {
      const item = this.items.get(id)
      if (item && item.sessionId === sessionId && item.status === 'pending') return item
    }
    return undefined
  }

  private async loop(sessionId: string): Promise<void> {
    const adapter = await this.sessions.createTransferAdapter(sessionId)
    let adapters = this.workerAdapters.get(sessionId)
    if (!adapters) {
      adapters = new Set()
      this.workerAdapters.set(sessionId, adapters)
    }
    adapters.add(adapter)
    try {
      for (;;) {
        const item = this.nextPending(sessionId)
        if (!item) return
        // Reserve synchronously so another worker cannot pick the same item
        // while this one is checking the target and conflict policy.
        item.status = 'active'
        item.startedAt = Date.now()
        this.markDirty(true)
        try {
          await this.runItem(item, adapter)
        } catch (err) {
          if (this.items.get(item.id)?.status === 'cancelled') return
          item.status = 'error'
          item.error = (err as Error).message
          item.finishedAt = Date.now()
          this.sessions.log(sessionId, 'error', `${item.name}: ${item.error}`)
          this.markDirty(true)
        }
        // A cancel that landed while this item was in flight stops this worker.
        if (this.cancelRequested.delete(item.id)) return
      }
    } finally {
      adapters.delete(adapter)
      if (adapters.size === 0) this.workerAdapters.delete(sessionId)
      await adapter.disconnect().catch(() => undefined)
    }
  }

  private async runItem(item: TransferItem, adapter: Adapter): Promise<void> {
    let session: Session
    try {
      session = this.sessions.get(item.sessionId)
    } catch {
      item.status = 'cancelled'
      item.error = t('Соединение закрыто')
      item.finishedAt = Date.now()
      this.markDirty(true)
      return
    }

    const decision = await this.withConflictLock(item.sessionId, () =>
      this.decideConflict(item, session, adapter)
    )
    const action = decision.action
    if (action === 'skip') {
      item.status = 'cancelled'
      item.error = decision.reason ?? t('Пропущено — файл уже существует')
      item.finishedAt = Date.now()
      this.markDirty(true)
      return
    }

    let startAt = 0
    if (action === 'resume') {
      startAt = await this.existingTargetSize(item, adapter)
      if (item.size !== null && startAt >= item.size) {
        item.status = 'done'
        item.transferred = item.size
        item.finishedAt = Date.now()
        this.markDirty(true)
        return
      }
    } else if (action === 'rename') {
      if (item.direction === 'upload') item.remotePath = await this.uniqueRemotePath(item, adapter)
      else item.localPath = await this.uniqueLocalPath(item)
      item.name =
        item.direction === 'upload' ? basename(item.localPath) : rpath.basename(item.remotePath)
    }

    item.status = 'active'
    item.startedAt = Date.now()
    item.transferred = startAt
    item.speed = 0
    this.markDirty(true)

    let lastBytes = startAt
    let lastAt = Date.now()
    const onProgress = (p: { transferred: number }): void => {
      item.transferred = p.transferred
      const now = Date.now()
      const dt = now - lastAt
      if (dt >= PROGRESS_INTERVAL_MS) {
        const instant = ((p.transferred - lastBytes) * 1000) / dt
        // Light exponential smoothing keeps the readout from flickering.
        item.speed = item.speed === 0 ? instant : item.speed * 0.6 + instant * 0.4
        lastBytes = p.transferred
        lastAt = now
      }
      this.markDirty()
    }

    if (item.direction === 'download') {
      await mkdir(dirname(item.localPath), { recursive: true })
      if (startAt === 0 && (await localExists(item.localPath)) === 'file') {
        // Drop any stale partial so a shorter file cannot leave trailing bytes.
        await truncate(item.localPath, 0).catch(() => undefined)
      }
      await adapter.download(item.remotePath, item.localPath, onProgress, startAt)
    } else {
      await adapter.upload(item.localPath, item.remotePath, onProgress, startAt)
    }

    item.status = 'done'
    item.finishedAt = Date.now()
    if (item.size !== null) item.transferred = item.size
    item.speed = 0
    this.markDirty(true)
  }

  private async existingTargetSize(item: TransferItem, adapter: Adapter): Promise<number> {
    const target = await this.targetStat(item, adapter, false)
    return target && target.size > 0 ? target.size : 0
  }

  /**
   * Metadata for whatever already occupies the destination, in one shape for
   * both directions. Null means the path is free.
   */
  private async targetStat(
    item: TransferItem,
    adapter: Adapter,
    withModified: boolean
  ): Promise<RemoteStat | null> {
    if (item.direction === 'download') {
      const info = await stat(item.localPath).catch(() => null)
      return info ? { size: info.size, modifiedAt: info.mtimeMs } : null
    }
    return adapter.statOf(item.remotePath, withModified)
  }

  private async uniqueRemotePath(item: TransferItem, adapter: Adapter): Promise<string> {
    const dir = rpath.dirname(item.remotePath)
    const name = rpath.basename(item.remotePath)
    for (let n = 1; n < 1000; n++) {
      const candidate = rpath.join(dir, suffixed(name, n))
      const taken = await adapter.statOf(candidate)
      if (!taken) return candidate
    }
    return item.remotePath
  }

  private async uniqueLocalPath(item: TransferItem): Promise<string> {
    const dir = dirname(item.localPath)
    const name = basename(item.localPath)
    for (let n = 1; n < 1000; n++) {
      const candidate = join(dir, suffixed(name, n))
      if ((await localExists(candidate)) === false) return candidate
    }
    return item.localPath
  }

  /** Serialises conflict decisions while the actual file streams stay parallel. */
  private async withConflictLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.conflictTails.get(sessionId) ?? Promise.resolve()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.conflictTails.set(sessionId, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.conflictTails.get(sessionId) === tail) this.conflictTails.delete(sessionId)
    }
  }

  /**
   * Resolves one destination clash. Conditional policies also report *which*
   * rule skipped the file — "пропущено" with no reason is the kind of thing
   * that sends people digging through logs.
   */
  private async decideConflict(
    item: TransferItem,
    session: Session,
    adapter: Adapter
  ): Promise<ConflictDecision> {
    if (this.forceOverwrite.has(item.id)) return { action: 'overwrite' }
    const sticky = this.stickyConflict.get(item.sessionId)
    // «Переименовать» — единственное действие без парного правила, поэтому
    // оно короткое замыкание. Остальное подменяет политику и проходит ниже
    // через ту же логику, что и глобальная настройка.
    if (sticky === 'rename') return { action: 'rename' }

    const policy = sticky ?? this.getPolicy()
    // Unconditional overwrite needs to know nothing about the destination, so
    // skip the round trip entirely — it fires once per file in a big upload.
    if (policy === 'overwrite') return { action: 'overwrite' }

    const needsDate = policy === 'ask' || policy === 'newer' || policy === 'size-or-newer'
    const target = await this.targetStat(item, adapter, needsDate)
    // Nothing in the way: the common case, no policy needed.
    if (!target) return { action: 'overwrite' }

    switch (policy) {
      case 'skip':
        return { action: 'skip', reason: t('Пропущено — файл уже существует') }
      case 'resume':
        return { action: 'resume' }
      case 'size-differs':
        return this.sizeDiffers(item, target)
          ? { action: 'overwrite' }
          : { action: 'skip', reason: t('Пропущено — размер совпадает') }
      case 'newer':
        return this.sourceIsNewer(item, target, session)
          ? { action: 'overwrite' }
          : { action: 'skip', reason: t('Пропущено — источник не новее') }
      case 'size-or-newer':
        if (this.sizeDiffers(item, target)) return { action: 'overwrite' }
        if (this.sourceIsNewer(item, target, session)) return { action: 'overwrite' }
        return { action: 'skip', reason: t('Пропущено — размер совпадает, источник не новее') }
      default:
        break
    }

    const requestId = randomUUID()
    const request: ConflictRequest = {
      requestId,
      itemId: item.id,
      name: item.name,
      direction: item.direction,
      targetPath: item.direction === 'download' ? item.localPath : item.remotePath,
      sourceSize: item.size ?? -1,
      sourceModifiedAt: item.sourceModifiedAt,
      targetSize: target.size,
      targetModifiedAt: target.modifiedAt
    }
    const answer = await new Promise<ConflictResolution>((resolve) => {
      this.conflictWaiters.set(requestId, { sessionId: item.sessionId, resolve })
      this.broadcast('queue:conflict', request)
    })
    if (answer.applyToAll) this.stickyConflict.set(item.sessionId, answer.rule ?? answer.action)
    return { action: answer.action }
  }

  /** An unknown size on either side counts as "differs" — transfer, do not skip. */
  private sizeDiffers(item: TransferItem, target: RemoteStat): boolean {
    if (item.size === null || target.size < 0) return true
    return item.size !== target.size
  }

  /**
   * Whether the source is meaningfully newer. Equal-to-the-second timestamps
   * must not read as newer, hence the tolerance: FTP reports whole seconds and
   * FAT volumes round to two.
   *
   * A missing timestamp on either side makes the comparison impossible, and the
   * safe answer is to transfer. That silently turns the policy into plain
   * overwrite, so say so once per session rather than letting it puzzle anyone.
   */
  private sourceIsNewer(item: TransferItem, target: RemoteStat, session: Session): boolean {
    if (item.sourceModifiedAt === null || target.modifiedAt === null) {
      if (!this.warnedNoMtime.has(session.id)) {
        this.warnedNoMtime.add(session.id)
        this.sessions.log(
          session.id,
          'warn',
          t('Сервер не сообщает время изменения файлов, сравнить по дате невозможно — ') +
            t('правило «если новее» работает как обычная перезапись.')
        )
      }
      return true
    }
    return item.sourceModifiedAt > target.modifiedAt + MTIME_TOLERANCE_MS
  }
}

/** `report.tar.gz` + 2 becomes `report (2).tar.gz`, keeping compound extensions. */
function suffixed(name: string, n: number): string {
  const match = /^(.+?)((?:\.[A-Za-z0-9]{1,8})*)$/.exec(name)
  const stem = match?.[1] ?? name
  const ext = match?.[2] ?? ''
  return `${stem} (${n})${ext}`
}

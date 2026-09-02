import { randomUUID } from 'node:crypto'
import { t } from '../shared/i18n'
import type { FileEntry, LogLevel, LogLine, SessionInfo, SiteConfig } from '@shared/types'
import { rpath, type Adapter } from './protocols/adapter'
import { FtpAdapter } from './protocols/ftp'
import { SftpAdapter } from './protocols/sftp'
import type { Store } from './store'

export type Broadcast = (channel: string, payload: unknown) => void

function createAdapter(site: SiteConfig, log: (l: LogLevel, t: string) => void): Adapter {
  const deps = {
    site,
    log,
    secrets: { password: site.password, passphrase: site.passphrase }
  }
  return site.protocol === 'sftp' ? new SftpAdapter(deps) : new FtpAdapter(deps)
}

/**
 * One live connection. Every adapter call is funnelled through `run` because FTP
 * is strictly one command at a time — two overlapping `list` calls on the same
 * control socket desynchronise the connection and produce garbage responses.
 */
export class Session {
  readonly connectedAt = Date.now()
  cwd = '/'
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    readonly id: string,
    readonly site: SiteConfig,
    readonly adapter: Adapter
  ) {}

  get info(): SessionInfo {
    return {
      sessionId: this.id,
      siteId: this.site.id,
      name: this.site.name,
      protocol: this.site.protocol,
      host: this.site.host,
      port: this.site.port,
      user: this.site.user,
      cwd: this.cwd,
      connectedAt: this.connectedAt
    }
  }

  isClosed(): boolean {
    return this.closed || !this.adapter.isConnected()
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error(t('Сессия закрыта')))
    // Chain on settle (not just fulfil) so one failed command never wedges the queue.
    const next = this.chain.then(
      () => fn(),
      () => fn()
    )
    this.chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  async close(): Promise<void> {
    this.closed = true
    await this.adapter.disconnect()
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private folderDateScan = new Map<string, number>()
  private logSeq = 0

  constructor(
    private store: Store,
    private broadcast: Broadcast
  ) {}

  private emitLog(sessionId: string | null, level: LogLevel, text: string): void {
    const line: LogLine = { id: ++this.logSeq, sessionId, level, text, at: Date.now() }
    this.broadcast('log:line', line)
  }

  log(sessionId: string | null, level: LogLevel, text: string): void {
    this.emitLog(sessionId, level, text)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  get(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(t('Сессия не найдена — возможно, соединение уже закрыто'))
    return session
  }

  /**
   * `overrides` carries a password typed into the connect dialog for sites that
   * do not store one; it is used for this connection only and never written out
   * unless the caller explicitly saved it beforehand.
   */
  async connect(
    siteId: string,
    overrides?: { password?: string; passphrase?: string }
  ): Promise<SessionInfo> {
    const site = this.store.resolveSite(siteId)
    if (!site) throw new Error(t('Профиль подключения не найден'))

    const effective: SiteConfig = {
      ...site,
      password: overrides?.password ?? site.password,
      passphrase: overrides?.passphrase ?? site.passphrase
    }

    // An empty password reaches the server as a doomed login and comes back as
    // "530 Authentication failed", which blames the credentials rather than the
    // missing one. Refuse before the round trip.
    if (effective.authMode === 'password' && !effective.password) {
      throw new Error(
        t('Пароль не задан: сохранённого нет или его не удалось расшифровать. ') +
          t('Откройте профиль и введите пароль заново.')
      )
    }

    // Allocate the id up front so handshake logs are already routed to the
    // right session tab before the Session object exists.
    const sessionId = randomUUID()
    const adapter = createAdapter(effective, (level, text) => this.emitLog(sessionId, level, text))

    await adapter.connect()

    const session = new Session(sessionId, effective, adapter)
    this.sessions.set(session.id, session)

    const startDir = effective.remoteDir?.trim()
    try {
      session.cwd = startDir ? rpath.normalise(startDir) : await adapter.pwd()
      // Prove the directory is readable before reporting success.
      await adapter.list(session.cwd)
    } catch (err) {
      if (startDir) {
        this.emitLog(
          session.id,
          'warn',
          t('Не удалось открыть {0}: {1}. Открываю домашний каталог.', startDir, (err as Error).message)
        )
        session.cwd = await adapter.pwd()
      } else {
        throw err
      }
    }

    const fingerprint = adapter instanceof SftpAdapter ? adapter.hostFingerprint : null
    if (fingerprint) effective.hostKeyFingerprint = fingerprint
    await this.store.touchSite(siteId, fingerprint ?? undefined)

    return session.info
  }

  /** A dedicated connection for one parallel transfer worker. */
  async createTransferAdapter(sessionId: string): Promise<Adapter> {
    const session = this.get(sessionId)
    const adapter = createAdapter(session.site, (level, text) =>
      this.emitLog(sessionId, level, t('[передача] {0}', text))
    )
    await adapter.connect()
    return adapter
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    this.folderDateScan.delete(sessionId)
    await session.close()
    this.emitLog(sessionId, 'info', t('Отключено'))
    this.broadcast('session:closed', { sessionId })
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.disconnect(id)))
  }

  async listDir(sessionId: string, path: string): Promise<{ path: string; entries: FileEntry[] }> {
    const session = this.get(sessionId)
    const target = rpath.normalise(path || session.cwd)
    // Cancel any slow date enrichment before queueing the navigation itself.
    const scan = (this.folderDateScan.get(sessionId) ?? 0) + 1
    this.folderDateScan.set(sessionId, scan)
    const entries = await session.run(() => session.adapter.list(target))
    session.cwd = target
    void this.enrichRemoteFolderDates(sessionId, target, entries, scan)
    return { path: target, entries }
  }

  private async enrichRemoteFolderDates(
    sessionId: string,
    path: string,
    entries: FileEntry[],
    scan: number
  ): Promise<void> {
    for (const folder of entries.filter((entry) => entry.type === 'dir')) {
      // A short yield lets navigation and transfers enter Session.run between
      // folders; at worst they wait for one LIST, never for an entire tree.
      await new Promise((resolve) => setTimeout(resolve, 12))
      if (this.folderDateScan.get(sessionId) !== scan) return
      let session: Session
      try {
        session = this.get(sessionId)
      } catch {
        return
      }
      const children = await session
        .run(() => session.adapter.list(rpath.join(path, folder.name)))
        .catch(() => null)
      if (!children || this.folderDateScan.get(sessionId) !== scan) continue
      const newest = children.reduce<number | null>((value, child) => {
        if (child.type !== 'file' || child.modifiedAt === null) return value
        return value === null || child.modifiedAt > value ? child.modifiedAt : value
      }, null)
      if (newest === null) continue
      this.broadcast('session:folder-date', {
        sessionId,
        path,
        name: folder.name,
        modifiedAt: newest
      })
    }
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const session = this.get(sessionId)
    await session.run(() => session.adapter.mkdir(rpath.normalise(path)))
    this.emitLog(sessionId, 'info', t('Создан каталог {0}', path))
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const session = this.get(sessionId)
    await session.run(() => session.adapter.rename(rpath.normalise(from), rpath.normalise(to)))
    this.emitLog(sessionId, 'info', t('Переименовано: {0} → {1}', from, to))
  }

  /** Recursively deletes a directory; adapters only remove empty ones portably. */
  async remove(sessionId: string, path: string, isDir: boolean): Promise<void> {
    const session = this.get(sessionId)
    const target = rpath.normalise(path)
    await session.run(async () => {
      if (!isDir) {
        await session.adapter.removeFile(target)
        return
      }
      await this.removeTree(session, target)
    })
    this.emitLog(sessionId, 'info', t('Удалено: {0}', path))
  }

  private async removeTree(session: Session, dir: string): Promise<void> {
    const entries = await session.adapter.list(dir)
    for (const entry of entries) {
      const child = rpath.join(dir, entry.name)
      if (entry.type === 'dir') await this.removeTree(session, child)
      else await session.adapter.removeFile(child)
    }
    await session.adapter.removeDir(dir)
  }
}

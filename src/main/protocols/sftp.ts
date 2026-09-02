import { createHash } from 'node:crypto'
import { t } from '../../shared/i18n'
import { createReadStream, createWriteStream } from 'node:fs'
import { Transform, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import SftpClient from 'ssh2-sftp-client'
import type { FileEntry } from '@shared/types'
import type { Adapter, AdapterDeps, ProgressFn, RemoteStat } from './adapter'
import { assertProtocolMatches, explainConnectFailure } from './probe'

type RemoteInfo = Awaited<ReturnType<SftpClient['list']>>[number]
// The published @types lag the runtime package slightly; borrow the real
// parameter types instead of hand-rolling option shapes.
type GetOptions = Parameters<SftpClient['get']>[2]
type PutOptions = Parameters<SftpClient['put']>[2]

/** ssh2-sftp-client hands back partial rwx strings like `rw`; pad to `rw-`. */
function pad(part: string | undefined): string {
  const s = part ?? ''
  return ['r', 'w', 'x'].map((c) => (s.includes(c) ? c : '-')).join('')
}

/** v9+ reports milliseconds, older builds reported seconds. Normalise both. */
function toEpochMs(value: number | undefined): number | null {
  if (!value) return null
  return value < 1e12 ? value * 1000 : value
}

/** See the note in ftp.ts: a `data` listener would drain the stream early. */
function counter(startAt: number, onProgress: ProgressFn): Transform {
  let seen = startAt
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      seen += chunk.length
      onProgress({ transferred: seen })
      callback(null, chunk)
    }
  })
}

function toEntry(info: RemoteInfo): FileEntry {
  return {
    name: info.name,
    type: info.type === 'd' ? 'dir' : info.type === 'l' ? 'link' : 'file',
    size: info.size ?? 0,
    modifiedAt: toEpochMs(info.modifyTime),
    permissions: info.rights
      ? pad(info.rights.user) + pad(info.rights.group) + pad(info.rights.other)
      : null
  }
}


/**
 * Where to reach the SSH agent. `SSH_AUTH_SOCK` covers Linux, macOS and modern
 * OpenSSH on Windows; `pageant` is a Windows-only named-pipe shorthand that
 * ssh2 understands, so it is a fallback only there. Elsewhere an absent socket
 * means no agent, and guessing would produce a confusing connection error.
 */
function sshAgentAddress(): string | undefined {
  const socket = process.env.SSH_AUTH_SOCK
  if (socket) return socket
  return process.platform === 'win32' ? 'pageant' : undefined
}

export class SftpAdapter implements Adapter {
  readonly protocolName = 'SFTP'
  private client: SftpClient | null = null
  private connected = false
  /** Fingerprint observed during the last handshake, for trust-on-first-use pinning. */
  hostFingerprint: string | null = null

  constructor(private deps: AdapterDeps) {}

  isConnected(): boolean {
    return this.connected && this.client !== null
  }

  async connect(): Promise<void> {
    const { site, log } = this.deps
    const client = new SftpClient(site.name)
    this.client = client

    client.on('error', (err: Error) => {
      log('error', `SSH: ${err.message}`)
    })
    client.on('close', () => {
      this.connected = false
      log('info', t('SSH-соединение закрыто'))
    })

    log('info', t('Подключение к {0}:{1} по SFTP…', site.host, site.port))
    // Отсекаем неверный протокол до рукопожатия: иначе ssh2 молча ждёт таймаута.
    await assertProtocolMatches(site.host, site.port, 'sftp')
    try {
      await this.handshake(client)
    } catch (err) {
      const { message, hint } = await explainConnectFailure(
        err as Error,
        site.host,
        site.port,
        'sftp'
      )
      if (hint) log('error', hint)
      throw new Error(message)
    }
    this.connected = true
    log('info', t('Соединение установлено: SFTP {0}:{1}', site.host, site.port))
  }

  private async handshake(client: SftpClient): Promise<void> {
    const { site, log, secrets } = this.deps
    let privateKey: Buffer | undefined
    if (site.authMode === 'key') {
      if (!site.privateKeyPath) throw new Error(t('Не указан путь к приватному ключу'))
      const { readFile } = await import('node:fs/promises')
      privateKey = await readFile(site.privateKeyPath)
    }

    await client.connect({
      host: site.host,
      port: site.port,
      username: site.user,
      password: site.authMode === 'password' ? secrets.password : undefined,
      privateKey,
      passphrase: site.authMode === 'key' ? secrets.passphrase : undefined,
      agent: site.authMode === 'agent' ? sshAgentAddress() : undefined,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      // The library floors this at one retry (`config.retries || 1`), so two
      // attempts are unavoidable — keep the per-attempt budget modest to bound
      // the total. The banner probe above already catches the common case.
      retries: 1,
      hostVerifier: (key: Buffer, cb?: (ok: boolean) => void): boolean => {
        const fp =
          'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
        this.hostFingerprint = fp
        let ok: boolean
        if (!site.hostKeyFingerprint) {
          log('warn', t('Ключ хоста запомнен при первом подключении: {0}', fp))
          ok = true
        } else if (site.hostKeyFingerprint === fp) {
          ok = true
        } else {
          log(
            'error',
            t('Отпечаток ключа хоста не совпал. Ожидался {0}, получен {1}. ', site.hostKeyFingerprint, fp) +
              t('Соединение разорвано — это может быть подмена сервера.')
          )
          ok = false
        }
        if (cb) cb(ok)
        return ok
      }
    })
  }

  async disconnect(): Promise<void> {
    const client = this.client
    this.client = null
    this.connected = false
    if (!client) return
    try {
      await client.end()
    } catch {
      /* already torn down */
    }
  }

  private need(): SftpClient {
    if (!this.client || !this.connected) throw new Error(t('SFTP-соединение закрыто'))
    return this.client
  }

  async pwd(): Promise<string> {
    return this.need().cwd()
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const infos = await this.need().list(remotePath)
    return infos.filter((i) => i.name !== '.' && i.name !== '..').map(toEntry)
  }

  async download(
    remotePath: string,
    localPath: string,
    onProgress: ProgressFn,
    startAt = 0
  ): Promise<void> {
    const client = this.need()
    if (startAt > 0) {
      // fastGet has no offset support, so resume goes through a plain stream pipe.
      const sink = createWriteStream(localPath, { flags: 'r+', start: startAt })
      const meter = counter(startAt, onProgress)
      const drained = new Promise<void>((resolve, reject) => {
        sink.once('close', resolve)
        sink.once('error', reject)
      })
      meter.pipe(sink)
      const options = { readStreamOptions: { start: startAt } } as GetOptions
      try {
        await client.get(remotePath, meter, options)
        await drained
      } catch (err) {
        sink.destroy()
        throw err
      }
      return
    }
    await client.fastGet(remotePath, localPath, {
      step: (transferred: number): void => onProgress({ transferred })
    })
  }

  async upload(
    localPath: string,
    remotePath: string,
    onProgress: ProgressFn,
    startAt = 0
  ): Promise<void> {
    const client = this.need()
    if (startAt > 0) {
      const source = createReadStream(localPath, { start: startAt })
      const meter = counter(startAt, onProgress)
      source.pipe(meter)
      const options = { writeStreamOptions: { flags: 'a' } } as PutOptions
      await client.put(meter, remotePath, options)
      return
    }
    await client.fastPut(localPath, remotePath, {
      step: (transferred: number): void => onProgress({ transferred })
    })
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const chunks: Buffer[] = []
    let total = 0
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        total += chunk.length
        if (total > 1024 * 1024) {
          callback(new Error(t('.ftpignore больше 1 МБ')))
          return
        }
        chunks.push(Buffer.from(chunk))
        callback()
      }
    })
    await this.need().get(remotePath, sink)
    await finished(sink)
    return Buffer.concat(chunks)
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.need().mkdir(remotePath, true)
  }

  async removeFile(remotePath: string): Promise<void> {
    await this.need().delete(remotePath)
  }

  async removeDir(remotePath: string): Promise<void> {
    await this.need().rmdir(remotePath, false)
  }

  async rename(from: string, to: string): Promise<void> {
    await this.need().rename(from, to)
  }

  async statOf(remotePath: string): Promise<RemoteStat | null> {
    try {
      // SFTP returns size and mtime in one call, so `withModified` costs nothing.
      const st = await this.need().stat(remotePath)
      return { size: st.size, modifiedAt: toEpochMs(st.modifyTime) }
    } catch {
      return null
    }
  }

  async isDir(remotePath: string): Promise<boolean> {
    try {
      return (await this.need().exists(remotePath)) === 'd'
    } catch {
      return false
    }
  }
}

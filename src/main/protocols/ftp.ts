import { createReadStream, createWriteStream } from 'node:fs'
import { t } from '../../shared/i18n'
import { Transform, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { Client, FileType, type FileInfo } from 'basic-ftp'
import type { FileEntry } from '@shared/types'
import type { Adapter, AdapterDeps, ProgressFn, RemoteStat } from './adapter'
import { assertProtocolMatches, explainConnectFailure } from './probe'

/**
 * Byte counter for a pipe chain.
 *
 * A `PassThrough` with a `data` listener is NOT usable here: attaching the
 * listener switches the stream to flowing mode immediately, so bytes drain to
 * nowhere during the window before the consumer attaches its own pipe — which
 * silently truncates uploads. A Transform only moves data when the consumer
 * pulls, so nothing is lost and backpressure still works.
 */
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

/** basic-ftp masks PASS itself; this is belt-and-braces for anything it does not. */
function scrub(line: string): string {
  return line.replace(/^(>\s*PASS)\s+.*/i, '$1 ***')
}

function toEntry(info: FileInfo): FileEntry {
  const type =
    info.type === FileType.Directory ? 'dir' : info.type === FileType.SymbolicLink ? 'link' : 'file'
  return {
    name: info.name,
    type,
    size: info.size ?? 0,
    modifiedAt: info.modifiedAt ? info.modifiedAt.getTime() : null,
    permissions: formatPermissions(info),
    linkTarget: info.link || undefined
  }
}

function formatPermissions(info: FileInfo): string | null {
  const p = info.permissions
  if (!p) return null
  const bit = (mask: number, value: number, char: string): string => ((mask & value) !== 0 ? char : '-')
  const trio = (mask: number): string =>
    bit(mask, 4, 'r') + bit(mask, 2, 'w') + bit(mask, 1, 'x')
  return trio(p.user) + trio(p.group) + trio(p.world)
}

export class FtpAdapter implements Adapter {
  readonly protocolName: string
  private client: Client | null = null

  constructor(private deps: AdapterDeps) {
    this.protocolName = deps.site.protocol === 'ftp' ? 'FTP' : 'FTPS'
  }

  isConnected(): boolean {
    return this.client !== null && !this.client.closed
  }

  async connect(): Promise<void> {
    const { site, log, secrets } = this.deps
    const client = new Client(30_000)
    // Replacing the method shadows the prototype's `verbose` gate, so every
    // protocol line reaches the UI log panel.
    client.ftp.log = (message: string): void => {
      const text = scrub(message)
      if (text.startsWith('>')) log('send', text)
      else if (text.startsWith('<')) log('recv', text)
      else log('info', text)
    }
    this.client = client

    const secure: boolean | 'implicit' =
      site.protocol === 'ftps' ? true : site.protocol === 'ftps-implicit' ? 'implicit' : false

    await assertProtocolMatches(site.host, site.port, site.protocol)

    const anonymous = site.authMode === 'anonymous'
    try {
      await client.access({
        host: site.host,
        port: site.port,
        user: anonymous ? 'anonymous' : site.user,
        password: anonymous ? 'anonymous@' : (secrets.password ?? ''),
        secure,
        secureOptions: secure
          ? { rejectUnauthorized: site.rejectUnauthorized, servername: site.host }
          : undefined
      })
    } catch (err) {
      const { message, hint } = await explainConnectFailure(
        err as Error,
        site.host,
        site.port,
        site.protocol
      )
      if (hint) log('error', hint)
      throw new Error(message)
    }
    log('info', t('Соединение установлено: {0} {1}:{2}', this.protocolName, site.host, site.port))
  }

  async disconnect(): Promise<void> {
    if (!this.client) return
    try {
      this.client.close()
    } finally {
      this.client = null
    }
  }

  private need(): Client {
    if (!this.client || this.client.closed) throw new Error(t('FTP-соединение закрыто'))
    return this.client
  }

  async pwd(): Promise<string> {
    return this.need().pwd()
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
    const sink = createWriteStream(
      localPath,
      startAt > 0 ? { flags: 'r+', start: startAt } : { flags: 'w' }
    )
    const meter = counter(startAt, onProgress)
    const drained = new Promise<void>((resolve, reject) => {
      sink.once('close', resolve)
      sink.once('error', reject)
    })
    meter.pipe(sink)
    try {
      await client.downloadTo(meter, remotePath, startAt)
      await drained
    } catch (err) {
      sink.destroy()
      throw err
    }
  }

  async upload(
    localPath: string,
    remotePath: string,
    onProgress: ProgressFn,
    startAt = 0
  ): Promise<void> {
    const client = this.need()
    const source = createReadStream(localPath, startAt > 0 ? { start: startAt } : {})
    const meter = counter(startAt, onProgress)
    source.pipe(meter)
    try {
      if (startAt > 0) await client.appendFrom(meter, remotePath)
      else await client.uploadFrom(meter, remotePath)
    } finally {
      source.destroy()
    }
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
    await this.need().downloadTo(sink, remotePath)
    await finished(sink)
    return Buffer.concat(chunks)
  }

  async mkdir(remotePath: string): Promise<void> {
    const client = this.need()
    // `ensureDir` changes the working directory as a side effect; restore it so
    // the caller's notion of cwd stays true.
    const previous = await client.pwd()
    try {
      await client.ensureDir(remotePath)
    } finally {
      await client.cd(previous)
    }
  }

  async removeFile(remotePath: string): Promise<void> {
    await this.need().remove(remotePath)
  }

  async removeDir(remotePath: string): Promise<void> {
    await this.need().removeDir(remotePath)
  }

  async rename(from: string, to: string): Promise<void> {
    await this.need().rename(from, to)
  }

  async statOf(remotePath: string, withModified = false): Promise<RemoteStat | null> {
    const client = this.need()
    let size: number
    try {
      size = await client.size(remotePath)
    } catch {
      // Many servers reject SIZE for directories or in ASCII mode; either way
      // there is nothing here to compare against.
      return null
    }
    if (!withModified) return { size, modifiedAt: null }
    try {
      const when = await client.lastMod(remotePath)
      return { size, modifiedAt: when.getTime() }
    } catch {
      // MDTM is optional and plenty of servers omit it.
      return { size, modifiedAt: null }
    }
  }

  async isDir(remotePath: string): Promise<boolean> {
    const client = this.need()
    const previous = await client.pwd()
    try {
      await client.cd(remotePath)
      return true
    } catch {
      return false
    } finally {
      try {
        await client.cd(previous)
      } catch {
        /* connection already gone; the caller will surface the real error */
      }
    }
  }
}

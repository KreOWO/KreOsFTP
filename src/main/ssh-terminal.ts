import { createHash } from 'node:crypto'
import { t } from '../shared/i18n'
import { readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import type { SshTerminalState } from '@shared/types'
import type { Broadcast, SessionManager } from './session'
import type { Store } from './store'

interface LiveTerminal {
  client: Client
  channel: ClientChannel | null
  decoder: StringDecoder
  closing: boolean
}

function validDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
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

export class SshTerminalManager {
  private terminals = new Map<string, LiveTerminal>()

  constructor(
    private sessions: SessionManager,
    private store: Store,
    private broadcast: Broadcast
  ) {}

  private state(payload: SshTerminalState): void {
    this.broadcast('ssh:state', payload)
  }

  private data(sessionId: string, data: string): void {
    if (data) this.broadcast('ssh:data', { sessionId, data })
  }

  async open(sessionId: string, columns: number, rows: number): Promise<void> {
    const existing = this.terminals.get(sessionId)
    if (existing?.channel) {
      existing.channel.setWindow(
        validDimension(rows, 2, 300),
        validDimension(columns, 10, 500),
        0,
        0
      )
      this.state({ sessionId, status: 'connected' })
      return
    }
    if (existing) throw new Error(t('SSH-терминал уже подключается'))

    const session = this.sessions.get(sessionId)
    const site = session.site
    if (site.authMode === 'anonymous') {
      throw new Error(t('SSH не поддерживает анонимный вход — укажите пользователя и пароль или ключ'))
    }

    let privateKey: Buffer | undefined
    if (site.authMode === 'key') {
      if (!site.privateKeyPath) throw new Error(t('Не указан путь к приватному SSH-ключу'))
      privateKey = await readFile(site.privateKeyPath)
    }

    const currentSite = this.store.resolveSite(site.id)
    const expectedFingerprint = currentSite?.hostKeyFingerprint ?? site.hostKeyFingerprint
    // SFTP already is SSH and therefore uses the profile's primary port.
    // FTP/FTPS profiles use the companion SSH endpoint configured separately.
    const port = site.protocol === 'sftp' ? site.port : (site.sshPort ?? 22)
    const client = new Client()
    const terminal: LiveTerminal = {
      client,
      channel: null,
      decoder: new StringDecoder('utf8'),
      closing: false
    }
    this.terminals.set(sessionId, terminal)
    this.state({ sessionId, status: 'connecting' })

    const fail = (error: Error): void => {
      if (terminal.closing || this.terminals.get(sessionId) !== terminal) return
      this.state({ sessionId, status: 'error', message: error.message })
    }

    client.on('error', fail)
    client.on('close', () => {
      if (this.terminals.get(sessionId) !== terminal) return
      this.data(sessionId, terminal.decoder.end())
      this.terminals.delete(sessionId)
      this.state({ sessionId, status: 'closed' })
    })
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => site.password ?? ''))
    })
    client.once('ready', () => {
      client.shell(
        {
          term: 'xterm-256color',
          cols: validDimension(columns, 10, 500),
          rows: validDimension(rows, 2, 300)
        },
        (error, channel) => {
          if (error) {
            fail(error)
            client.end()
            return
          }
          terminal.channel = channel
          channel.on('data', (chunk: Buffer) => this.data(sessionId, terminal.decoder.write(chunk)))
          channel.stderr.on('data', (chunk: Buffer) =>
            this.data(sessionId, terminal.decoder.write(chunk))
          )
          channel.once('close', () => client.end())
          this.state({ sessionId, status: 'connected' })
        }
      )
    })

    const config: ConnectConfig = {
      host: site.host,
      port,
      username: site.user,
      password: site.authMode === 'password' ? site.password : undefined,
      privateKey,
      passphrase: site.authMode === 'key' ? site.passphrase : undefined,
      agent: site.authMode === 'agent' ? sshAgentAddress() : undefined,
      tryKeyboard: site.authMode === 'password',
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      hostVerifier: (key: Buffer): boolean => {
        const fingerprint =
          'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
        if (expectedFingerprint && expectedFingerprint !== fingerprint) {
          fail(
            new Error(
              t('Ключ SSH-хоста изменился. Ожидался {0}, получен {1}', expectedFingerprint, fingerprint)
            )
          )
          return false
        }
        if (!expectedFingerprint) {
          void this.store.touchSite(site.id, fingerprint)
          this.sessions.log(sessionId, 'warn', t('Ключ SSH-хоста запомнен: {0}', fingerprint))
        }
        return true
      }
    }

    client.connect(config)
  }

  write(sessionId: string, data: string): void {
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 65_536) {
      throw new Error(t('Недопустимый объём данных терминала'))
    }
    const channel = this.terminals.get(sessionId)?.channel
    if (!channel || channel.destroyed) throw new Error(t('SSH-терминал не подключён'))
    channel.write(data)
  }

  resize(sessionId: string, columns: number, rows: number): void {
    const channel = this.terminals.get(sessionId)?.channel
    if (!channel || channel.destroyed) return
    channel.setWindow(
      validDimension(rows, 2, 300),
      validDimension(columns, 10, 500),
      0,
      0
    )
  }

  close(sessionId: string): void {
    const terminal = this.terminals.get(sessionId)
    if (!terminal) return
    terminal.closing = true
    this.terminals.delete(sessionId)
    terminal.channel?.end()
    terminal.client.end()
    this.state({ sessionId, status: 'closed' })
  }

  closeAll(): void {
    for (const sessionId of [...this.terminals.keys()]) this.close(sessionId)
  }
}

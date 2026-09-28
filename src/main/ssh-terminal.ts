import { createHash, randomUUID } from 'node:crypto'
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

interface AutomationShell {
  client: Client
  channel: ClientChannel | null
  decoder: StringDecoder
  closing: boolean
  pending: {
    marker: string
    output: string
    resolve: (output: string) => void
    reject: (error: Error) => void
  } | null
  tail: Promise<void>
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
  private automationShells = new Map<string, AutomationShell>()

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

  /**
   * Open one persistent, non-interactive shell for an entire macro. Keeping a
   * single shell is important: a `cd`, exported variable or activated virtual
   * environment from one command must still exist for the next command.
   */
  async startAutomation(sessionId: string, cwd: string): Promise<void> {
    this.stopAutomation(sessionId)
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
    const expectedFingerprint = this.store.resolveSite(site.id)?.hostKeyFingerprint
    const port = site.protocol === 'sftp' ? site.port : (site.sshPort ?? 22)
    const client = new Client()
    const shell: AutomationShell = {
      client,
      channel: null,
      decoder: new StringDecoder('utf8'),
      closing: false,
      pending: null,
      tail: Promise.resolve()
    }
    this.automationShells.set(sessionId, shell)

    try {
      await new Promise<void>((resolve, reject) => {
        let ready = false
        const fail = (error: Error): void => {
          if (shell.closing || this.automationShells.get(sessionId) !== shell) return
          if (!ready) reject(error)
          this.failAutomation(sessionId, shell, error)
        }
        client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
          done(prompts.map(() => site.password ?? ''))
        })
        client.on('error', fail)
        client.on('close', () => fail(new Error(t('SSH-соединение закрыто'))))
        client.once('ready', () => {
          client.exec('/bin/sh', (error, channel) => {
            if (error) return fail(error)
            ready = true
            shell.channel = channel
            channel.on('data', (chunk: Buffer) => this.consumeAutomationData(sessionId, shell, chunk))
            channel.stderr.on('data', (chunk: Buffer) =>
              this.consumeAutomationData(sessionId, shell, chunk)
            )
            channel.once('close', () => fail(new Error(t('SSH-соединение закрыто'))))
            resolve()
          })
        })
        client.connect({
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
            if (expectedFingerprint && expectedFingerprint !== fingerprint) return false
            if (!expectedFingerprint) void this.store.touchSite(site.id, fingerprint)
            return true
          }
        })
      })

      const target = cwd.trim()
      if (target) await this.execute(sessionId, `cd ${shellQuote(target)}`, false)
    } catch (error) {
      this.stopAutomation(sessionId)
      throw error
    }
  }

  /** Queue one command and resolve only after its exit marker reaches us. */
  execute(sessionId: string, command: string, log = true): Promise<string> {
    const value = command.trim()
    if (!value || value.length > 4096 || value.includes('\0')) {
      return Promise.reject(new Error(t('Команда должна быть от 1 до 4096 символов')))
    }
    const shell = this.automationShells.get(sessionId)
    if (!shell?.channel || shell.channel.destroyed) {
      return Promise.reject(new Error(t('SSH-сессия макроса не готова')))
    }
    let resolveResult!: (output: string) => void
    let rejectResult!: (error: Error) => void
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const run = async (): Promise<void> => {
      try {
        const output = await this.executeAutomationNow(sessionId, shell, value, log)
        resolveResult(output)
      } catch (error) {
        rejectResult(error as Error)
      }
    }
    shell.tail = shell.tail.then(run, run)
    return result
  }

  private executeAutomationNow(
    sessionId: string,
    shell: AutomationShell,
    command: string,
    log: boolean
  ): Promise<string> {
    const channel = shell.channel
    if (!channel || channel.destroyed) {
      return Promise.reject(new Error(t('SSH-сессия макроса не готова')))
    }
    if (log) this.sessions.log(sessionId, 'send', t('[макрос] SSH: {0}', command))
    const marker = `__KREOS_${randomUUID().replace(/-/g, '')}__`
    return new Promise<string>((resolve, reject) => {
      shell.pending = { marker, output: '', resolve, reject }
      channel.write(
        `${command}\n__kreos_status=$?\nprintf '\\n${marker}:%s\\n' "$__kreos_status"\n`
      )
    }).then((output) => {
      const summary = output.trim()
      if (log && summary) {
        const logged = summary.length > 2_000 ? `${summary.slice(0, 2_000)}…` : summary
        this.sessions.log(sessionId, 'recv', t('[макрос] {0}', logged))
      }
      return output
    })
  }

  private consumeAutomationData(
    sessionId: string,
    shell: AutomationShell,
    chunk: Buffer
  ): void {
    const pending = shell.pending
    if (!pending) return
    pending.output += shell.decoder.write(chunk)
    if (Buffer.byteLength(pending.output, 'utf8') > 1_048_576) {
      shell.pending = null
      pending.reject(new Error(t('Вывод SSH-команды превышает 1 МБ')))
      this.stopAutomation(sessionId)
      return
    }
    const marker = `\n${pending.marker}:`
    const markerAt = pending.output.indexOf(marker)
    if (markerAt < 0) return
    const tail = pending.output.slice(markerAt + marker.length)
    const match = /^(\d+)/.exec(tail)
    if (!match) return
    const output = pending.output.slice(0, markerAt)
    const exitCode = Number(match[1])
    shell.pending = null
    if (exitCode === 0) pending.resolve(output)
    else pending.reject(new Error(t('SSH-команда завершилась с кодом {0}: {1}', exitCode, output.trim())))
  }

  private failAutomation(sessionId: string, shell: AutomationShell, error: Error): void {
    if (this.automationShells.get(sessionId) !== shell) return
    this.automationShells.delete(sessionId)
    shell.pending?.reject(error)
    shell.pending = null
    shell.client.end()
  }

  stopAutomation(sessionId: string): void {
    const shell = this.automationShells.get(sessionId)
    if (!shell) return
    shell.closing = true
    this.automationShells.delete(sessionId)
    shell.pending?.reject(new Error(t('SSH-сессия макроса закрыта')))
    shell.pending = null
    shell.channel?.end()
    shell.client.end()
  }

  close(sessionId: string): void {
    this.stopAutomation(sessionId)
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
    for (const sessionId of [...this.automationShells.keys()]) this.stopAutomation(sessionId)
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

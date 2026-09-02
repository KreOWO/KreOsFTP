import { randomUUID } from 'node:crypto'
import { setLanguage, t } from '../shared/i18n'
import { copyFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type QuickCommand,
  type SiteConfig,
  type SiteSummary
} from '@shared/types'

/** On-disk shape. Secrets are ciphertext, never plaintext. */
interface StoredSite extends Omit<SiteConfig, 'password' | 'passphrase'> {
  passwordEnc?: string
  passphraseEnc?: string
}

interface StoreFile {
  version: 2
  sites: StoredSite[]
  settings: AppSettings
}

const EMPTY: StoreFile = { version: 2, sites: [], settings: { ...DEFAULT_SETTINGS } }

/**
 * Secrets go through Electron's `safeStorage`, which is DPAPI on Windows and the
 * Keychain / libsecret elsewhere: the ciphertext is bound to the OS user account,
 * so copying `sites.json` to another machine yields nothing usable.
 *
 * When the platform has no backend available we refuse to write the secret at all
 * rather than silently persisting it in the clear.
 */
export class Store {
  private file: string
  private data: StoreFile = { ...EMPTY }
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()
  /** Ciphertexts already reported as unreadable, to keep the log quiet. */
  private warnedSecrets = new Set<string>()

  constructor(
    fileOverride?: string,
    /** Reports problems that would otherwise surface as confusing auth errors. */
    private onWarn?: (message: string) => void
  ) {
    this.file = fileOverride ?? join(app.getPath('userData'), 'sites.json')
  }

  private encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private encrypt(value: string | undefined): string | undefined {
    if (!value) return undefined
    if (!this.encryptionAvailable()) return undefined
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string | undefined): string | undefined {
    if (!value) return undefined
    if (!this.encryptionAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch (err) {
      // Another OS user, a profile copied between machines, or a key store that
      // was reset. Staying silent here turns into a misleading "530
      // Authentication failed" three layers up, so say it out loud.
      // `listSites` расшифровывает при каждом вызове, поэтому предупреждаем
      // один раз на секрет, а не на каждую перерисовку списка.
      if (!this.warnedSecrets.has(value)) {
        this.warnedSecrets.add(value)
        this.onWarn?.(
          t('Сохранённый секрет не удалось расшифровать ({0}). ', (err as Error).message) +
            t('Введите пароль заново — он будет перезаписан.')
        )
      }
      return undefined
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return
    let removedLegacyRemoteDesktop = false
    let upgradedParallelTransfers = false
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as StoreFile
      const sites = Array.isArray(parsed.sites)
        ? parsed.sites.map((stored) => {
            const site = { ...stored } as StoredSite & { vncPort?: number; rdpPort?: number }
            if ('vncPort' in site || 'rdpPort' in site) removedLegacyRemoteDesktop = true
            delete site.vncPort
            delete site.rdpPort
            return site
          })
        : []
      this.data = {
        version: 2,
        sites,
        settings: {
          ...DEFAULT_SETTINGS,
          ...(parsed.settings ?? {}),
          concurrentTransfers:
            Number(parsed.version) < 2
              ? DEFAULT_SETTINGS.concurrentTransfers
              : Math.max(1, Math.min(6, Number(parsed.settings?.concurrentTransfers) || 3))
        }
      }
      upgradedParallelTransfers = Number(parsed.version) < 2
    } catch {
      this.data = { version: 2, sites: [], settings: { ...DEFAULT_SETTINGS } }
    }
    this.loaded = true
    setLanguage(this.data.settings.language)
    if (removedLegacyRemoteDesktop || upgradedParallelTransfers) await this.persist()
  }

  /** Serialised, atomic writes — a crash mid-save must not lose the site list. */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })

      // Одна копия предыдущего состояния. Атомарная запись защищает от
      // повреждения файла, но не от ошибочного удаления профиля: пароли
      // шифрует ОС, а восстановить сам список неоткуда. Копия делается до
      // перезаписи и переживает ровно одно неверное действие — этого хватает,
      // чтобы вернуть подключения вручную.
      await copyFile(this.file, this.file + '.bak').catch((error: NodeJS.ErrnoException) => {
        // Первого запуска ещё не было — копировать нечего.
        if (error.code !== 'ENOENT') throw error
      })

      const tmp = this.file + '.tmp'
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      await rename(tmp, this.file)
    })
    return this.writeChain
  }

  isEncryptionAvailable(): boolean {
    return this.encryptionAvailable()
  }

  listSites(): SiteSummary[] {
    return this.data.sites
      .map((s) => this.toSummary(s))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name))
  }

  /**
   * Reports whether a secret is *usable*, not merely present: ciphertext that no
   * longer decrypts must behave exactly like no stored secret, so the UI asks
   * for the password instead of silently sending an empty one.
   */
  private toSummary(s: StoredSite): SiteSummary {
    const { passwordEnc, passphraseEnc, ...rest } = s
    return {
      ...rest,
      hasStoredPassword: this.decrypt(passwordEnc) !== undefined,
      hasStoredPassphrase: this.decrypt(passphraseEnc) !== undefined
    }
  }

  /** Insert or update. An empty `password` on an existing site keeps the stored one. */
  async saveSite(input: Partial<SiteConfig> & { name: string; host: string }): Promise<SiteSummary> {
    const now = Date.now()
    const existingIdx = input.id ? this.data.sites.findIndex((s) => s.id === input.id) : -1
    const existing = existingIdx >= 0 ? this.data.sites[existingIdx] : undefined

    const merged: StoredSite = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name.trim() || input.host,
      protocol: input.protocol ?? existing?.protocol ?? 'sftp',
      host: input.host.trim(),
      port: input.port ?? existing?.port ?? 22,
      authMode: input.authMode ?? existing?.authMode ?? 'password',
      user: input.user ?? existing?.user ?? '',
      privateKeyPath: input.privateKeyPath ?? existing?.privateKeyPath,
      remoteDir: input.remoteDir ?? existing?.remoteDir,
      localDir: input.localDir ?? existing?.localDir,
      sshPort: input.sshPort ?? existing?.sshPort,
      quickCommands: input.quickCommands ?? existing?.quickCommands,
      rejectUnauthorized: input.rejectUnauthorized ?? existing?.rejectUnauthorized ?? true,
      hostKeyFingerprint: input.hostKeyFingerprint ?? existing?.hostKeyFingerprint,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: existing?.lastUsedAt,
      passwordEnc: input.password ? this.encrypt(input.password) : existing?.passwordEnc,
      passphraseEnc: input.passphrase ? this.encrypt(input.passphrase) : existing?.passphraseEnc
    }

    if (existingIdx >= 0) this.data.sites[existingIdx] = merged
    else this.data.sites.push(merged)
    await this.persist()
    return this.toSummary(merged)
  }

  async deleteSite(id: string): Promise<void> {
    this.data.sites = this.data.sites.filter((s) => s.id !== id)
    await this.persist()
  }

  async clearSecret(id: string, which: 'password' | 'passphrase'): Promise<void> {
    const site = this.data.sites.find((s) => s.id === id)
    if (!site) return
    if (which === 'password') delete site.passwordEnc
    else delete site.passphraseEnc
    await this.persist()
  }

  async saveQuickCommands(id: string, input: QuickCommand[]): Promise<SiteSummary> {
    const site = this.data.sites.find((stored) => stored.id === id)
    if (!site) throw new Error(t('Профиль подключения не найден'))
    if (!Array.isArray(input) || input.length > 30) throw new Error(t('Слишком много быстрых команд'))
    const seen = new Set<string>()
    site.quickCommands = input.map((item) => {
      const idValue = String(item.id ?? '').trim()
      const label = String(item.label ?? '').trim()
      const command = String(item.command ?? '').trim()
      if (!idValue || seen.has(idValue)) throw new Error(t('Некорректный идентификатор команды'))
      if (!label || label.length > 40) throw new Error(t('Название команды должно быть от 1 до 40 символов'))
      if (!command || command.length > 4096 || command.includes('\0')) {
        throw new Error(t('Команда должна быть от 1 до 4096 символов'))
      }
      seen.add(idValue)
      return { id: idValue, label, command }
    })
    await this.persist()
    return this.toSummary(site)
  }

  async touchSite(id: string, hostKeyFingerprint?: string): Promise<void> {
    const site = this.data.sites.find((s) => s.id === id)
    if (!site) return
    site.lastUsedAt = Date.now()
    if (hostKeyFingerprint && !site.hostKeyFingerprint) {
      site.hostKeyFingerprint = hostKeyFingerprint
    }
    await this.persist()
  }

  /** Full config with secrets decrypted — main process only, never sent to the renderer. */
  resolveSite(id: string): SiteConfig | undefined {
    const s = this.data.sites.find((x) => x.id === id)
    if (!s) return undefined
    const { passwordEnc, passphraseEnc, ...rest } = s
    return {
      ...rest,
      password: this.decrypt(passwordEnc),
      passphrase: this.decrypt(passphraseEnc)
    }
  }

  getSettings(): AppSettings {
    return { ...this.data.settings }
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (patch.concurrentTransfers !== undefined) {
      patch.concurrentTransfers = Math.max(
        1,
        Math.min(6, Math.round(Number(patch.concurrentTransfers) || 1))
      )
    }
    this.data.settings = { ...this.data.settings, ...patch }
    if (patch.language) setLanguage(patch.language)
    await this.persist()
    return this.getSettings()
  }
}

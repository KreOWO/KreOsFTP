import { createConnection } from 'node:net'
import { t } from '../../shared/i18n'
import type { Protocol } from '@shared/types'

/**
 * Reads the first thing a server says on connect.
 *
 * Both protocols announce themselves before anything else: FTP with a numeric
 * reply (`220 ...`), SSH with an identification string (`SSH-2.0-...`). That
 * makes a failed handshake explainable from evidence instead of guesswork.
 *
 * Never throws — a probe that fails simply yields no extra information.
 */
export function probeBanner(host: string, port: number, timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    const socket = createConnection({ host, port })
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.once('error', () => finish(null))
    socket.once('data', (chunk: Buffer) => finish(chunk.toString('latin1', 0, 128).trim()))
  })
}

/**
 * Explains a connection failure when the banner shows the other protocol —
 * by far the most common cause of a handshake that goes nowhere.
 * Returns null when the banner proves nothing.
 */
export function protocolMismatchHint(banner: string | null, attempted: Protocol): string | null {
  if (!banner) return null
  const looksSsh = banner.startsWith('SSH-')
  const looksFtp = /^\d{3}[ -]/.test(banner)

  if (attempted === 'sftp' && looksFtp) {
    return (
      t('Сервер поздоровался как FTP («{0}»), а не как SSH. ', banner.slice(0, 60)) +
      t('Измените протокол подключения на FTP или FTPS.')
    )
  }
  if (attempted !== 'sftp' && looksSsh) {
    return (
      t('Сервер поздоровался как SSH («{0}»), а не как FTP. ', banner.slice(0, 60)) +
      t('Измените протокол подключения на SFTP.')
    )
  }
  return null
}

/**
 * Refuses the connection up front when the banner already proves the protocol
 * is wrong. Both protocols greet immediately, so this costs milliseconds and
 * replaces a handshake that would otherwise time out for a minute or more.
 *
 * Silent on any doubt: no banner, or a banner that proves nothing, lets the
 * real connection attempt proceed.
 */
export async function assertProtocolMatches(
  host: string,
  port: number,
  attempted: Protocol
): Promise<void> {
  const hint = protocolMismatchHint(await probeBanner(host, port, 4000), attempted)
  if (hint) throw new Error(hint)
}

/** Wraps a connect failure with the mismatch hint when the evidence supports one. */
export async function explainConnectFailure(
  error: Error,
  host: string,
  port: number,
  attempted: Protocol
): Promise<{ message: string; hint: string | null }> {
  const hint = protocolMismatchHint(await probeBanner(host, port), attempted)
  return { message: hint ? `${error.message}. ${hint}` : error.message, hint }
}

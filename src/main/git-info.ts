import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { GitRepositoryInfo } from '@shared/types'

const run = promisify(execFile)

async function git(cwd: string, args: string[], timeout = 5000): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      // A network command must never stop the app to ask for credentials.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: ''
    }
  })
  return stdout.trim()
}

/**
 * Turns whatever `origin` is configured as into a URL a browser can open.
 * Handles the SSH shorthand (`git@host:owner/repo.git`) as well as https.
 * Returns null for anything that is not clearly a web-reachable https host.
 */
export function toWebUrl(remote: string | null): string | null {
  if (!remote) return null
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/.exec(remote)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  try {
    const url = new URL(remote)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}${url.pathname.replace(/\.git$/, '')}`
  } catch {
    return null
  }
}

/**
 * Asks the remote for its current HEAD without touching the local repository.
 *
 * `ls-remote` is read-only and does not create refs, unlike `fetch`, so the
 * check cannot surprise anyone by moving their branches. It is also the only
 * way to know an update exists: comparing against the remote-tracking ref would
 * report nothing until the user happened to fetch.
 *
 * Any failure — offline, private repo, no credentials — yields null, and the
 * button simply shows no update rather than an error.
 */
async function readRemoteHead(root: string, branch: string): Promise<string | null> {
  try {
    const line = await git(root, ['ls-remote', '--heads', 'origin', branch], 6000)
    const sha = line.split(/\s+/)[0]
    return /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : null
  } catch {
    return null
  }
}

export async function readGitInfo(): Promise<GitRepositoryInfo | null> {
  const candidates = [...new Set([process.cwd(), app.getAppPath()])]
  for (const candidate of candidates) {
    try {
      const root = await git(candidate, ['rev-parse', '--show-toplevel'])
      const [branch, head, commit, remote, status] = await Promise.all([
        git(root, ['branch', '--show-current']),
        git(root, ['rev-parse', 'HEAD']),
        git(root, ['rev-parse', '--short=8', 'HEAD']),
        git(root, ['remote', 'get-url', 'origin']).catch(() => ''),
        git(root, ['status', '--porcelain'])
      ])

      const remoteHead = remote && branch ? await readRemoteHead(root, branch) : null
      // Only a remote commit we do not have counts as an update. A local commit
      // the remote lacks is unpushed work, which is a different situation.
      const hasRemoteCommit = remoteHead !== null && remoteHead !== head
      const updateAvailable =
        hasRemoteCommit &&
        !(await git(root, ['merge-base', '--is-ancestor', remoteHead, head])
          .then(() => true)
          .catch(() => false))

      return {
        root,
        branch: branch || '(detached HEAD)',
        commit,
        remote: remote || null,
        webUrl: toWebUrl(remote || null),
        changedFiles: status ? status.split(/\r?\n/).length : 0,
        remoteCommit: remoteHead ? remoteHead.slice(0, 8) : null,
        updateAvailable
      }
    } catch {
      /* Packaged builds normally have no .git; try the next plausible root. */
    }
  }
  return null
}

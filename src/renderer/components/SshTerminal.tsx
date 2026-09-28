import { useEffect, useRef, useState } from 'react'
import { t } from '../../shared/i18n'
import { useScrollEdges } from '../useScrollEdges'
import type {
  PointerEvent as ReactPointerEvent,
  ReactElement,
  WheelEvent as ReactWheelEvent
} from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { QuickCommand, SshTerminalState } from '@shared/types'
import { IconCopy, IconPaste, IconPlus, IconTrash, IconX } from './Icons'
import { tooltipWithHotkey } from '../hotkeys'

interface SshTerminalProps {
  sessionId: string
  name: string
  commands: QuickCommand[]
  onCommandsChange: (commands: QuickCommand[]) => Promise<void>
  onClose: () => void
  toggleHotkey: string
}

export function SshTerminal({
  sessionId,
  name,
  commands,
  onCommandsChange,
  onClose,
  toggleHotkey
}: SshTerminalProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const quickStripRef = useRef<HTMLDivElement>(null)
  useScrollEdges(quickStripRef)
  const quickDragRef = useRef<{
    pointerId: number
    startX: number
    startScroll: number
    moved: boolean
  } | null>(null)
  const suppressQuickClickRef = useRef(false)
  const [state, setState] = useState<SshTerminalState['status']>('connecting')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [quickLabel, setQuickLabel] = useState('')
  const [quickCommand, setQuickCommand] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [quickError, setQuickError] = useState<string | null>(null)

  const copy = (): void => {
    const selected = terminalRef.current?.getSelection() ?? ''
    if (selected) window.kreos.clipboard.writeText(selected)
  }

  const paste = (): void => {
    const text = window.kreos.clipboard.readText()
    // xterm's paste() normalises line endings and honours bracketed paste mode,
    // then hands the text to onData like typed input.
    if (text) terminalRef.current?.paste(text)
    terminalRef.current?.focus()
  }

  const sendInput = (input: string): void => {
    void window.kreos.ssh.write(sessionId, input).catch((error: Error) => {
      terminalRef.current?.writeln(`\r\n\x1b[31m${error.message}\x1b[0m`)
    })
    terminalRef.current?.focus()
  }

  const runQuickCommand = (command: string): void => {
    sendInput(command.replace(/\r?\n/g, '\r').replace(/\r+$/, '') + '\r')
  }

  const openAddCommand = (): void => {
    setEditingId(null)
    setQuickLabel('')
    setQuickCommand('')
    setQuickError(null)
    setEditorOpen(true)
  }

  const openCommandEditor = (command: QuickCommand): void => {
    setEditingId(command.id)
    setQuickLabel(command.label)
    setQuickCommand(command.command)
    setQuickError(null)
    setEditorOpen(true)
  }

  const saveQuickCommand = async (): Promise<void> => {
    const label = quickLabel.trim()
    const command = quickCommand.trim()
    if (!label || !command || quickBusy) return
    setQuickBusy(true)
    setQuickError(null)
    try {
      const next = editingId
        ? commands.map((item) => (item.id === editingId ? { ...item, label, command } : item))
        : [...commands, { id: crypto.randomUUID(), label, command }]
      await onCommandsChange(next)
      setQuickLabel('')
      setQuickCommand('')
      setEditingId(null)
      setEditorOpen(false)
    } catch (error) {
      setQuickError((error as Error).message)
    } finally {
      setQuickBusy(false)
    }
  }

  const removeQuickCommand = async (id: string): Promise<void> => {
    if (quickBusy) return
    setQuickBusy(true)
    setQuickError(null)
    try {
      await onCommandsChange(commands.filter((command) => command.id !== id))
      if (editingId === id) {
        setEditingId(null)
        setQuickLabel('')
        setQuickCommand('')
        setEditorOpen(false)
      }
    } catch (error) {
      setQuickError((error as Error).message)
    } finally {
      setQuickBusy(false)
    }
  }

  const scrollQuickCommands = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const strip = event.currentTarget
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    strip.scrollLeft += delta
    event.stopPropagation()
  }

  const startQuickDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    quickDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScroll: event.currentTarget.scrollLeft,
      moved: false
    }
  }

  const moveQuickDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = quickDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const distance = event.clientX - drag.startX
    if (Math.abs(distance) > 3 && !drag.moved) {
      drag.moved = true
      // Capture only after a real drag begins. Capturing on pointer-down makes
      // the following click target the strip instead of the command button.
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.classList.add('is-dragging')
    }
    if (!drag.moved) return
    event.preventDefault()
    event.currentTarget.scrollLeft = drag.startScroll - distance
  }

  const stopQuickDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = quickDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    suppressQuickClickRef.current = drag.moved
    quickDragRef.current = null
    event.currentTarget.classList.remove('is-dragging')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.moved) setTimeout(() => (suppressQuickClickRef.current = false), 0)
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: "'Cascadia Mono', Consolas, 'Segoe UI Emoji', monospace",
      fontSize: 12,
      lineHeight: 1.15,
      scrollback: 5000,
      // xterm exposes Unicode width providers through its proposed API.
      // Unicode 11 fixes cell widths for modern emoji and prevents adjacent
      // prompt glyphs from being painted into the same terminal cell.
      allowProposedApi: true,
      theme: {
        background: '#0b0f14',
        foreground: '#d7e0ea',
        cursor: '#4dabf7',
        selectionBackground: '#31506b',
        black: '#141a22',
        red: '#ff6b6b',
        green: '#69db7c',
        yellow: '#ffd43b',
        blue: '#4dabf7',
        magenta: '#da77f2',
        cyan: '#3bc9db',
        white: '#e3eaf3'
      }
    })
    const fit = new FitAddon()
    const unicode = new Unicode11Addon()
    terminal.loadAddon(unicode)
    terminal.unicode.activeVersion = '11'
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    terminal.writeln(t('[90mПодключение SSH…[0m'))

    let resizeFrame = 0
    let lastColumns = 0
    let lastRows = 0
    const fitAndResize = (): void => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (!host.isConnected) return
        fit.fit()
        if (terminal.cols !== lastColumns || terminal.rows !== lastRows) {
          lastColumns = terminal.cols
          lastRows = terminal.rows
          void window.kreos.ssh.resize(sessionId, terminal.cols, terminal.rows).catch(() => undefined)
        }
      })
    }

    const offData = window.kreos.events.onSshData((payload) => {
      if (payload.sessionId === sessionId) terminal.write(payload.data)
    })
    const offState = window.kreos.events.onSshState((payload) => {
      if (payload.sessionId !== sessionId) return
      setState(payload.status)
      if (payload.status === 'error' && payload.message) {
        terminal.writeln(`\r\n\x1b[31m${payload.message}\x1b[0m`)
      }
    })
    const input = terminal.onData((data) => {
      void window.kreos.ssh.write(sessionId, data).catch((error: Error) => {
        terminal.writeln(`\r\n\x1b[31m${error.message}\x1b[0m`)
      })
    })
    // Ctrl+C / Ctrl+V (Shift optional) work with the local clipboard and never
    // reach the server; the toolbar buttons send ^C / ^V instead. Alt is
    // excluded because AltGr arrives as Ctrl+Alt and types characters.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true
      if (event.code !== 'KeyC' && event.code !== 'KeyV') return true
      // Returning false only stops xterm; without preventDefault Chromium
      // would still fire its own paste event and xterm would paste twice.
      event.preventDefault()
      if (event.code === 'KeyC') copy()
      else paste()
      return false
    })

    const observer = new ResizeObserver(fitAndResize)
    observer.observe(host)
    fit.fit()
    lastColumns = terminal.cols
    lastRows = terminal.rows
    void window.kreos.ssh
      .open(sessionId, terminal.cols, terminal.rows)
      .then(() => terminal.focus())
      .catch((error: Error) => {
        setState('error')
        terminal.writeln(`\r\n\x1b[31mSSH: ${error.message}\x1b[0m`)
      })

    return () => {
      observer.disconnect()
      cancelAnimationFrame(resizeFrame)
      input.dispose()
      offData()
      offState()
      terminal.dispose()
      terminalRef.current = null
      void window.kreos.ssh.close(sessionId).catch(() => undefined)
    }
    // One xterm instance belongs to exactly one SSH session.
  }, [sessionId])

  return (
    <section className="ssh-terminal" aria-label={t('SSH-терминал {0}', name)}>
      <div className="ssh-terminal__bar">
        <div className="ssh-terminal__lead">
          <span className={`ssh-terminal__state ssh-terminal__state--${state}`} />
          <strong>SSH</strong>
          <span className="ssh-terminal__name">{name}</span>
          <button
            className="btn btn--ghost btn--icon ssh-terminal__quick-add"
            type="button"
            onClick={() =>
              editorOpen && editingId === null ? setEditorOpen(false) : openAddCommand()
            }
            data-tooltip={t('Добавить быструю SSH-команду')}
            aria-label={t('Добавить быструю SSH-команду')}
          >
            <IconPlus size={12} />
          </button>
        </div>
        <div
          ref={quickStripRef}
          className="ssh-terminal__commands"
          onWheel={scrollQuickCommands}
          onPointerDown={startQuickDrag}
          onPointerMove={moveQuickDrag}
          onPointerUp={stopQuickDrag}
          onPointerCancel={stopQuickDrag}
        >
          {commands.map((command) => (
            <button
              key={command.id}
              className="ssh-terminal__command"
              type="button"
              onClick={() => {
                if (suppressQuickClickRef.current) return
                runQuickCommand(command.command)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                openCommandEditor(command)
              }}
              data-tooltip={t('Выполнить: {0}', command.command)}
            >
              {command.label}
            </button>
          ))}
        </div>
        <div className="ssh-terminal__fixed-actions">
          <button
            className="btn btn--ghost btn--icon ssh-terminal__action"
            type="button"
            onClick={() => sendInput('\x03')}
            data-tooltip={t('Отправить Ctrl+C на сервер')}
            aria-label={t('Отправить Ctrl+C на сервер')}
          >
            <IconCopy size={13} />
          </button>
          <button
            className="btn btn--ghost btn--icon ssh-terminal__action"
            type="button"
            onClick={() => sendInput('\x16')}
            data-tooltip={t('Отправить Ctrl+V на сервер')}
            aria-label={t('Отправить Ctrl+V на сервер')}
          >
            <IconPaste size={13} />
          </button>
          <button
            className="btn btn--ghost btn--icon ssh-terminal__action"
            type="button"
            onClick={onClose}
            aria-label={t('Закрыть SSH-терминал')}
            data-tooltip={tooltipWithHotkey(t('Закрыть SSH-терминал'), toggleHotkey)}
          >
            <IconX size={12} />
          </button>
        </div>
      </div>
      {editorOpen && (
        <div className="ssh-terminal__quick-editor">
          <div className="ssh-terminal__quick-head">
            <strong>{editingId ? t('Изменить быструю команду') : t('Новая быстрая команда')}</strong>
            <span className="ssh-terminal__quick-head-actions">
              {editingId && (
                <button
                  className="btn btn--ghost btn--icon"
                  type="button"
                  disabled={quickBusy}
                  onClick={() => void removeQuickCommand(editingId)}
                  aria-label={t('Удалить быструю команду')}
                  data-tooltip={t('Удалить быструю команду')}
                >
                  <IconTrash size={11} />
                </button>
              )}
              <button
                className="btn btn--ghost btn--icon"
                type="button"
                onClick={() => setEditorOpen(false)}
                aria-label={t('Закрыть редактор быстрых команд')}
              >
                <IconX size={11} />
              </button>
            </span>
          </div>
          <input
            className="input"
            value={quickLabel}
            maxLength={40}
            placeholder={t('Название, например Статус')}
            onChange={(event) => setQuickLabel(event.target.value)}
          />
          <input
            className="input input--mono"
            value={quickCommand}
            maxLength={4096}
            placeholder="git status"
            onChange={(event) => setQuickCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveQuickCommand()
              if (event.key === 'Escape') setEditorOpen(false)
            }}
          />
          <button
            className="btn btn--primary"
            type="button"
            disabled={!quickLabel.trim() || !quickCommand.trim() || quickBusy}
            onClick={() => void saveQuickCommand()}
          >
            {editingId ? t('Сохранить') : t('Добавить')}
          </button>
          {commands.length > 0 && (
            <div className="ssh-terminal__quick-list">
              {commands.map((command) => (
                <div key={command.id}>
                  <span>{command.label}</span>
                  <code>{command.command}</code>
                  <button
                    className="btn btn--ghost btn--icon"
                    type="button"
                    disabled={quickBusy}
                    onClick={() => void removeQuickCommand(command.id)}
                    aria-label={t('Удалить команду {0}', command.label)}
                  >
                    <IconTrash size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {quickError && <div className="notice notice--danger">{quickError}</div>}
        </div>
      )}
      <div ref={hostRef} className="ssh-terminal__screen" />
    </section>
  )
}

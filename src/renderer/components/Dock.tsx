import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../shared/i18n'
import type { ReactElement } from 'react'
import type { LogLine, TransferItem, TransferStatus } from '@shared/types'
import { formatClock, formatEta, formatSize, formatSpeed } from '../format'
import { IconRetry, IconTrash, IconX } from './Icons'

interface DockProps {
  transfers: TransferItem[]
  preparingSync: 'upload' | 'download' | null
  logs: LogLine[]
  /** Null means "all sessions"; otherwise the log is filtered to one connection. */
  sessionFilter: string | null
  onCancel: (itemId: string) => void
  onRetry: (itemId: string) => void
  onClearFinished: () => void
  onClearLog: () => void
  height: number
  onResize: (height: number) => void
}

function PreparationRow({ direction }: { direction: 'upload' | 'download' }): ReactElement {
  const upload = direction === 'upload'
  return (
    <div className="transfer transfer--preparing">
      <span className={`transfer__dir transfer__dir--${direction}`}>{upload ? '↑' : '↓'}</span>
      <span className="transfer__main">
        <span className="transfer__name">
          {upload ? t('Подготовка обновления сервера') : t('Подготовка обновления локальной папки')}
        </span>
        <span className="transfer__path">
          
          {t('Чтение .ftpignore, обход каталогов и сравнение размеров')}
        </span>
      </span>
      <span>
        <div className="progress">
          <div className="progress__fill progress__fill--indeterminate" />
        </div>
      </span>
      <span className="transfer__num">{t('Подготовка списка')}</span>
      <span className="status-pill status-pill--active">{t('подготовка')}</span>
      <span />
    </div>
  )
}

function statusLabel(status: TransferStatus): string {
  const labels: Record<TransferStatus, string> = {
    pending: t('в очереди'),
    active: t('идёт'),
    done: t('готово'),
    error: t('ошибка'),
    cancelled: t('отменён')
  }
  return labels[status]
}

function TransferRow({
  item,
  onCancel,
  onRetry
}: {
  item: TransferItem
  onCancel: (id: string) => void
  onRetry: (id: string) => void
}): ReactElement {
  const percent =
    item.size && item.size > 0 ? Math.min(100, (item.transferred / item.size) * 100) : 0
  const indeterminate = item.status === 'active' && (!item.size || item.size <= 0)
  const finished = item.status === 'done' || item.status === 'error' || item.status === 'cancelled'

  return (
    <div className="transfer">
      <span className={`transfer__dir transfer__dir--${item.direction}`} title={item.direction === 'upload' ? t('Загрузка на сервер') : t('Скачивание')}>
        {item.direction === 'upload' ? '↑' : '↓'}
      </span>

      <span className="transfer__main">
        <span className="transfer__name">{item.name}</span>
        <span className="transfer__path" title={item.direction === 'upload' ? item.remotePath : item.localPath}>
          {item.direction === 'upload' ? item.remotePath : item.localPath}
        </span>
        {item.error && (
          <span className="transfer__path" style={{ color: 'var(--danger)', direction: 'ltr' }}>
            {item.error}
          </span>
        )}
      </span>

      <span>
        <div className="progress">
          <div
            className={'progress__fill' + (indeterminate ? ' progress__fill--indeterminate' : '')}
            style={{
              width: item.status === 'done' ? '100%' : `${percent}%`,
              background: item.status === 'error' ? 'var(--danger)' : undefined
            }}
          />
        </div>
        <span className="transfer__num" style={{ display: 'block', marginTop: 3, textAlign: 'left' }}>
          {formatSize(item.transferred)}
          {item.size !== null ? ` / ${formatSize(item.size)}` : ''}
        </span>
      </span>

      <span className="transfer__num">
        {item.status === 'active' ? formatSpeed(item.speed) : ''}
        {item.status === 'active' && (
          <span style={{ display: 'block', color: 'var(--text-faint)' }}>
            {formatEta(item.size, item.transferred, item.speed)}
          </span>
        )}
      </span>

      <span className={`status-pill status-pill--${item.status}`}>{statusLabel(item.status)}</span>

      <span>
        {finished ? (
          item.status !== 'done' && (
            <button
              className="btn btn--ghost btn--icon"
              onClick={() => onRetry(item.id)}
              title={t('Повторить')}
            >
              <IconRetry size={13} />
            </button>
          )
        ) : (
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => onCancel(item.id)}
            title={t('Отменить')}
          >
            <IconX size={13} />
          </button>
        )}
      </span>
    </div>
  )
}

export function Dock(props: DockProps): ReactElement {
  const {
    transfers,
    preparingSync,
    logs,
    sessionFilter,
    onCancel,
    onRetry,
    onClearFinished,
    onClearLog,
    height,
    onResize
  } = props
  const [tab, setTab] = useState<'active' | 'history' | 'log'>('active')
  const logRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const activeTransfers = useMemo(
    () => transfers.filter((t) => t.status === 'active' || t.status === 'pending'),
    [transfers]
  )
  const historyTransfers = useMemo(
    () => transfers.filter((t) => t.status !== 'active' && t.status !== 'pending'),
    [transfers]
  )
  const showPreparation = preparingSync !== null && activeTransfers.length === 0

  useLayoutEffect(() => {
    if (preparingSync) setTab('active')
  }, [preparingSync])

  const visibleLogs = useMemo(
    () => (sessionFilter ? logs.filter((l) => l.sessionId === sessionFilter || l.sessionId === null) : logs),
    [logs, sessionFilter]
  )

  // Follow the tail only while the user has not scrolled up to read history.
  useLayoutEffect(() => {
    const el = logRef.current
    if (!el || tab !== 'log' || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [visibleLogs, tab])

  const onLogScroll = (): void => {
    const el = logRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget
    dragRef.current = { startY: event.clientY, startH: height }
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing-vertical')
  }

  const resizeMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const next = drag.startH + drag.startY - event.clientY
    onResize(Math.max(112, Math.min(next, Math.max(112, window.innerHeight - 300))))
  }

  const resizeEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('is-resizing-vertical')
  }

  return (
    <div className="dock" style={{ height }}>
      <div
        className="dock__resize-handle"
        onPointerDown={resize}
        onPointerMove={resizeMove}
        onPointerUp={resizeEnd}
        onPointerCancel={resizeEnd}
        title={t('Изменить высоту панели')}
      />
      <div className="dock__tabs">
        <button
          className={'dock__tab' + (tab === 'active' ? ' dock__tab--active' : '')}
          onClick={() => setTab('active')}
        >
          
          {t('В работе')}
          {activeTransfers.length + (showPreparation ? 1 : 0) > 0 && (
            <span className="dock__count dock__count--active">
              {activeTransfers.length + (showPreparation ? 1 : 0)}
            </span>
          )}
        </button>
        <button
          className={'dock__tab' + (tab === 'history' ? ' dock__tab--active' : '')}
          onClick={() => setTab('history')}
        >
          
          {t('История')}
          {historyTransfers.length > 0 && (
            <span className="dock__count">{historyTransfers.length}</span>
          )}
        </button>
        <button
          className={'dock__tab' + (tab === 'log' ? ' dock__tab--active' : '')}
          onClick={() => setTab('log')}
        >
          
          {t('Журнал')}
          {visibleLogs.length > 0 && <span className="dock__count">{visibleLogs.length}</span>}
        </button>
        <span className="dock__spacer" />
        {tab === 'history' ? (
          <button
            className="btn btn--ghost"
            onClick={onClearFinished}
            disabled={historyTransfers.length === 0}
            title={t('Убрать завершённые из списка')}
          >
            <IconTrash size={13} />  {t('Очистить')}
          </button>
        ) : tab === 'log' ? (
          <button className="btn btn--ghost" onClick={onClearLog} disabled={logs.length === 0}>
            <IconTrash size={13} />  {t('Очистить')}
          </button>
        ) : null}
      </div>

      {tab === 'active' || tab === 'history' ? (
        <div className="dock__body">
          {(tab === 'active' ? activeTransfers : historyTransfers).length === 0 &&
          !(tab === 'active' && showPreparation) ? (
            <div className="empty-note">
              {tab === 'active'
                ? t('Активных передач нет. Выберите файлы и нажмите стрелку между панелями — или перетащите их.')
                : t('История передач пуста.')}
            </div>
          ) : (
            <>
              {tab === 'active' && showPreparation && <PreparationRow direction={preparingSync} />}
              {(tab === 'active' ? activeTransfers : historyTransfers).map((item) => (
                <TransferRow key={item.id} item={item} onCancel={onCancel} onRetry={onRetry} />
              ))}
            </>
          )}
        </div>
      ) : (
        <div className="dock__body log" ref={logRef} onScroll={onLogScroll}>
          {visibleLogs.length === 0 ? (
            <div className="empty-note">{t('Журнал пуст')}</div>
          ) : (
            visibleLogs.map((line) => (
              <div className="log__line" key={line.id}>
                <span className="log__time">{formatClock(line.at)}</span>
                <span className={`log__text--${line.level}`}>{line.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

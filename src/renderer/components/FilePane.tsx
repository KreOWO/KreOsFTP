import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t, plural } from '../../shared/i18n'
import type {
  DragEvent,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode
} from 'react'
import type { FileEntry } from '@shared/types'
import { dndMime, dragKinds, type DragPayload, type DropAccepts, type DroppedTransfer } from '../dnd'
import { useScrollEdges } from '../useScrollEdges'
import { MAX_SIZE_DETAIL, formatDate, formatSize, formatSizeAt } from '../format'
import {
  IconFile,
  IconFolder,
  IconHome,
  IconLink,
  IconNewFolder,
  IconRefresh,
  IconRename,
  IconTrash,
  IconUp
} from './Icons'

export type SortKey = 'name' | 'size' | 'modifiedAt'
export type SortDir = 'asc' | 'desc'

export interface FilePaneProps {
  kind: 'local' | 'remote'
  title: string
  path: string
  entries: FileEntry[]
  loading: boolean
  error: string | null
  /** Rows allowed by .ftpignore while a version preview is active. */
  candidateNames?: string[]
  /** Rows that would be transferred by the currently previewed version sync. */
  previewNames?: string[]
  disabled?: boolean
  showHidden: boolean
  selection: string[]
  onSelectionChange: (names: string[]) => void
  onNavigate: (path: string) => void
  onOpenDir: (entry: FileEntry) => void
  onOpenFile?: (entry: FileEntry) => void
  onUp: () => void
  onHome: () => void
  onRefresh: () => void
  onNewFolder: () => void
  onRename: (entry: FileEntry) => void
  onDelete: (entries: FileEntry[]) => void
  onTransfer: (entries: FileEntry[]) => void
  /** Rendered at the right end of the toolbar (drive picker, disconnect, …). */
  toolbarExtra?: ReactNode
  placeholder?: ReactNode
  /** What this pane will receive; omit to refuse every drop. */
  dropAccepts?: DropAccepts
  onDropTransfer?: (transfer: DroppedTransfer) => void
}

const UP = '..'

type ColumnKey = 'name' | 'size' | 'modifiedAt'
type StoredColumnKey = 'name' | 'size'
type ColumnWidths = Record<StoredColumnKey, number>

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  name: 230,
  size: 68
}

const COLUMN_LIMITS: Record<ColumnKey, { min: number; max: number }> = {
  name: { min: 110, max: 900 },
  size: { min: 58, max: 180 },
  // The last column absorbs the pane's remaining width, so it has no practical
  // upper bound; the empty area belongs after the date, not between name/size.
  modifiedAt: { min: 86, max: 10_000 }
}

/**
 * Ужимает столбцы под ширину панели.
 *
 * Последний столбец поглощает остаток, поэтому при сужении окна он сдаёт
 * позиции первым — это происходит само собой. Работа начинается дальше: когда
 * он упёрся в свой минимум, недостающее забирается у самого широкого из
 * остальных, и после каждого шага заново решается, кто теперь самый широкий.
 * Так столбцы сходятся друг к другу, а не один схлопывается до минимума, пока
 * второй остаётся широким.
 */
/** Отступы ячейки слева и справа плюс запас на округление. */
const SIZE_CELL_CHROME = 26

/**
 * Насколько каждая следующая ступень подробности требует больше места.
 *
 * Без этого запаса единицы перескакивали бы через одну: `44614.2 КБ` и
 * `45678901 Б` — обе по десять знаков, влезают в одну ширину, и выбор «самой
 * подробной записи» сразу уходил в байты. Своя полоса ширины у каждой ступени
 * делает лестницу ГБ → МБ → КБ → Б проходимой по шагам.
 */
const SIZE_DETAIL_STEP = 28

let measurer: CanvasRenderingContext2D | null = null

/** Ширина строки в пикселях для заданного шрифта. Канва не трогает вёрстку. */
function textWidth(text: string, font: string): number {
  if (!measurer) measurer = document.createElement('canvas').getContext('2d')
  if (!measurer) return text.length * 7
  measurer.font = font
  return measurer.measureText(text).width
}

function fitColumns(preferred: ColumnWidths, available: number, sizeMin: number): ColumnWidths {
  if (available <= 0) return preferred
  // Минимум размера задаётся содержимым и действует всегда, а не только при
  // нехватке места: иначе заданная пользователем узкая ширина обрезала бы
  // значения даже на широком окне.
  const widths = { ...preferred, size: Math.max(preferred.size, sizeMin) }
  const minOf = (key: StoredColumnKey): number =>
    key === 'size' ? sizeMin : COLUMN_LIMITS[key].min
  let shortfall = widths.name + widths.size + COLUMN_LIMITS.modifiedAt.min - available

  while (shortfall > 0) {
    const shrinkable = (['name', 'size'] as StoredColumnKey[]).filter(
      (key) => widths[key] > minOf(key)
    )
    if (shrinkable.length === 0) break
    const widest = shrinkable.reduce((a, b) => (widths[b] > widths[a] ? b : a))
    const other = widest === 'name' ? widths.size : widths.name
    // Опускаем только до уровня следующего по ширине — дальше цикл решит заново.
    // При равенстве шаг всё равно ненулевой, иначе цикл бы не завершился.
    const floor = Math.max(minOf(widest), Math.min(widths[widest] - 1, other))
    const step = Math.min(shortfall, widths[widest] - floor)
    widths[widest] -= step
    shortfall -= step
  }
  return widths
}

function loadColumnWidths(kind: 'local' | 'remote'): ColumnWidths {
  try {
    const parsed = JSON.parse(localStorage.getItem(`kreos:file-columns:${kind}`) ?? '{}') as
      | Partial<ColumnWidths>
      | null
    if (!parsed) return { ...DEFAULT_COLUMN_WIDTHS }
    return Object.fromEntries(
      (Object.keys(DEFAULT_COLUMN_WIDTHS) as StoredColumnKey[]).map((key) => {
        const value = parsed[key]
        const limits = COLUMN_LIMITS[key]
        return [
          key,
          typeof value === 'number' && Number.isFinite(value)
            ? Math.max(limits.min, Math.min(limits.max, value))
            : DEFAULT_COLUMN_WIDTHS[key]
        ]
      })
    ) as unknown as ColumnWidths
  } catch {
    return { ...DEFAULT_COLUMN_WIDTHS }
  }
}

function iconFor(entry: FileEntry): ReactElement {
  if (entry.type === 'dir') return <IconFolder />
  if (entry.type === 'link') return <IconLink />
  return <IconFile />
}

function compare(a: FileEntry, b: FileEntry, key: SortKey, dir: SortDir): number {
  // Directories always float to the top; sorting only reorders within a group.
  if (a.type === 'dir' && b.type !== 'dir') return -1
  if (a.type !== 'dir' && b.type === 'dir') return 1
  let result: number
  if (key === 'name') result = a.name.localeCompare(b.name, 'ru', { numeric: true })
  else if (key === 'size') result = a.size - b.size
  else result = (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0)
  if (result === 0) result = a.name.localeCompare(b.name, 'ru', { numeric: true })
  return dir === 'asc' ? result : -result
}

export function FilePane(props: FilePaneProps): ReactElement {
  const {
    kind,
    title,
    path,
    entries,
    loading,
    error,
    candidateNames = [],
    previewNames = [],
    disabled,
    showHidden,
    selection,
    onSelectionChange,
    onNavigate,
    onOpenDir,
    onOpenFile,
    onUp,
    onHome,
    onRefresh,
    onNewFolder,
    onRename,
    onDelete,
    onTransfer,
    toolbarExtra,
    placeholder,
    dropAccepts,
    onDropTransfer
  } = props

  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filter, setFilter] = useState('')
  const [draftPath, setDraftPath] = useState(path)
  const [cursor, setCursor] = useState<string | null>(null)
  const anchorRef = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  useScrollEdges(toolbarRef)
  /** Folder row currently under a drag, or '' for "the pane itself". */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(() => loadColumnWidths(kind))
  /** Ширина области списка; от неё зависит, сколько столбцы могут занять. */
  const [availableWidth, setAvailableWidth] = useState(0)
  /** Фактический шрифт ячейки размера: от него зависит ширина значения. */
  const [numFont, setNumFont] = useState('11.5px ui-monospace, monospace')
  const columnResizeRef = useRef<{
    pointerId: number
    left: ColumnKey
    right: ColumnKey
    startX: number
    leftWidth: number
    rightWidth: number
  } | null>(null)

  // The path box is editable, so it only follows the pane when not being typed in.
  useEffect(() => setDraftPath(path), [path])
  useEffect(() => {
    setCursor(null)
    anchorRef.current = null
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [path])
  useEffect(() => {
    try {
      localStorage.setItem(`kreos:file-columns:${kind}`, JSON.stringify(columnWidths))
    } catch {
      /* Resizing remains functional when persistent browser storage is unavailable. */
    }
  }, [columnWidths, kind])

  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    const update = (): void => setAvailableWidth(element.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return entries
      .filter((e) => (showHidden ? true : !e.name.startsWith('.')))
      .filter((e) => (needle ? e.name.toLowerCase().includes(needle) : true))
      .slice()
      .sort((a, b) => compare(a, b, sortKey, sortDir))
  }, [entries, filter, showHidden, sortKey, sortDir])

  useEffect(() => {
    const cell = bodyRef.current?.querySelector('.filetable td.num')
    if (!cell) return
    const style = getComputedStyle(cell)
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    setNumFont((previous) => (previous === font ? previous : font))
  })

  // Ширина самого длинного значения в самой компактной записи. Уже её столбец
  // не станет — иначе размеры обрезались бы троеточием, а это единственное,
  // чего в этом столбце быть не должно.
  const sizeMinWidth = useMemo(() => {
    const files = visible.filter((entry) => entry.type !== 'dir')
    if (files.length === 0) return COLUMN_LIMITS.size.min
    const widest = Math.max(
      ...files.map((entry) => textWidth(formatSizeAt(entry.size, 0), numFont))
    )
    return Math.max(COLUMN_LIMITS.size.min, Math.ceil(widest) + SIZE_CELL_CHROME)
  }, [visible, numFont])

  // Хранимые ширины — пожелание пользователя; на экран идёт то, что помещается.
  // Сузили окно и вернули обратно — прежние ширины на месте.
  const displayWidths = useMemo(
    () => fitColumns(columnWidths, availableWidth, sizeMinWidth),
    [columnWidths, availableWidth, sizeMinWidth]
  )

  // Освободившееся место столбец тратит на точность: спускается на единицу
  // ниже и добавляет знак после запятой, пока запись помещается целиком.
  const sizeDetail = useMemo(() => {
    const files = visible.filter((entry) => entry.type !== 'dir')
    if (files.length === 0) return 0

    const needed = (level: number): number =>
      Math.ceil(
        Math.max(...files.map((entry) => textWidth(formatSizeAt(entry.size, level), numFont)))
      ) + SIZE_CELL_CHROME

    // Глубже самого крупного файла спускаться некуда: он первым достигает
    // байтов, и дальнейшие ступени ничего не меняют.
    const largest = Math.max(...files.map((entry) => entry.size))
    const deepest = Math.min(
      MAX_SIZE_DETAIL,
      largest > 0 ? Math.floor(Math.log(largest) / Math.log(1024)) : 0
    )

    let level = 0
    let threshold = needed(0)
    for (let next = 1; next <= deepest; next++) {
      threshold = Math.max(needed(next), threshold + SIZE_DETAIL_STEP)
      if (displayWidths.size < threshold) break
      level = next
    }
    return level
  }, [visible, numFont, displayWidths.size])

  const selectedSet = useMemo(() => new Set(selection), [selection])
  const candidateSet = useMemo(() => new Set(candidateNames), [candidateNames])
  const previewSet = useMemo(() => new Set(previewNames), [previewNames])
  const selectedEntries = useMemo(
    () => visible.filter((e) => selectedSet.has(e.name)),
    [visible, selectedSet]
  )

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const click = useCallback(
    (entry: FileEntry, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void => {
      const names = visible.map((e) => e.name)
      if (event.shiftKey && anchorRef.current) {
        const from = names.indexOf(anchorRef.current)
        const to = names.indexOf(entry.name)
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from]
          onSelectionChange(names.slice(lo, hi + 1))
          setCursor(entry.name)
          return
        }
      }
      if (event.ctrlKey || event.metaKey) {
        const next = new Set(selection)
        if (next.has(entry.name)) next.delete(entry.name)
        else next.add(entry.name)
        onSelectionChange([...next])
      } else {
        onSelectionChange([entry.name])
      }
      anchorRef.current = entry.name
      setCursor(entry.name)
    },
    [visible, selection, onSelectionChange]
  )

  const activate = useCallback(
    (entry: FileEntry): void => {
      if (entry.type === 'dir') onOpenDir(entry)
      else if (onOpenFile) onOpenFile(entry)
      else onTransfer([entry])
    },
    [onOpenDir, onOpenFile, onTransfer]
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const names = visible.map((e) => e.name)
    const index = cursor ? names.indexOf(cursor) : -1

    const move = (delta: number): void => {
      if (names.length === 0) return
      const next = Math.min(Math.max(index + delta, 0), names.length - 1)
      const name = names[index === -1 ? 0 : next]
      setCursor(name)
      anchorRef.current = name
      onSelectionChange([name])
      const row = bodyRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(name)}"]`)
      row?.scrollIntoView({ block: 'nearest' })
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        move(-names.length)
        break
      case 'End':
        event.preventDefault()
        move(names.length)
        break
      case 'Enter': {
        event.preventDefault()
        const entry = visible.find((e) => e.name === cursor)
        if (entry) activate(entry)
        break
      }
      case 'Backspace':
        event.preventDefault()
        onUp()
        break
      case 'Delete':
        event.preventDefault()
        if (selectedEntries.length > 0) onDelete(selectedEntries)
        break
      case 'F2': {
        event.preventDefault()
        const entry = visible.find((e) => e.name === cursor)
        if (entry) onRename(entry)
        break
      }
      case 'a':
      // Раскладка: в русской 'a' приходит как 'ф'.
      case 'ф':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          onSelectionChange(names)
        }
        break
      default:
        break
    }
  }

  /** Whether an in-flight drag is something this pane accepts. */
  const willAccept = (types: readonly string[]): boolean => {
    if (!dropAccepts || !onDropTransfer || disabled) return false
    const kinds = dragKinds(types, dropAccepts.fromPane)
    if (kinds.internal) return true
    return kinds.osFiles && Boolean(dropAccepts.osFiles)
  }

  const startDrag = (entry: FileEntry, event: DragEvent<HTMLTableRowElement>): void => {
    // Dragging an unselected row drags just that row; dragging a selected one
    // takes the whole selection, which is what every file manager does.
    const names = selectedSet.has(entry.name) ? selection : [entry.name]
    if (!selectedSet.has(entry.name)) onSelectionChange([entry.name])
    const dragged = visible.filter((e) => names.includes(e.name))
    const payload: DragPayload = {
      source: kind,
      fromPath: path,
      names,
      hasDirectories: dragged.some((e) => e.type === 'dir')
    }
    event.dataTransfer.setData(dndMime(kind), JSON.stringify(payload))
    event.dataTransfer.effectAllowed = 'copy'
  }

  const overRow = (entry: FileEntry, event: DragEvent<HTMLTableRowElement>): void => {
    if (entry.type !== 'dir' || !willAccept(event.dataTransfer.types)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setDropTarget(entry.name)
  }

  const overPane = (event: DragEvent<HTMLDivElement>): void => {
    if (!willAccept(event.dataTransfer.types)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropTarget('')
  }

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    const target = dropTarget
    setDropTarget(null)
    if (!willAccept(event.dataTransfer.types) || !onDropTransfer) return
    event.preventDefault()
    event.stopPropagation()

    // dataTransfer is only readable synchronously inside the drop handler.
    const raw = dropAccepts?.fromPane ? event.dataTransfer.getData(dndMime(dropAccepts.fromPane)) : ''
    let payload: DragPayload | null = null
    if (raw) {
      try {
        payload = JSON.parse(raw) as DragPayload
      } catch {
        payload = null
      }
    }
    const osPaths = payload
      ? []
      : [...event.dataTransfer.files]
          .map((file) => window.kreos.pathForFile(file))
          .filter((p): p is string => Boolean(p))

    if (!payload && osPaths.length === 0) return
    onDropTransfer({ payload, osPaths, intoFolder: target || null })
  }

  const sortMark = (key: SortKey): string => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '')

  const totalSize = selectedEntries.reduce((sum, e) => sum + (e.type === 'file' ? e.size : 0), 0)

  const startColumnResize = (
    event: ReactPointerEvent<HTMLSpanElement>,
    left: ColumnKey,
    right: ColumnKey
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    const leftHeader = event.currentTarget.closest('th')
    const rightHeader = leftHeader?.nextElementSibling as HTMLElement | null
    if (!leftHeader || !rightHeader) return
    columnResizeRef.current = {
      pointerId: event.pointerId,
      left,
      right,
      startX: event.clientX,
      leftWidth: leftHeader.getBoundingClientRect().width,
      rightWidth: rightHeader.getBoundingClientRect().width
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing-file-column')
  }

  const moveColumnResize = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const resize = columnResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    // Ручной минимум тот же, что и у автоподгонки: столбец размера не должен
    // становиться уже своего содержимого ни при сужении окна, ни перетаскиванием.
    const limitsFor = (key: ColumnKey): { min: number; max: number } =>
      key === 'size'
        ? { min: Math.max(COLUMN_LIMITS.size.min, sizeMinWidth), max: COLUMN_LIMITS.size.max }
        : COLUMN_LIMITS[key]
    const leftLimits = limitsFor(resize.left)
    const rightLimits = limitsFor(resize.right)
    const wanted = event.clientX - resize.startX
    const minimum = Math.max(leftLimits.min - resize.leftWidth, resize.rightWidth - rightLimits.max)
    const maximum = Math.min(leftLimits.max - resize.leftWidth, resize.rightWidth - rightLimits.min)
    const delta = Math.max(minimum, Math.min(maximum, wanted))
    setColumnWidths((widths) => {
      if (resize.left === 'name' && resize.right === 'size') {
        return {
          ...widths,
          name: Math.round(resize.leftWidth + delta),
          size: Math.round(resize.rightWidth - delta)
        }
      }
      if (resize.left === 'size') {
        return { ...widths, size: Math.round(resize.leftWidth + delta) }
      }
      return widths
    })
  }

  const stopColumnResize = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    columnResizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('is-resizing-file-column')
  }

  const resizeHandle = (left: ColumnKey, right: ColumnKey): ReactElement => (
    <span
      className="filetable__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Изменить ширину столбца')}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation()
        setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS })
      }}
      onPointerDown={(event) => startColumnResize(event, left, right)}
      onPointerMove={moveColumnResize}
      onPointerUp={stopColumnResize}
      onPointerCancel={stopColumnResize}
    />
  )

  return (
    <section className="pane" data-pane-kind={kind} aria-label={title}>
      <header className="pane__head">
        <span className="pane__tag">{title}</span>
        <input
          className="input input--mono pane__path"
          value={draftPath}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => setDraftPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onNavigate(draftPath)
            if (e.key === 'Escape') setDraftPath(path)
            e.stopPropagation()
          }}
          aria-label={t('Путь ({0})', title)}
        />
      </header>

      <div className="pane__toolbar" ref={toolbarRef}>
        <button className="btn btn--ghost btn--icon" onClick={onUp} disabled={disabled} title={t('Вверх (Backspace)')}>
          <IconUp />
        </button>
        <button className="btn btn--ghost btn--icon" onClick={onHome} disabled={disabled} title={t('Домой')}>
          <IconHome />
        </button>
        <button className="btn btn--ghost btn--icon" onClick={onRefresh} disabled={disabled} title={t('Обновить (F5)')}>
          <IconRefresh />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={onNewFolder}
          disabled={disabled}
          title={t('Новая папка')}
        >
          <IconNewFolder />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => {
            const entry = selectedEntries[0]
            if (entry) onRename(entry)
          }}
          disabled={disabled || selectedEntries.length !== 1}
          title={t('Переименовать (F2)')}
        >
          <IconRename />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => onDelete(selectedEntries)}
          disabled={disabled || selectedEntries.length === 0}
          title={t('Удалить (Delete)')}
        >
          <IconTrash />
        </button>
        <input
          className="input"
          style={{ width: 130, marginLeft: 6, padding: '3px 8px' }}
          placeholder={t('Фильтр…')}
          value={filter}
          disabled={disabled}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t('Фильтр списка ({0})', title)}
        />
        <span className="pane__spacer" />
        {toolbarExtra}
      </div>

      <div
        className={'pane__body' + (dropTarget === '' ? ' pane__body--drop' : '')}
        ref={bodyRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement
          if (target.closest('tr.row') || target.closest('thead')) return
          onSelectionChange([])
          setCursor(null)
          anchorRef.current = null
        }}
        onDragOver={overPane}
        onDragLeave={(e) => {
          // Уходы на дочерние элементы не считаются — иначе подсветка мигает.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={handleDrop}
      >
        {placeholder ? (
          <div className="empty-note" style={{ paddingTop: 48 }}>
            {placeholder}
          </div>
        ) : (
          <>
            {error && <div className="pane-error">{error}</div>}
            <table className="filetable">
              <colgroup>
                <col style={{ width: displayWidths.name }} />
                <col style={{ width: displayWidths.size }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th onClick={() => toggleSort('name')}>
                    
                    {t('Имя')}{sortMark('name')}
                    {resizeHandle('name', 'size')}
                  </th>
                  <th className="num" onClick={() => toggleSort('size')}>
                    
                    {t('Размер')}{sortMark('size')}
                    {resizeHandle('size', 'modifiedAt')}
                  </th>
                  <th onClick={() => toggleSort('modifiedAt')}>
                    
                    {t('Изменён')}{sortMark('modifiedAt')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {path !== '' && (
                  <tr className="row row--dir" onDoubleClick={onUp}>
                    <td>
                      <span className="row__name">
                        <span className="row__icon">
                          <IconUp />
                        </span>
                        <span className="row__text">{UP}</span>
                      </span>
                    </td>
                    <td className="num">—</td>
                    <td />
                  </tr>
                )}
                {visible.map((entry) => {
                  const isSelected = selectedSet.has(entry.name)
                  return (
                    <tr
                      key={entry.name}
                      data-row={entry.name}
                      className={
                        'row' +
                        (entry.type === 'dir' ? ' row--dir' : '') +
                        (candidateSet.has(entry.name) ? ' row--sync-candidate' : '') +
                        (previewSet.has(entry.name) ? ' row--sync-preview' : '') +
                        (isSelected ? ' row--selected' : '') +
                        (cursor === entry.name ? ' row--cursor' : '') +
                        (dropTarget === entry.name ? ' row--droptarget' : '')
                      }
                      draggable={!disabled}
                      onDragStart={(e) => startDrag(entry, e)}
                      onDragEnd={() => setDropTarget(null)}
                      onDragOver={(e) => overRow(entry, e)}
                      onDrop={handleDrop}
                      onMouseDown={(e) => click(entry, e)}
                      onDoubleClick={() => activate(entry)}
                      title={entry.linkTarget ? `${entry.name} → ${entry.linkTarget}` : entry.name}
                    >
                      <td>
                        <span className="row__name">
                          <span className="row__icon">{iconFor(entry)}</span>
                          <span className="row__text">{entry.name}</span>
                        </span>
                      </td>
                      <td className="num">
                        {entry.type === 'dir' ? '—' : formatSizeAt(entry.size, sizeDetail)}
                      </td>
                      <td>{formatDate(entry.modifiedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!loading && visible.length === 0 && !error && (
              <div className="empty-note">
                {filter ? t('Ничего не найдено по фильтру') : t('Каталог пуст')}
              </div>
            )}
          </>
        )}
        {loading && (
          <div className="pane__overlay">
            <div className="spinner" />
            <span>{t('Загрузка…')}</span>
          </div>
        )}
      </div>

      <footer className="pane__foot">
        <span>
          {placeholder
            ? ''
            : `${visible.length} ${plural(visible.length, 'объект|объекта|объектов')}` +
              (entries.length !== visible.length
                ? t(' · скрыто {0}', entries.length - visible.length)
                : '')}
        </span>
        <span>
          {selectedEntries.length > 0
            ? t('Выбрано {0}{1}', selectedEntries.length, totalSize > 0 ? ` · ${formatSize(totalSize)}` : '')
            : ''}
        </span>
      </footer>
    </section>
  )
}

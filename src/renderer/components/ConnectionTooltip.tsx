import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'

interface ConnectionTooltipProps {
  anchor: HTMLElement
  left: number
  top: number
  title: string
  endpoint: string
  protocol: string
  /** Extra line for a tab that is no longer live — omitted for live sessions. */
  note?: string
  onClose: () => void
}

function contains(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/** Keeps the card reachable across the small gap between it and its anchor. */
function insideGap(anchor: DOMRect, tooltip: DOMRect, x: number, y: number): boolean {
  if (anchor.right <= tooltip.left) {
    return (
      x >= anchor.right &&
      x <= tooltip.left &&
      y >= Math.max(anchor.top, tooltip.top) &&
      y <= Math.min(anchor.bottom, tooltip.bottom)
    )
  }
  if (tooltip.right <= anchor.left) {
    return (
      x >= tooltip.right &&
      x <= anchor.left &&
      y >= Math.max(anchor.top, tooltip.top) &&
      y <= Math.min(anchor.bottom, tooltip.bottom)
    )
  }
  if (anchor.bottom <= tooltip.top) {
    return (
      y >= anchor.bottom &&
      y <= tooltip.top &&
      x >= Math.max(anchor.left, tooltip.left) &&
      x <= Math.min(anchor.right, tooltip.right)
    )
  }
  if (tooltip.bottom <= anchor.top) {
    return (
      y >= tooltip.bottom &&
      y <= anchor.top &&
      x >= Math.max(anchor.left, tooltip.left) &&
      x <= Math.min(anchor.right, tooltip.right)
    )
  }
  return false
}

export function ConnectionTooltip(props: ConnectionTooltipProps): ReactElement {
  const { anchor, left, top, title, endpoint, protocol, note, onClose } = props
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const closeIfOutside = (event: PointerEvent): void => {
      const tooltip = tooltipRef.current
      if (!anchor.isConnected || !tooltip) {
        onClose()
        return
      }

      const anchorRect = anchor.getBoundingClientRect()
      const tooltipRect = tooltip.getBoundingClientRect()
      if (
        !contains(anchorRect, event.clientX, event.clientY) &&
        !contains(tooltipRect, event.clientX, event.clientY) &&
        !insideGap(anchorRect, tooltipRect, event.clientX, event.clientY)
      ) {
        onClose()
      }
    }
    const close = (): void => onClose()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }

    window.addEventListener('pointermove', closeIfOutside, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointermove', closeIfOutside, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [anchor, onClose])

  return (
    <div
      ref={tooltipRef}
      className="connection-tooltip"
      role="tooltip"
      style={{ left, top }}
    >
      <strong>{title}</strong>
      <span>{endpoint}</span>
      <small>{protocol}</small>
      {note && <em className="connection-tooltip__note">{note}</em>}
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

interface TooltipState {
  anchor: HTMLElement
  text: string
  left: number
  top: number
  above: boolean
  originOffsetX: number
}

function stateFor(anchor: HTMLElement): TooltipState | null {
  const nativeTitle = anchor.getAttribute('title')?.trim()
  if (nativeTitle) {
    anchor.removeAttribute('title')
    anchor.dataset.tooltip = nativeTitle
  }
  const text =
    anchor.dataset.tooltip?.trim() ||
    anchor.getAttribute('aria-label')?.trim() ||
    anchor.textContent?.replace(/\s+/g, ' ').trim() ||
    ''
  if (!text) return null
  const rect = anchor.getBoundingClientRect()
  const above = rect.bottom + 62 > window.innerHeight && rect.top > 62
  const buttonCenter = rect.left + rect.width / 2
  const left = Math.max(160, Math.min(window.innerWidth - 160, buttonCenter))
  return {
    anchor,
    text,
    left,
    top: above ? rect.top - 7 : rect.bottom + 7,
    above,
    originOffsetX: buttonCenter - left
  }
}

/** One instant, fixed tooltip layer for every button in the application. */
export function ButtonTooltip(): ReactElement | null {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  useEffect(() => {
    const show = (target: EventTarget | null): void => {
      const anchor = target instanceof Element ? target.closest('button, [data-tooltip]') : null
      if (anchor instanceof HTMLElement) setTooltip(stateFor(anchor))
    }
    const over = (event: PointerEvent): void => show(event.target)
    const out = (event: PointerEvent): void => {
      setTooltip((current) => {
        if (!current) return null
        const next = event.relatedTarget
        return next instanceof Node && current.anchor.contains(next) ? current : null
      })
    }
    const focus = (event: FocusEvent): void => show(event.target)
    const close = (): void => setTooltip(null)

    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', out, true)
    document.addEventListener('focusin', focus, true)
    document.addEventListener('focusout', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', out, true)
      document.removeEventListener('focusin', focus, true)
      document.removeEventListener('focusout', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [])

  // Some buttons replace their description with live operation status while
  // the pointer remains over them. Keep the already-open tooltip in sync.
  useEffect(() => {
    const anchor = tooltip?.anchor
    if (!anchor) return
    const observer = new MutationObserver(() => {
      setTooltip((current) => (current?.anchor === anchor ? stateFor(anchor) : current))
    })
    observer.observe(anchor, {
      attributes: true,
      attributeFilter: ['data-tooltip', 'aria-label']
    })
    return () => observer.disconnect()
  }, [tooltip?.anchor])

  if (!tooltip || !tooltip.anchor.isConnected) return null
  return (
    <div
      key={`${tooltip.left}:${tooltip.top}:${tooltip.text}`}
      className={'button-tooltip' + (tooltip.above ? ' button-tooltip--above' : '')}
      role="tooltip"
      style={{
        left: tooltip.left,
        top: tooltip.top,
        transformOrigin: `calc(50% + ${tooltip.originOffsetX}px) ${tooltip.above ? 'bottom' : 'top'}`
      }}
    >
      {tooltip.text}
    </div>
  )
}

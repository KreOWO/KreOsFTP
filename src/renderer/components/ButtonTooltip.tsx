import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

interface TooltipState {
  button: HTMLButtonElement
  text: string
  left: number
  top: number
  above: boolean
  originOffsetX: number
}

function stateFor(button: HTMLButtonElement): TooltipState | null {
  const nativeTitle = button.getAttribute('title')?.trim()
  if (nativeTitle) {
    button.removeAttribute('title')
    button.dataset.tooltip = nativeTitle
  }
  const text =
    button.dataset.tooltip?.trim() ||
    button.getAttribute('aria-label')?.trim() ||
    button.textContent?.replace(/\s+/g, ' ').trim() ||
    ''
  if (!text) return null
  const rect = button.getBoundingClientRect()
  const above = rect.bottom + 62 > window.innerHeight && rect.top > 62
  const buttonCenter = rect.left + rect.width / 2
  const left = Math.max(160, Math.min(window.innerWidth - 160, buttonCenter))
  return {
    button,
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
      const button = target instanceof Element ? target.closest('button') : null
      if (button instanceof HTMLButtonElement) setTooltip(stateFor(button))
    }
    const over = (event: PointerEvent): void => show(event.target)
    const out = (event: PointerEvent): void => {
      setTooltip((current) => {
        if (!current) return null
        const next = event.relatedTarget
        return next instanceof Node && current.button.contains(next) ? current : null
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
    const button = tooltip?.button
    if (!button) return
    const observer = new MutationObserver(() => {
      setTooltip((current) => (current?.button === button ? stateFor(button) : current))
    })
    observer.observe(button, {
      attributes: true,
      attributeFilter: ['data-tooltip', 'aria-label']
    })
    return () => observer.disconnect()
  }, [tooltip?.button])

  if (!tooltip || !tooltip.button.isConnected) return null
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

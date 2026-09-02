import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Marks which sides of a horizontally scrollable strip have content beyond the
 * edge, by writing `data-overflow="start" | "end" | "both" | "none"` onto it.
 *
 * These strips hide their scrollbars to stay compact, which also removes the
 * only hint that they scroll at all. The attribute lets CSS fade the
 * overflowing edge so the affordance comes back without spending vertical
 * space on a scrollbar.
 *
 * Watches three things, because any of them changes the answer: scrolling, the
 * strip being resized, and children being added or removed.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current
    if (!element) return

    const update = (): void => {
      // Sub-pixel layout leaves fractional remainders, so compare with slack
      // rather than against zero — otherwise the end fade never switches off.
      const max = element.scrollWidth - element.clientWidth
      const atStart = element.scrollLeft <= 1
      const atEnd = element.scrollLeft >= max - 1
      const overflow = max <= 1 ? 'none' : atStart ? 'end' : atEnd ? 'start' : 'both'
      if (element.dataset.overflow !== overflow) element.dataset.overflow = overflow
    }

    update()
    element.addEventListener('scroll', update, { passive: true })

    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(element)

    const mutationObserver = new MutationObserver(update)
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true })

    return () => {
      element.removeEventListener('scroll', update)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [ref])
}

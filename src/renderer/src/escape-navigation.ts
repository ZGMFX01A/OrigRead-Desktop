/** A page consumes Escape when it clears a local search instead of navigating. */
export type PageEscapeHandler = () => boolean

export function isImeComposing(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229
}

export function shouldHandleEscape(event: KeyboardEvent): boolean {
  return event.key === 'Escape' && !event.defaultPrevented && !event.repeat
    && !isImeComposing(event) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
}

export function consumeEscape(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

function visible(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden'
}

// Compare the ancestors that establish the app's overlay stacks, rather than
// letting a child menu's own z-index escape its pane/backdrop.
interface EscapeStackingContext {
  element: HTMLElement
  zIndex: number
}

function stackingOrder(element: HTMLElement): EscapeStackingContext[] {
  const order: EscapeStackingContext[] = []
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    const zIndex = Number.parseInt(style.zIndex, 10)
    if (Number.isFinite(zIndex)) order.unshift({ element: current, zIndex })
    else if (style.position === 'fixed' || style.position === 'sticky'
      || style.transform !== 'none' || Number(style.opacity) < 1
      || style.containerType !== 'normal' || style.isolation === 'isolate'
      || /(?:layout|paint|strict|content)/.test(style.contain)) order.unshift({ element: current, zIndex: 0 })
  }
  return order
}

function compareStackingOrder(left: EscapeStackingContext[], right: EscapeStackingContext[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftContext = left[index]
    const rightContext = right[index]
    if (!leftContext || !rightContext) return (leftContext?.zIndex ?? 0) - (rightContext?.zIndex ?? 0)
    if (leftContext.element === rightContext.element) continue
    const difference = leftContext.zIndex - rightContext.zIndex
    if (difference) return difference
    // Equal-z sibling stacks are painted as a whole in DOM order. Their
    // descendants' z-index values cannot cross that first differing ancestor.
    const position = leftContext.element.compareDocumentPosition(rightContext.element)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  }
  return 0
}

/** Only transient layers participate; persistent settings listboxes are not popups. */
export function topmostEscapeLayer(root: ParentNode = document): HTMLElement | null {
  const layers = Array.from(root.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [role="menu"], '
    + '.source-switcher-popover, .source-manager-overlay, .reader-secondary-actions.open, .ai-rule-model-menu'
  )).filter(visible)
  // Sorting is stable, so siblings with equal stacking paths keep DOM paint order.
  return layers.map(element => ({ element, order: stackingOrder(element) }))
    .sort((left, right) => compareStackingOrder(left.order, right.order)).at(-1)?.element ?? null
}

export function focusVisibleElement(selector: string, root: ParentNode = document): boolean {
  const element = Array.from(root.querySelectorAll<HTMLElement>(selector))
    .find(candidate => visible(candidate) && !candidate.matches(':disabled'))
  if (!element) return false
  element.focus({ preventScroll: true })
  return true
}

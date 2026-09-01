export interface ReaderAiChatScrollOwnership {
  following: boolean
  pausedByUser: boolean
  lastScrollTop: number | null
  lastMaxScrollTop: number | null
}

const SCROLL_DIRECTION_TOLERANCE = 0.5
const LAYOUT_CHANGE_TOLERANCE = 0.5
const AT_BOTTOM_TOLERANCE = 4

export function initialReaderAiChatScrollOwnership(): ReaderAiChatScrollOwnership {
  return {
    following: true,
    pausedByUser: false,
    lastScrollTop: null,
    lastMaxScrollTop: null
  }
}

export function pauseReaderAiChatScroll(
  current: ReaderAiChatScrollOwnership,
  pausedByUser = true
): ReaderAiChatScrollOwnership {
  return { ...current, following: false, pausedByUser }
}

export function resumeReaderAiChatScroll(current: ReaderAiChatScrollOwnership): ReaderAiChatScrollOwnership {
  return { ...current, following: true, pausedByUser: false }
}

/**
 * Owns the distinction between a real upward user scroll and scrollTop changes caused by reflow/resizing.
 * A paused chat only resumes when the user actually scrolls downward to the end or explicitly chooses
 * "back to bottom". This prevents panel resize from silently re-enabling streaming auto-follow.
 */
export function updateReaderAiChatScrollOwnership(
  current: ReaderAiChatScrollOwnership,
  scrollTop: number,
  maxScrollTop: number,
  userInitiated = false
): ReaderAiChatScrollOwnership {
  const movedUp = current.lastScrollTop !== null && scrollTop < current.lastScrollTop - SCROLL_DIRECTION_TOLERANCE
  const movedDown = current.lastScrollTop !== null && scrollTop > current.lastScrollTop + SCROLL_DIRECTION_TOLERANCE
  const movedUpBecauseLayoutShrank = current.lastMaxScrollTop !== null
    && maxScrollTop < current.lastMaxScrollTop - LAYOUT_CHANGE_TOLERANCE
  const distanceToBottom = Math.max(0, maxScrollTop - scrollTop)

  let next: ReaderAiChatScrollOwnership = {
    ...current,
    lastScrollTop: scrollTop,
    lastMaxScrollTop: maxScrollTop
  }

  // With streaming content the absolute scrollTop can still increase while the user scrolls upward,
  // because maxScrollTop may have grown even more since the previous sample. When a trusted input
  // gesture precedes this scroll, distance-to-bottom is the authoritative ownership signal.
  if (userInitiated && distanceToBottom > AT_BOTTOM_TOLERANCE) {
    next = { ...next, following: false, pausedByUser: true }
  } else if (movedUp && !movedUpBecauseLayoutShrank) {
    next = { ...next, following: false, pausedByUser: true }
  } else if (
    userInitiated
    && current.pausedByUser
    && distanceToBottom <= AT_BOTTOM_TOLERANCE
  ) {
    next = { ...next, following: true, pausedByUser: false }
  }

  return next
}

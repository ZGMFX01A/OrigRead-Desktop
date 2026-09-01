import { describe, expect, it } from 'vitest'
import {
  initialReaderAiChatScrollOwnership,
  pauseReaderAiChatScroll,
  resumeReaderAiChatScroll,
  updateReaderAiChatScrollOwnership
} from './reader-ai-chat-scroll'

describe('Reader AI Chat scroll ownership', () => {
  it('pauses after a real upward scroll and resumes only when the user returns to the end', () => {
    let state = initialReaderAiChatScrollOwnership()
    state = updateReaderAiChatScrollOwnership(state, 400, 400)
    state = updateReaderAiChatScrollOwnership(state, 260, 400)
    expect(state).toMatchObject({ following: false, pausedByUser: true })

    state = updateReaderAiChatScrollOwnership(state, 320, 400)
    expect(state.following).toBe(false)

    state = updateReaderAiChatScrollOwnership(state, 398, 400, true)
    expect(state).toMatchObject({ following: true, pausedByUser: false })
  })

  it('does not mistake resize/reflow clamping for a user return to the bottom', () => {
    let state = initialReaderAiChatScrollOwnership()
    state = updateReaderAiChatScrollOwnership(state, 500, 500)
    state = updateReaderAiChatScrollOwnership(state, 240, 500)
    expect(state.following).toBe(false)

    // A wider panel can reduce scrollHeight and clamp scrollTop upward. This is layout movement, not user intent.
    state = updateReaderAiChatScrollOwnership(state, 180, 180)
    expect(state).toMatchObject({ following: false, pausedByUser: true })
  })

  it('uses distance-to-bottom for an explicit user gesture even when absolute scrollTop increased', () => {
    let state = initialReaderAiChatScrollOwnership()
    state = updateReaderAiChatScrollOwnership(state, 220, 220)

    // Streaming added enough content that the user's upward wheel still leaves a numerically larger
    // scrollTop than the previous sample. Direction alone would incorrectly keep following.
    state = updateReaderAiChatScrollOwnership(state, 310, 700, true)
    expect(state).toMatchObject({ following: false, pausedByUser: true })

    // Programmatic/reflow movement to the end must not silently reclaim ownership once the user paused.
    state = updateReaderAiChatScrollOwnership(state, 700, 700)
    expect(state).toMatchObject({ following: false, pausedByUser: true })

    // A real user gesture reaching the end can resume follow-output.
    state = updateReaderAiChatScrollOwnership(state, 700, 700, true)
    expect(state).toMatchObject({ following: true, pausedByUser: false })
  })

  it('supports deliberate navigation pause and explicit back-to-bottom resume', () => {
    const initial = initialReaderAiChatScrollOwnership()
    expect(pauseReaderAiChatScroll(initial)).toMatchObject({ following: false, pausedByUser: true })
    expect(resumeReaderAiChatScroll(pauseReaderAiChatScroll(initial))).toMatchObject({ following: true, pausedByUser: false })
  })
})

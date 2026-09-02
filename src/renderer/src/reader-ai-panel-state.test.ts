import { describe, expect, it } from 'vitest'
import {
  INITIAL_READER_AI_PANEL_STATE,
  closeReaderAiPanel,
  closeReaderAiPanelDetail,
  openReaderAiPanel,
  openReaderAiPanelDetail,
  readerAiPanelSurface,
  resetReaderAiPanel,
  type ReaderAiPanelState
} from './reader-ai-panel-state'

describe('Reader AI Panel state', () => {
  it('keeps panel visibility independent from summary/chat artifacts', () => {
    const opened = openReaderAiPanel(INITIAL_READER_AI_PANEL_STATE, 'summary')

    expect(opened).toEqual({
      open: true,
      view: 'summary',
      conversationId: null,
      detailView: null,
      detailTargetId: null
    })
  })

  it('closing the panel preserves the selected conversation but clears transient detail state', () => {
    const current: ReaderAiPanelState = {
      open: true,
      view: 'chat',
      conversationId: 'conversation-1',
      detailView: 'sources',
      detailTargetId: 'assistant-1'
    }

    const closed = closeReaderAiPanel(current)
    expect(closed).toEqual({
      open: false,
      view: 'chat',
      conversationId: 'conversation-1',
      detailView: null,
      detailTargetId: null
    })
    expect(openReaderAiPanel(closed)).toMatchObject({
      open: true,
      view: 'chat',
      conversationId: 'conversation-1'
    })
  })

  it('resetting for another article clears all article-scoped panel state', () => {
    expect(resetReaderAiPanel()).toEqual(INITIAL_READER_AI_PANEL_STATE)
    expect(resetReaderAiPanel()).not.toBe(INITIAL_READER_AI_PANEL_STATE)
  })

  it('treats detail as a temporary surface without replacing the underlying home/summary/chat view', () => {
    const chat = openReaderAiPanel({ ...INITIAL_READER_AI_PANEL_STATE, conversationId: 'conversation-1' }, 'chat')
    const detail = openReaderAiPanelDetail(chat, 'conversation-history')
    expect(readerAiPanelSurface(detail)).toBe('detail')
    expect(detail).toMatchObject({ view: 'chat', conversationId: 'conversation-1', detailView: 'conversation-history' })
    expect(closeReaderAiPanelDetail(detail)).toMatchObject({ view: 'chat', conversationId: 'conversation-1', detailView: null })

    expect(readerAiPanelSurface(openReaderAiPanel(INITIAL_READER_AI_PANEL_STATE, 'home'))).toBe('home')
  })
})

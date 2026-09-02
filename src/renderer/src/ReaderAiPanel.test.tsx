import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import { ReaderAiPanelShell } from './ReaderAiPanel'

describe('ReaderAiPanelShell component', () => {
  it('renders the shared Reader AI surface with explicit accessible controls', () => {
    const html = renderToStaticMarkup(
      <ReaderAiPanelShell
        view="chat"
        detailView={null}
        placement="right"
        panelSize={360}
        title="Reader AI"
        subtitle="Current article"
        onPlacementChange={() => undefined}
        onPanelSizePreview={() => undefined}
        onPanelSizeCommit={() => undefined}
        onClose={() => undefined}
      >
        <p>Conversation body</p>
      </ReaderAiPanelShell>
    )

    expect(html).toContain('data-reader-ai-view="chat"')
    expect(html).toContain('data-reader-ai-surface="chat"')
    expect(html).toContain('placement-right')
    expect(html).toContain('aria-label="summaryPlacement"')
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-label="summaryPanelResize"')
    expect(html).toContain('aria-valuemin="220"')
    expect(html).toContain('aria-valuemax="640"')
    expect(html).not.toContain('summaryPanelSize')
    expect(html).toContain('aria-label="close"')
    expect(html).toContain('Reader AI')
    expect(html).toContain('Conversation body')
  })

  it('keeps detail views on the same shared panel shell', () => {
    const html = renderToStaticMarkup(
      <ReaderAiPanelShell
        view="chat"
        detailView="sources"
        placement="left"
        panelSize={420}
        title="Sources"
        onPlacementChange={() => undefined}
        onPanelSizePreview={() => undefined}
        onPanelSizeCommit={() => undefined}
        onClose={() => undefined}
      >
        <div>Frozen evidence</div>
      </ReaderAiPanelShell>
    )

    expect(html).toContain('data-reader-ai-surface="detail"')
    expect(html).toContain('data-reader-ai-detail="sources"')
    expect(html).toContain('placement-left')
    expect(html).toContain('Frozen evidence')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../renderer/src/styles.css', import.meta.url), 'utf8')

describe('D8.6.5 motion foundation CSS contract', () => {
  it('defines the shared motion duration/easing tokens and reduced-motion contract', () => {
    expect(styles).toContain('--motion-duration-instant: 80ms')
    expect(styles).toContain('--motion-duration-fast: 120ms')
    expect(styles).toContain('--motion-duration-normal: 160ms')
    expect(styles).toContain('--motion-duration-emphasized: 200ms')
    expect(styles).toContain('--motion-ease-standard: cubic-bezier(0.2, 0, 0, 1)')
    expect(styles).toContain('--motion-ease-enter: cubic-bezier(0, 0, 0, 1)')
    expect(styles).toContain('--motion-ease-exit: cubic-bezier(0.3, 0, 1, 1)')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).toContain('--motion-distance-md: 0px')
  })

  it('keeps transitions explicit and routed through the shared motion tokens', () => {
    expect(styles).not.toMatch(/transition\s*:\s*all\b/i)

    const transitions = styles.match(/transition\s*:[^;]+;/gi) ?? []
    expect(transitions.length).toBeGreaterThan(0)
    for (const declaration of transitions) {
      expect(declaration, declaration).toContain('var(--motion-')
    }
  })

  it('defines restrained M2 surface and compact-button motion without global button scaling', () => {
    expect(styles).toContain('@keyframes motion-surface-enter-down')
    expect(styles).toContain('@keyframes motion-surface-enter-up')
    expect(styles).toContain('@keyframes motion-inline-tooltip-enter')
    expect(styles).toContain(".source-switcher-popover[data-placement='bottom']")
    expect(styles).toContain('.mini-action.icon-only:active:not(:disabled) { transform: scale(.97); }')
    expect(styles).toContain('.icon-button:active:not(:disabled)')
    expect(styles).toContain('.provider-default-radio span::after')
    expect(styles).toContain('.provider-default-radio input:checked + span::after { opacity: 1; transform: scale(1); }')
    expect(styles).toContain('.settings-nav-button {')
    expect(styles).toContain('animation: motion-surface-enter-down var(--motion-duration-normal) var(--motion-ease-enter) both;')
    expect(styles).not.toMatch(/(?:^|\n)\s*button:(?:hover|active)[^{]*\{[^}]*scale\(/i)
  })

  it('keeps M3 structural motion away from Reader AI scroll and manual resize tracks', () => {
    expect(styles).toContain('@keyframes motion-overlay-enter-left')
    expect(styles).toContain('@keyframes motion-content-enter')
    expect(styles).toContain('.settings-page-motion')
    expect(styles).toContain('.adaptive-source-overlay')
    expect(styles).not.toContain('motion-floating-action-enter')
    expect(styles).not.toMatch(/\.reader-ai-panel\.docked[^\{]*\{[^}]*animation\s*:/i)
    expect(styles).not.toMatch(/\.reader-ai-panel\.docked[^\{]*\{[^}]*transform\s*:/i)
    expect(styles).not.toMatch(/\.reader-composite[^\{]*\{[^}]*transition\s*:/i)
    expect(styles).not.toMatch(/\.app-shell[^\{]*\{[^}]*transition\s*:/i)
    expect(styles).not.toMatch(/\.pane-divider[^\{]*\{[^}]*transition\s*:[^}]*width/i)
    expect(styles).not.toMatch(/\.reader-ai-scroll-jumps\s*>\s*button[^\{]*\{[^}]*animation\s*:/i)
  })

  it('keeps M4 feedback first-appearance-only and status-driven', () => {
    expect(styles).toContain('@keyframes motion-feedback-enter')
    expect(styles).toContain('@keyframes reader-citation-highlight-feedback')
    expect(styles).toContain('.reader-ai-reasoning-stream {')
    expect(styles).toContain('.reader-ai-web-search-activity.status-success')
    expect(styles).toContain('.reader-ai-tool-card.status-complete')
    expect(styles).toContain('.reader-ai-tool-card.status-error')
    expect(styles).toContain('animation: reader-citation-highlight-feedback 1.05s var(--motion-ease-standard) both;')
    expect(styles).not.toMatch(/\.reader-ai-message\.assistant[^\{]*\{[^}]*animation\s*:/i)
    expect(styles).not.toMatch(/\.reader-ai-reasoning-stream\s+pre[^\{]*\{[^}]*animation\s*:/i)
  })

})

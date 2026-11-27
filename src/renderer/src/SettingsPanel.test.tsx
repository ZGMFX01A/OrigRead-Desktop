import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, expect, it, vi } from 'vitest'
import { BackupSettingsPage, TranslationSettingsPage, MarkdownContent, RuleHeaderActions, LocalMcpSettingsSection } from './SettingsPanel'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: {resolvedLanguage:'en'} }) }))
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount())
  vi.unstubAllGlobals()
})

async function mount(node: ReactNode, api: Record<string, unknown>) {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(window, {origread:api, requestAnimationFrame:(callback: () => void) => {callback(); return 0}})
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('HTMLElement', window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = window.document.getElementById('root')!
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(node) })
  return container
}

function props(element: Element) {
  const key = Object.keys(element).find(key => key.startsWith('__reactProps$'))!
  return (element as unknown as Record<string, Record<string, (...args: any[]) => any>>)[key]!
}

it('opens markdown external links through controlled IPC', async () => {
  const openExternalUrl = vi.fn(async () => {})
  const container = await mount(<MarkdownContent text="[Guide](https://example.com/help)"/>, {openExternalUrl})
  const preventDefault = vi.fn()
  await act(async () => { props(container.querySelector('a')!).onClick!({preventDefault}) })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/help')
})

it.each(['exportBackup','restoreBackup'])('unlocks %s after rejected IPC', async action => {
  const failure = vi.fn(async () => { throw new Error('disk unavailable') })
  const container = await mount(<BackupSettingsPage/>, {exportConfigurationBackup:failure,restoreConfigurationBackup:failure})
  const button = container.querySelector(`[data-setting-anchor="${action}"]`)!
  await act(async () => { await props(button).onClick!() })
  expect(container.textContent).toContain('disk unavailable')
  expect(button.hasAttribute('disabled')).toBe(false)
  await act(async () => { await props(button).onClick!() })
  expect(failure).toHaveBeenCalledTimes(2)
})

it('loads only credential metadata, and clears newly entered keys after saving', async () => {
  const settings = {targetLanguage:'en',displayMode:'BILINGUAL',defaultTarget:{type:'traditional',provider:'DEEPL'},providers:[{type:'DEEPL',enabled:true,endpoint:'https://example.com',hasApiKey:true}]}
  const getTranslationApiKey = vi.fn(async () => 'existing-secret')
  const updateTranslationProvider = vi.fn(async () => settings)
  const container = await mount(<TranslationSettingsPage/>, {getTranslationSettings:async () => settings,getTranslationApiKey,updateTranslationProvider})
  expect(getTranslationApiKey).not.toHaveBeenCalled()
  const input = container.querySelector('.secret-key-editor input') as HTMLInputElement
  expect(input.value).toBe('')
  expect(input.placeholder).toBe('••••••••')
  expect(container.querySelector('.secret-key-editor small')?.textContent).toBe('credentialConfigured')
  await act(() => { props(input).onChange!({target:{value:'replacement-secret'}}) })
  const save = [...container.querySelectorAll('.secret-key-editor button')].find(button => button.textContent === 'saveCredential')!
  await act(async () => { props(save).onClick!() })
  expect(updateTranslationProvider).toHaveBeenCalledExactlyOnceWith({type:'DEEPL',apiKey:'replacement-secret'})
  expect(input.value).toBe('')
  expect(getTranslationApiKey).not.toHaveBeenCalled()
})

it('preserves trailing newlines while editing local server arguments', async () => {
  const server = {id:'local',name:'Local',enabled:false,command:'node',args:['first'],cwd:'',hasEnvironment:false}
  const settings = {servers:[server]}
  const updateMcpLocalServer = vi.fn(async () => settings)
  const container = await mount(<LocalMcpSettingsSection/>, {
    getMcpLocalSettings:async () => settings,getMcpLocalConnectionStates:async () => [],getMcpToolCatalog:async () => ({servers:[]}),updateMcpLocalServer
  })
  const textarea = container.querySelector('.mcp-local-args-field textarea') as HTMLTextAreaElement
  await act(() => { props(textarea).onChange!({target:{value:'first\n\nsecond\n'}}) })
  expect(textarea.value).toBe('first\n\nsecond\n')
  await act(async () => { props(textarea).onBlur!() })
  expect(updateMcpLocalServer).toHaveBeenCalledWith(expect.objectContaining({id:'local',args:['first','second']}))
})

it('accepts immediate progress for the active request and marks failures with that same ID', async () => {
  let listener: (value: any) => void = () => { throw new Error('not subscribed') }
  let reject!: (error: Error) => void
  const generateAiRule = vi.fn((_kind, _url, options) => {
    listener({requestId:options.requestId,stage:'FETCHING',attempt:1,detail:'live-progress',at:1})
    return new Promise((_resolve, fail) => { reject = fail })
  })
  const container = await mount(<RuleHeaderActions kind="json" onDone={vi.fn()} onSaved={vi.fn()}/>, {
    onAiRuleProgress:(callback: typeof listener) => {listener=callback;return () => {}},
    getAiSettings:async () => ({providers:[{id:'p',name:'P',enabled:true,models:['m'],defaultModel:'m'}],defaultProviderId:'p'}),generateAiRule
  })
  const open = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('aiGenerateJsonRule'))!
  await act(async () => { props(open).onClick!() })
  const input = container.querySelector('.rule-dialog-field input')!
  await act(() => { props(input).onChange!({target:{value:'https://example.com/'}}) })
  await act(async () => { props(container.querySelector('.dialog-submit')!).onClick!() })
  expect(container.textContent).toContain('live-progress')
  await act(async () => { reject(new Error('generation failed')) })
  expect(container.textContent).toContain('generation failed')
  expect(container.querySelector('.dialog-submit')!.hasAttribute('disabled')).toBe(false)
  await act(() => { listener({requestId:generateAiRule.mock.calls[0]![2].requestId,stage:'FETCHING',attempt:1,detail:'late-progress',at:2}) })
  expect(container.textContent).not.toContain('late-progress')
})

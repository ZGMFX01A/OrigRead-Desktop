import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/contracts'
import { LIST_TRANSLATION_LIMIT, type ListTranslationRequest, type ListTranslationProgress } from '../../shared/translation'
import { validateTranslationTarget, type TranslationService } from './translation-service'

const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new TypeError('Invalid translation ID')
  return value
}
export function validateListTranslationInput(accountId: unknown, articleIds: unknown): { accountId: number; articleIds: string[] } {
  if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId < 1) throw new TypeError('Invalid account ID')
  if (!Array.isArray(articleIds) || articleIds.length > LIST_TRANSLATION_LIMIT) throw new TypeError('Too many translation articles')
  return { accountId, articleIds: [...new Set(articleIds.map(id))] }
}

/** Preload only exposes bounded operations. No renderer-supplied paths, HTML or credentials. */
export function registerTranslationIpc(ipc: IpcMain, service: () => TranslationService | null,
  trusted: (event: IpcMainInvokeEvent) => void): () => void {
  const active = new Map<number, { requestId: string; controller: AbortController; promise: Promise<ListTranslationProgress> }>()
  const ready = (): TranslationService => {
    const value = service(); if (!value) throw new Error('Translation service is not ready'); return value
  }
  ipc.handle(IPC_CHANNELS.restoreArticleTranslation, (event, articleId: unknown) => {
    trusted(event); return ready().restoreArticle(id(articleId))
  })
  ipc.handle(IPC_CHANNELS.restoreListTranslations, (event, accountId: unknown, ids: unknown) => {
    trusted(event); const request = validateListTranslationInput(accountId, ids)
    return ready().restoreList(request.accountId, request.articleIds)
  })
  ipc.handle(IPC_CHANNELS.translateList, (event, raw: unknown) => {
    trusted(event)
    if (!raw || typeof raw !== 'object') throw new TypeError('Invalid translation request')
    const value = raw as Record<string, unknown>
    const request: ListTranslationRequest = { ...validateListTranslationInput(value.accountId, value.articleIds),
      requestId: id(value.requestId), target: value.target === undefined ? undefined : validateTranslationTarget(value.target) }
    const sender = event.sender
    const previous = active.get(sender.id)
    if (previous?.requestId === request.requestId) return previous.promise
    previous?.controller.abort()
    const controller = new AbortController()
    const destroyed = (): void => controller.abort()
    sender.once('destroyed', destroyed)
    const promise = ready().translateList(request, controller.signal, progress => {
      if (!controller.signal.aborted && !sender.isDestroyed()) sender.send(IPC_CHANNELS.listTranslationProgress, progress)
    }).finally(() => {
      sender.removeListener('destroyed', destroyed)
      if (active.get(sender.id)?.controller === controller) active.delete(sender.id)
    })
    active.set(sender.id, { requestId: request.requestId, controller, promise })
    return promise
  })
  ipc.handle(IPC_CHANNELS.stopListTranslation, (event, requestId: unknown) => {
    trusted(event); const key = id(requestId); const request = active.get(event.sender.id)
    if (!request || request.requestId !== key) return false
    request.controller.abort(); active.delete(event.sender.id); return true
  })
  ipc.handle(IPC_CHANNELS.setTranslationVisible, (event, accountId: unknown, articleId: unknown, kind: unknown, key: unknown, show: unknown) => {
    trusted(event)
    const request = validateListTranslationInput(accountId, [articleId])
    if (kind !== 'LIST' && kind !== 'FULL') throw new TypeError('Invalid translation kind')
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || typeof show !== 'boolean') throw new TypeError('Invalid translation selection')
    return ready().setVisible(request.accountId, request.articleIds[0]!, kind, key, show)
  })
  return () => { active.forEach(request => request.controller.abort()); active.clear() }
}

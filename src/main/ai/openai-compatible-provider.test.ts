import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAiCompatibleProvider, chatEndpoint, modelsEndpoint } from './openai-compatible-provider'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())) })

describe('OpenAiCompatibleProvider Android parity', () => {
  it('normalizes chat and models endpoints', () => {
    expect(chatEndpoint('https://api.example.com')).toBe('https://api.example.com/v1/chat/completions')
    expect(chatEndpoint('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions')
    expect(modelsEndpoint('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/models')
  })

  it('parses model list, chat content and reasoning', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/models') return void response.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }))
      response.end(JSON.stringify({ choices: [{ message: { content: 'Final answer', reasoning_content: 'Explicit reasoning' } }] }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const endpoint = `http://127.0.0.1:${address.port}/v1`
    const provider = new OpenAiCompatibleProvider()
    expect(await provider.listModels(endpoint, '')).toEqual(['model-a', 'model-b'])
    expect(await provider.completeDetailed('system', 'user', { endpoint, model: 'model-a', apiKey: '' })).toEqual({ content: 'Final answer', reasoning: 'Explicit reasoning' })
  })

  it('extracts think blocks when provider does not expose reasoning separately', async () => {
    const server = createServer((_request, response) => { response.setHeader('content-type','application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '<think>hidden trace</think>Visible summary' } }] })) })
    servers.push(server); await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const result = await new OpenAiCompatibleProvider().completeDetailed('s','u',{ endpoint:`http://127.0.0.1:${address.port}`, model:'m',apiKey:'' })
    expect(result).toEqual({ content: 'Visible summary', reasoning: 'hidden trace' })
  })
})


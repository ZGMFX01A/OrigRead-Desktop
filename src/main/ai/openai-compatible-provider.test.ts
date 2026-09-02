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

  it('streams content and explicit reasoning from OpenAI-compatible SSE', async () => {
    let requestBody = ''
    const timings: Array<{ metric: string; elapsedMs: number }> = []
    const server = createServer((request, response) => {
      request.setEncoding('utf8')
      request.on('data', (chunk) => { requestBody += chunk })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"reasoning_content":"think "},"finish_reason":null}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n')
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const deltas: Array<{ content: string; reasoning: string; finishReason: string | null }> = []
    const result = await new OpenAiCompatibleProvider().streamDetailed(
      'system', 'user',
      {
        endpoint: `http://127.0.0.1:${address.port}`,
        model: 'm',
        apiKey: '',
        temperature: 0,
        maxOutputTokens: 321,
        outputTokenLimitStyle: 'MAX_COMPLETION_TOKENS',
        reasoningParameter: { key: 'reasoning_effort', value: 'high' },
        onTiming: (event) => timings.push(event)
      },
      (delta) => deltas.push(delta)
    )
    const parsedRequest = JSON.parse(requestBody) as Record<string, unknown>
    expect(parsedRequest).toMatchObject({ stream: true, temperature: 0, max_completion_tokens: 321, reasoning_effort: 'high' })
    expect(parsedRequest).not.toHaveProperty('max_tokens')
    expect(result).toEqual({ content: 'Hello world', reasoning: 'think' })
    expect(deltas.some((delta) => delta.reasoning === 'think ')).toBe(true)
    expect(deltas.filter((delta) => delta.content).map((delta) => delta.content).join('')).toBe('Hello world')
    expect(deltas.at(-1)?.finishReason).toBe('stop')
    expect(timings.map((event) => event.metric)).toEqual(['request_start', 'TTFB', 'first_sse', 'TTFR', 'TTFC'])
    expect(timings.every((event) => event.elapsedMs >= 0)).toBe(true)
  })

  it('keeps split think tags out of streamed content', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      for (const content of ['<th', 'ink>hidden ', 'trace</th', 'ink>Visible']) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
      }
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      response.end('data: [DONE]\n\n')
    })
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const streamed = { content: '', reasoning: '' }
    const result = await new OpenAiCompatibleProvider().streamDetailed(
      's', 'u', { endpoint: `http://127.0.0.1:${address.port}`, model: 'm', apiKey: '' },
      (delta) => { streamed.content += delta.content; streamed.reasoning += delta.reasoning }
    )
    expect(streamed).toEqual({ content: 'Visible', reasoning: 'hidden trace' })
    expect(result).toEqual({ content: 'Visible', reasoning: 'hidden trace' })
  })

  it('falls back to complete JSON when a compatible provider ignores stream=true', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'Fallback answer', reasoning_content: 'Fallback reasoning' } }] }))
    })
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const deltas: string[] = []
    const result = await new OpenAiCompatibleProvider().streamDetailed(
      's', 'u', { endpoint: `http://127.0.0.1:${address.port}`, model: 'm', apiKey: '' },
      (delta) => deltas.push(delta.content)
    )
    expect(result).toEqual({ content: 'Fallback answer', reasoning: 'Fallback reasoning' })
    expect(deltas).toEqual(['Fallback answer'])
  })

  it('rejects an SSE response that ends without a terminal event', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n')
    })
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    await expect(new OpenAiCompatibleProvider().streamDetailed(
      's', 'u', { endpoint: `http://127.0.0.1:${address.port}`, model: 'm', apiKey: '' }, () => undefined
    )).rejects.toThrow('未收到完成标记')
  })

  it('accepts a useful partial SSE response when strict stream termination is explicitly disabled', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"partial but useful"},"finish_reason":null}]}\n\n')
    })
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const result = await new OpenAiCompatibleProvider().streamDetailed(
      's', 'u',
      { endpoint: `http://127.0.0.1:${address.port}`, model: 'm', apiKey: '', strictStreamTermination: false },
      () => undefined
    )
    expect(result).toEqual({ content: 'partial but useful', reasoning: null })
  })

  it('honors a caller-specific request timeout without changing the provider-wide transport', async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: 'too late' } }] }))
      }, 180)
    })
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')

    await expect(new OpenAiCompatibleProvider().completeDetailed('s', 'u', {
      endpoint: `http://127.0.0.1:${address.port}`,
      model: 'm',
      apiKey: '',
      requestTimeoutMs: 40
    })).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('redacts credential-shaped values echoed by an AI error response', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'token=server-secret Authorization: Bearer echoed-secret request_id=req-7' } }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')

    await expect(new OpenAiCompatibleProvider().completeDetailed('s', 'u', {
      endpoint: `http://127.0.0.1:${address.port}`,
      model: 'm',
      apiKey: 'client-secret'
    })).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('token=[redacted]')
        && message.includes('Bearer [redacted]')
        && message.includes('request_id=req-7')
        && !message.includes('server-secret')
        && !message.includes('echoed-secret')
        && !message.includes('client-secret')
    })
  })

  it('streams multi-message chat and aggregates split tool-call deltas with raw finish reason', async () => {
    let requestBody = ''
    const server = createServer((request, response) => {
      request.setEncoding('utf8')
      request.on('data', (chunk) => { requestBody += chunk })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'need tool' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search_docs', arguments: '{"q":' } }] }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"origread"}' } }] }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const provider = new OpenAiCompatibleProvider()
    const deltas: Array<{ finishReason: string | null; toolArguments: string }> = []
    const result = await provider.streamChatDetailed(
      [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'Previous answer' },
        { role: 'user', content: 'Search now' }
      ],
      { endpoint: `http://127.0.0.1:${address.port}`, model: 'chat-model', apiKey: '' },
      (delta) => deltas.push({
        finishReason: delta.finishReason,
        toolArguments: delta.toolCalls.map((call) => call.argumentsDelta).join('')
      }),
      [{ name: 'search_docs', description: 'Search docs', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]
    )

    expect(JSON.parse(requestBody)).toMatchObject({
      model: 'chat-model',
      stream: true,
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'Previous answer' },
        { role: 'user', content: 'Search now' }
      ],
      tools: [{ type: 'function', function: { name: 'search_docs', description: 'Search docs' } }]
    })
    expect(result).toEqual({
      content: '',
      reasoning: 'need tool',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call-1', name: 'search_docs', argumentsJson: '{"q":"origread"}' }]
    })
    expect(deltas.map((delta) => delta.toolArguments).join('')).toBe('{"q":"origread"}')
    expect(deltas.at(-1)?.finishReason).toBe('tool_calls')
  })

  it('serializes assistant tool calls and tool results for the next chat step', async () => {
    let requestBody = ''
    const server = createServer((request, response) => {
      request.setEncoding('utf8')
      request.on('data', (chunk) => { requestBody += chunk })
      request.on('end', () => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: 'Final answer' }, finish_reason: 'stop' }] }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const result = await new OpenAiCompatibleProvider().completeChatDetailed([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'lookup', argumentsJson: '{"id":1}' }] },
      { role: 'tool', toolCallId: 'call-1', content: '{"value":"result"}' }
    ], { endpoint: `http://127.0.0.1:${address.port}`, model: 'm', apiKey: '' })

    expect(result).toEqual({ content: 'Final answer', reasoning: null, finishReason: 'stop', toolCalls: [] })
    expect(JSON.parse(requestBody).messages).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"value":"result"}' }
    ])
  })
})


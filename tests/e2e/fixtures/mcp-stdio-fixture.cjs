const fs = require('node:fs')

const logPath = process.env.ORIGREAD_MCP_FIXTURE_LOG || ''

function append(event) {
  if (!logPath) return
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8')
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

append({
  event: 'started',
  pid: process.pid,
  secretPresent: process.env.FIXTURE_SECRET === 'local-secret-value',
  args: process.argv.slice(2)
})

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('end', () => append({ event: 'stdin-end', pid: process.pid }))
process.stdin.on('data', (chunk) => {
  buffered += chunk
  while (true) {
    const newline = buffered.indexOf('\n')
    if (newline < 0) break
    const line = buffered.slice(0, newline).replace(/\r$/, '')
    buffered = buffered.slice(newline + 1)
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const method = typeof message.method === 'string' ? message.method : ''
    append({ event: 'message', method })
    if (method === 'server/discover') {
      // Deliberately behave like a pre-2026 MCP server so the client exercises
      // its stdio sibling-probe fallback and then performs initialize normally.
      fail(message.id, -32601, 'Method not found')
      continue
    }
    if (method === 'initialize') {
      reply(message.id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'stdio-fixture', title: 'Stdio Fixture Server', version: '1.0.0' }
      })
      continue
    }
    if (method === 'notifications/initialized') continue
    if (method === 'tools/list') {
      reply(message.id, {
        tools: [
          {
            name: 'read_local_note',
            title: 'Read local note',
            description: 'Returns a local fixture value',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            annotations: { readOnlyHint: true, openWorldHint: false }
          },
          {
            name: 'write_local_note',
            title: 'Write local note',
            description: 'Writes a local fixture value',
            inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
            annotations: { readOnlyHint: false, destructiveHint: true }
          }
        ]
      })
      continue
    }
    if (method === 'tools/call') {
      const name = message.params && typeof message.params.name === 'string' ? message.params.name : ''
      const args = message.params && message.params.arguments && typeof message.params.arguments === 'object'
        ? message.params.arguments
        : {}
      append({ event: 'tool-call', name, args, secretPresent: process.env.FIXTURE_SECRET === 'local-secret-value' })
      reply(message.id, {
        content: [{ type: 'text', text: `${name}:ok:${String(args.id || args.title || '')}` }]
      })
      continue
    }
    if (message.id !== undefined) fail(message.id, -32601, `Method not found: ${method}`)
  }
})

process.on('SIGTERM', () => {
  append({ event: 'sigterm', pid: process.pid })
  process.exit(0)
})
process.on('exit', () => append({ event: 'exit', pid: process.pid }))

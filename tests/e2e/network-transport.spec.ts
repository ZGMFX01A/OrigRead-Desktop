import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Electron main global fetch reuses same-origin Undici connections', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.setHeader('connection', 'keep-alive')
    response.end('ok')
  })
  let connectionCount = 0
  server.on('connection', () => { connectionCount += 1 })
  await listen(server)

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Transport fixture server did not expose a TCP port')
  const url = `http://127.0.0.1:${address.port}/transport-audit`
  const origin = new URL(url).origin
  const testApp = await launchIsolatedOrigRead()

  try {
    const audit = await testApp.app.evaluate(async (_electron, { url, origin, port }) => {
      const diagnostics = process.getBuiltinModule('node:diagnostics_channel')
      if (!diagnostics) throw new Error('Electron Node runtime does not expose diagnostics_channel')
      const phaseCounts = {
        beforeConnect: 0,
        connected: 0,
        sendHeaders: 0,
        responseHeaders: 0,
        firstBodyChunk: 0
      }
      const channels = [
        'undici:client:beforeConnect',
        'undici:client:connected',
        'undici:client:sendHeaders',
        'undici:request:headers',
        'undici:request:bodyChunkReceived'
      ] as const

      const onDiagnostic = (message: unknown, channel: string | symbol): void => {
        const record = message as {
          connectParams?: { port?: string }
          request?: { origin?: string | URL }
        }
        const name = String(channel)
        if (name.startsWith('undici:client:') && name !== 'undici:client:sendHeaders') {
          if (record.connectParams?.port !== port) return
        } else if (String(record.request?.origin ?? '') !== origin) {
          return
        }
        if (name === 'undici:client:beforeConnect') phaseCounts.beforeConnect += 1
        else if (name === 'undici:client:connected') phaseCounts.connected += 1
        else if (name === 'undici:client:sendHeaders') phaseCounts.sendHeaders += 1
        else if (name === 'undici:request:headers') phaseCounts.responseHeaders += 1
        else if (name === 'undici:request:bodyChunkReceived') phaseCounts.firstBodyChunk += 1
      }

      channels.forEach((channel) => diagnostics.subscribe(channel, onDiagnostic))
      try {
        for (let index = 0; index < 3; index += 1) {
          const response = await fetch(url)
          if (!response.ok) throw new Error(`Transport fixture returned HTTP ${response.status}`)
          await response.text()
        }
      } finally {
        channels.forEach((channel) => diagnostics.unsubscribe(channel, onDiagnostic))
      }

      return {
        electron: process.versions.electron,
        node: process.versions.node,
        undici: process.versions.undici,
        phaseCounts
      }
    }, { url, origin, port: String(address.port) })

    expect(audit.electron).toBeTruthy()
    expect(audit.node).toBeTruthy()
    expect(audit.undici).toBeTruthy()
    expect(audit.phaseCounts.sendHeaders).toBe(3)
    expect(audit.phaseCounts.responseHeaders).toBe(3)
    expect(audit.phaseCounts.firstBodyChunk).toBeGreaterThanOrEqual(3)
    // Undici's global dispatcher owns an origin pool; it is not required to collapse all
    // traffic onto one socket. The regression we care about is accidental per-request
    // client/Agent creation, which would require one new connection for every request.
    expect(audit.phaseCounts.beforeConnect).toBeGreaterThan(0)
    expect(audit.phaseCounts.beforeConnect).toBeLessThan(3)
    expect(audit.phaseCounts.connected).toBe(audit.phaseCounts.beforeConnect)
    expect(connectionCount).toBe(audit.phaseCounts.connected)
    expect(connectionCount).toBeLessThan(3)
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

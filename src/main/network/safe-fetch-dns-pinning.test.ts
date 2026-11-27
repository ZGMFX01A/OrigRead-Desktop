import { describe, expect, it, vi } from 'vitest'
import type { LookupFunction } from 'node:net'

const captured = vi.hoisted(() => ({lookups: [] as LookupFunction[], closes: 0}))
vi.mock('undici', () => ({Agent: class {
  constructor(options: {connect:{lookup:LookupFunction}}) { captured.lookups.push(options.connect.lookup) }
  async close() { captured.closes++ }
}}))
import { safeFetch } from './safe-fetch'

it('pins the validated DNS answers into the socket lookup without resolving again', async () => {
  const lookup = vi.fn().mockResolvedValueOnce([{address:'1.1.1.1'},{address:'2606:4700:4700::1111'}]).mockResolvedValue([{address:'127.0.0.1'}])
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
  await safeFetch('https://rebind.example/', undefined, {lookup, fetchImpl})
  expect(lookup).toHaveBeenCalledTimes(1)
  expect(fetchImpl.mock.calls[0]![1]).toHaveProperty('dispatcher')
  const socketLookup = captured.lookups.at(-1)!
  const all = vi.fn()
  socketLookup('rebind.example',{all:true},all)
  expect(all).toHaveBeenCalledWith(null,[{address:'1.1.1.1',family:4},{address:'2606:4700:4700::1111',family:6}])
  const one = vi.fn()
  socketLookup('rebind.example',{family:6},one)
  expect(one).toHaveBeenCalledWith(null,'2606:4700:4700::1111',6)
  expect(lookup).toHaveBeenCalledTimes(1)
  expect(captured.closes).toBe(1)
})

it('revalidates and pins each redirect hop independently', async () => {
  const lookup = vi.fn().mockResolvedValueOnce([{address:'1.1.1.1'}]).mockResolvedValueOnce([{address:'192.168.0.1'}])
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://rebind.example/next'}}))
  await expect(safeFetch('https://rebind.example/',undefined,{lookup,fetchImpl})).rejects.toThrow('私网')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(lookup).toHaveBeenCalledTimes(2)
})

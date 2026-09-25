import { expect, it } from 'vitest'
import { dependenciesSatisfied } from './sync-apply-dependencies'

it('requires applied explicit dependencies, without requiring unrelated paused lane history', () => {
  const dependencies = '[{"actorIncarnationId":"remote","replicationLaneId":"LIBRARY","sequence":2}]'
  expect(dependenciesSatisfied(dependencies, {})).toBe(false)
  expect(dependenciesSatisfied(dependencies, { LIBRARY: { remote: 1 } })).toBe(false)
  expect(dependenciesSatisfied(dependencies, { LIBRARY: { remote: 2 } })).toBe(true)
  expect(dependenciesSatisfied('[]', {})).toBe(true)
})

it.each(['{}', 'null', '[{}]', '[{"actorIncarnationId":"a","replicationLaneId":"LIBRARY","sequence":0}]'])('rejects malformed dependency %s', (value) => {
  expect(dependenciesSatisfied(value, {})).toBe(false)
})

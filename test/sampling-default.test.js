import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/sampling-default.js'

test('pins temperature only for the configured provider when absent on the seed', async () => {
  let handler
  apply({ on: (_ev, fn) => { handler = fn } }, { provider: 'local-ubuntu', temperature: 0.4 })

  const pinned = await handler({}, async () => ({ provider: 'local-ubuntu', model: 'v4' }))
  assert.equal(pinned.temperature, 0.4)

  const explicit = await handler({}, async () => ({ provider: 'local-ubuntu', model: 'v4', temperature: 0.9 }))
  assert.equal(explicit.temperature, 0.9)

  const other = await handler({}, async () => ({ provider: 'deepseek', model: 'chat' }))
  assert.equal(other.temperature, undefined)
})

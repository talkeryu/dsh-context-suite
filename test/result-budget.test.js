import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/result-budget.js'

function makeHarness(pressureThreshold) {
  let pruned = 0
  let pressure = 0
  let handler
  const ctx = {
    toolResultPruner: { pruneSession: () => { pruned += 1 } },
    tokenMeter: { contextPressure: () => ({ pressureTokens: pressure }) },
    on: (_ev, fn) => { handler = fn },
    logger: { warn() {} },
  }
  apply(ctx, { pressureThreshold })
  return {
    pruned: () => pruned,
    step: async (at) => {
      pressure = at
      return handler({ agent: { session: {} } }, async () => ({ kind: 'enter' }))
    },
  }
}

test('prunes on every step when pressureThreshold is 0', async () => {
  const h = makeHarness(0)
  await h.step(1_000)
  await h.step(2_000)
  assert.equal(h.pruned(), 2)
})

test('prunes only at or above pressureThreshold when configured', async () => {
  const h = makeHarness(200_000)
  await h.step(50_000)
  assert.equal(h.pruned(), 0)
  await h.step(200_000)
  assert.equal(h.pruned(), 1)
})

test('reads the pruner from the plugin context, never through the agent context', async () => {
  // Cordis throws when a context reads a service its fiber did not inject, and
  // the agent's own context does not inject toolResultPruner. Reading it there
  // threw on every step, the catch swallowed it, and nothing was ever pruned.
  let pruned = 0
  let handler
  const ctx = {
    toolResultPruner: { pruneSession: () => { pruned += 1 } },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 0 }) },
    on: (_ev, fn) => { handler = fn },
    logger: { warn() {} },
  }
  apply(ctx, { pressureThreshold: 0 })
  const agentCtx = new Proxy({}, {
    get: (_target, key) => { throw new Error(`cannot get property "${String(key)}" without inject`) },
  })
  await handler({ agent: { session: {}, ctx: agentCtx } }, async () => ({ kind: 'enter' }))
  assert.equal(pruned, 1)
})

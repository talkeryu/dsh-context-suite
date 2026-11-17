import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/lazy-tools.js'

/** Create an isolated agent tool scope (`agent.ctx.tools`) with its own deny set. */
function makeScope(names) {
  const denied = new Set()
  const tools = {
    schemas: () => names.filter((n) => !denied.has(n)).map((n) => ({ name: n })),
    restrict: ({ deny }) => {
      for (const n of deny) denied.add(n)
      return () => { for (const n of deny) denied.delete(n) }
    },
  }
  return { denied, tools }
}

/**
 * A faithful host `ctx`: `ctx.tools.restrict()` on the root context ALWAYS
 * throws in production DSH (`tools.restrict() requires a scoped context (agent.ctx)`),
 * so tests fail immediately if `lazy-tools` ever falls back to root `restrict`.
 */
function makeCtx(names) {
  const handlers = new Map()
  let registered
  const ctx = {
    tools: {
      schemas: () => names.map((n) => ({ name: n })),
      restrict: () => {
        throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
      },
      register: (def) => { registered = def },
    },
    on: (event, fn) => { handlers.set(event, fn) },
    logger: { warn: (msg) => { throw new Error(`unexpected warn: ${msg}`) } },
  }
  const makeAgent = (id = 'A', sessionId = `sess-${id}`) => {
    const scope = makeScope(names)
    return {
      agent: { id, session: { id: sessionId }, ctx: { tools: scope.tools } },
      denied: scope.denied,
    }
  }
  const step = async (agent) => {
    const fn = handlers.get('agent/pre-step')
    return fn({ agent }, async () => ({ kind: 'enter' }))
  }
  const create = (agent) => handlers.get('agent/created')?.({ agent })
  const turnStart = (session) => handlers.get('session/event')?.(session, { type: 'turn/start', data: { turn: 1 } })
  const dispose = (agent) => handlers.get('agent/disposed')?.({ agent })
  return { ctx, makeAgent, step, create, turnStart, dispose, tool: () => registered }
}

const GROUPS = [
  { id: 'a', prefix: 'mcp__a__', description: 'Group A' },
  { id: 'b', prefix: 'mcp__b__', description: 'Group B' },
]

test('hides every configured group, and reveal keeps each one visible across later steps', async () => {
  const h = makeCtx(['mcp__a__x', 'mcp__a__y', 'mcp__b__z'])
  const { agent, denied } = h.makeAgent('A')
  apply(h.ctx, { groups: GROUPS })
  await h.step(agent)
  assert.deepEqual([...denied].sort(), ['mcp__a__x', 'mcp__a__y', 'mcp__b__z'])

  const a = await h.tool().execute({ group: 'a' }, { agent })
  assert.match(a, /Revealed 2 tools/)
  assert.deepEqual([...denied], ['mcp__b__z'])

  // Next step must NOT re-hide a group the agent just revealed.
  await h.step(agent)
  assert.deepEqual([...denied], ['mcp__b__z'])

  const b = await h.tool().execute({ group: 'b' }, { agent })
  assert.match(b, /Revealed 1 tools/)
  await h.step(agent)
  assert.deepEqual([...denied], [])
})

test('hide:true on an already-hidden group keeps it hidden instead of disposing the restriction', async () => {
  const h = makeCtx(['mcp__a__x', 'mcp__a__y'])
  const { agent, denied } = h.makeAgent('A')
  apply(h.ctx, { groups: GROUPS })
  await h.step(agent)
  assert.deepEqual([...denied].sort(), ['mcp__a__x', 'mcp__a__y'])

  const out = await h.tool().execute({ group: 'a', hide: true }, { agent })
  assert.match(out, /already hidden/)
  assert.deepEqual([...denied].sort(), ['mcp__a__x', 'mcp__a__y'])
})

test('cold-start: agent/created before MCP registration catches up at turn/start before step 1', () => {
  const names = []
  const h = makeCtx(names)
  const { agent, denied } = h.makeAgent('A', 'sess-cold')
  apply(h.ctx, { groups: GROUPS })

  // 1. Tab opens before MCP handshake completes.
  h.create(agent)
  assert.equal(denied.size, 0)

  // 2. MCP registers tools, then user hits Enter (`turn/start` fires before `tools.resolve()`).
  names.push('mcp__a__x', 'mcp__a__y')
  h.turnStart(agent.session)
  assert.deepEqual([...denied].sort(), ['mcp__a__x', 'mcp__a__y'])
})

test('keeps state isolated per agent scope and cleans up on agent/disposed', async () => {
  const h = makeCtx(['mcp__a__x'])
  const a = h.makeAgent('A')
  const b = h.makeAgent('B')

  apply(h.ctx, { groups: GROUPS })
  await h.step(a.agent)
  await h.step(b.agent)
  assert.deepEqual([...a.denied], ['mcp__a__x'])
  assert.deepEqual([...b.denied], ['mcp__a__x'])

  await h.tool().execute({ group: 'a' }, { agent: a.agent })
  await h.step(a.agent)
  await h.step(b.agent)
  assert.equal(a.denied.size, 0)
  assert.deepEqual([...b.denied], ['mcp__a__x'])

  // Disposing A clears its latched `revealed` entry (and lastAgent if matching).
  h.dispose(a.agent)
  const freshA = h.makeAgent('A')
  await h.step(freshA.agent)
  assert.deepEqual([...freshA.denied], ['mcp__a__x'])
})

test('hide:true acts on the calling agent after reveal and survives later steps', async () => {
  const h = makeCtx(['mcp__a__x'])
  const { agent, denied } = h.makeAgent('A')
  apply(h.ctx, { groups: GROUPS })
  await h.step(agent)
  await h.tool().execute({ group: 'a' }, { agent })
  await h.step(agent)
  assert.equal(denied.size, 0)

  const out = await h.tool().execute({ group: 'a', hide: true }, { agent })
  assert.match(out, /Hid 1 tools/)
  assert.deepEqual([...denied], ['mcp__a__x'])
  await h.step(agent)
  assert.deepEqual([...denied], ['mcp__a__x'])
})

test('does not fall back to root ctx.tools.restrict when agent.ctx throws, then hides once ready', async () => {
  const h = makeCtx(['mcp__a__x', 'mcp__a__y'])
  apply(h.ctx, { groups: GROUPS })

  const throwingCtx = new Proxy({}, {
    get: (_t, key) => { throw new Error(`cannot get property "${String(key)}" without inject`) },
  })
  // Root `ctx.tools.restrict` in `makeCtx` throws, and `logger.warn` throws —
  // if `lazy-tools` fell back to root `ctx.tools`, this call would fail.
  h.create({ id: 'A', ctx: throwingCtx })

  // Once the agent has a real scoped `tools` service, retry succeeds and hides the group.
  const ready = h.makeAgent('A')
  await h.step(ready.agent)
  assert.deepEqual([...ready.denied].sort(), ['mcp__a__x', 'mcp__a__y'])
})

test('handles unknown groups, missing agent scope, and empty config gracefully', async () => {
  const empty = makeCtx(['mcp__a__x'])
  apply(empty.ctx, { groups: [] })
  assert.equal(empty.tool(), undefined)

  const h = makeCtx(['mcp__a__x'])
  apply(h.ctx, { groups: GROUPS })
  assert.match(await h.tool().execute({ group: 'nope' }, {}), /Unknown group/)
  assert.match(await h.tool().execute({ group: 'a' }, {}), /No agent scope/)
})

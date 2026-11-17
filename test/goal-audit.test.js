import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, summarize } from '../lib/goal-audit.js'

/** A session whose events are keyed by seq. */
function makeSession(events, nodes = Object.keys(events).map(Number)) {
  return {
    id: 'sess-1',
    surface: { nodes },
    eventAt: (seq) => events[seq],
  }
}

test('counts tool results that arrive without a call in the same range', () => {
  // A background job's result lands in a later round than its call.
  const session = makeSession({
    1: { type: 'user/message', data: {} },
    2: { type: 'tool/result', data: { isError: false } },
    3: { type: 'tool/result', data: { isError: false } },
  })
  const body = summarize(session, [1, 3], 0, 8)
  assert.match(body, /0 tool calls, 2 tool results, 0 errors/)
})

test('reports an idle round instead of staying silent', () => {
  const session = makeSession({ 1: { type: 'user/message', data: {} } })
  const body = summarize(session, [1], 0, 8)
  assert.equal(body, 'Previous round: no tool calls, no tool results.')
})

test('counts calls, results, written files, and errors together', () => {
  const session = makeSession({
    1: { type: 'user/message', data: {} },
    2: { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/a.js' }) } },
    3: { type: 'tool/result', data: { isError: true } },
    4: { type: 'tool/call', data: { name: 'edit', input: { path: '/tmp/b.js' } } },
  })
  const body = summarize(session, [1, 4], 0, 8)
  assert.match(body, /2 tool calls, 1 tool result, 1 error/)
  assert.match(body, /Files written: \/tmp\/a\.js, \/tmp\/b\.js/)
})

test('apply injects <goal_round_audit> once when round 2 starts', async () => {
  const events = {
    1: { type: 'user/message', data: { source: { kind: 'goal', round: 1 } } },
    2: { type: 'tool/call', data: { name: 'bash' } },
    3: { type: 'tool/result', data: { isError: false } },
    4: { type: 'user/message', data: { source: { kind: 'goal', round: 2 } } },
  }
  const session = makeSession(events, [1, 3, 4])
  const injected = []
  const agent = { id: 'ag-1', session, inject: (msg) => injected.push(msg) }
  const handlers = new Map()
  const ctx = {
    agents: { get: (id) => (id === session.id ? agent : undefined) },
    on: (ev, fn) => { handlers.set(ev, fn) },
    logger: { warn() {} },
  }

  apply(ctx, { maxPaths: 4 })
  handlers.get('session/event')(session, events[4])
  // Duplicate delivery for the same round is ignored.
  handlers.get('session/event')(session, events[4])
  await new Promise((r) => queueMicrotask(r))

  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /<goal_round_audit>/)
  assert.match(injected[0].content[0].text, /1 tool call, 1 tool result, 0 errors/)
})

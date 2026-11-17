import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/context-reminder.js'

/** A fake ctx: one pressure reading per step, plus a session/event bus. */
function makeCtx() {
  const handlers = new Map()
  let pressure
  const ctx = {
    tokenMeter: { contextPressure: () => ({ pressureTokens: pressure }) },
    on: (event, fn) => { handlers.set(event, fn) },
    logger: { warn() {} },
  }
  const step = async (session, at) => {
    pressure = at
    const fn = handlers.get('agent/pre-step')
    return fn({ agent: { session }, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  }
  const prune = (session, tokens) => {
    handlers.get('session/event')?.(session, { type: 'compaction/prune', data: { shadowedTokenCount: tokens } })
  }
  const header = (session, toolCount) => {
    handlers.get('session/event')?.(session, {
      type: 'request/header',
      data: { header: { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `t${i}` })) } },
    })
  }
  return { ctx, step, prune, header }
}

const text = (decision) => decision.messages.map((m) => m.content.map((c) => c.text).join('')).join('\n')

test('a prune is not a fold', async () => {
  const h = makeCtx()
  apply(h.ctx, {})
  const session = { id: 's' }
  await h.step(session, 100_000)
  h.prune(session, 20_000)
  const decision = await h.step(session, 80_000)
  assert.doesNotMatch(text(decision), /context_folded/)
})

test('preserves prune credit when pressureTokens has not updated yet', async () => {
  const h = makeCtx()
  apply(h.ctx, {})
  const session = { id: 's' }
  await h.step(session, 100_000)
  h.prune(session, 20_000)
  // Same pressure reading (no request ran yet): must not consume the prune credit.
  await h.step(session, 100_000)
  const decision = await h.step(session, 80_000)
  assert.doesNotMatch(text(decision), /context_folded/)
})

test('a real drop reports a fold and points to the newest note', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ctx-rem-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const notePath = join(dir, '2026-11-16-work.md')
  await writeFile(notePath, '# Goal\nship it\n', 'utf8')

  const h = makeCtx()
  apply(h.ctx, { dir })
  const session = { id: 's' }
  await h.step(session, 100_000)
  const decision = await h.step(session, 50_000)
  assert.match(text(decision), /context_folded/)
  assert.ok(text(decision).includes(notePath))
})

test('growth after a prune still counts toward the reminder', async () => {
  const h = makeCtx()
  apply(h.ctx, {})
  const session = { id: 's' }
  await h.step(session, 100_000)
  h.prune(session, 20_000)
  // Net +40k after the prune: the pruned 20k was real growth, so the band fires.
  const decision = await h.step(session, 120_000)
  assert.match(text(decision), /context_window_reminder/)
})

test('unloading MCP tool schemas (298 -> 43 tools) is not misreported as a fold', async () => {
  const h = makeCtx()
  apply(h.ctx, {})
  const session = { id: 's' }
  h.header(session, 298)
  await h.step(session, 105_094)
  h.header(session, 43)
  const decision = await h.step(session, 22_307)
  assert.doesNotMatch(text(decision), /context_folded/)
})

test('still reports a real fold when a small tool-count drop lands on the same step', async () => {
  const h = makeCtx()
  apply(h.ctx, {})
  const session = { id: 's' }
  h.header(session, 45)
  await h.step(session, 95_000)
  // Two tools disappeared (~700 tokens) AND history folded (-55k tokens) on the same step.
  h.header(session, 43)
  const decision = await h.step(session, 39_000)
  assert.match(text(decision), /context_folded/)
})

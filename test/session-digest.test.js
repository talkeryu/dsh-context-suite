import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, buildDigest, isSynthetic } from '../lib/session-digest.js'

/**
 * A fake session whose surface holds only message events, like the real one:
 * `surface.nodes` never contains `turn/end`, `step/end` or `tool/call`.
 */
function makeSession(id, events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const nodes = events.filter((e) => e.type.endsWith('/message') || e.type === 'tool/result').map((e) => e.seq)
  return {
    id,
    seq: Math.max(...events.map((e) => e.seq)),
    surface: { nodes },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => (event.type === 'user/message' ? event.data : null),
  }
}

const user = (seq, text, kind = 'user') => ({
  seq,
  type: 'user/message',
  data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind } },
})

test('counts turns, steps and tool calls that live outside the surface', () => {
  const session = makeSession('test', [
    user(1, 'do the thing'),
    { seq: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 4, type: 'tool/call', data: { name: 'bash' } },
    { seq: 5, type: 'tool/result', data: {} },
    { seq: 6, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 7, type: 'turn/end', data: { turn: 1 } },
  ])
  const digest = buildDigest(session, 160, 12)
  assert.match(digest, /turns 1 · steps 1 · tool calls 1/)
  assert.match(digest, /bash×1/)
})

test('skips injected user messages, which carry a non-user source kind', () => {
  const session = makeSession('test', [
    user(1, 'real question'),
    user(2, '<available_skills>…', 'skill-catalog'),
    user(3, '<goal_round_audit>…', 'goal-audit'),
    user(4, 'Time sampled…', 'time-context'),
  ])
  const digest = buildDigest(session, 160, 12)
  assert.match(digest, /real question/)
  assert.doesNotMatch(digest, /available_skills/)
  assert.doesNotMatch(digest, /goal_round_audit/)
  assert.doesNotMatch(digest, /Time sampled/)
})

test('reads the source from data.source, not data.message.source', () => {
  assert.equal(isSynthetic(user(1, 'hi', 'user')), false)
  assert.equal(isSynthetic(user(1, 'hi', 'repl')), false)
  assert.equal(isSynthetic(user(1, 'hi', 'goal')), true)
  assert.equal(isSynthetic({ seq: 1, type: 'user/message', data: { message: { source: { kind: 'goal' } } } }), false)
})

test('writes a digest on turn/end and injects it once into the next session', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sess-dig-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const handlers = new Map()
  const ctx = {
    on: (ev, fn) => { handlers.set(ev, fn) },
    logger: { warn() {} },
  }
  apply(ctx, { dir })

  const s1 = makeSession('sess-one', [
    user(1, 'investigate context folding'),
    { seq: 2, type: 'tool/call', data: { name: 'read' } },
    { seq: 3, type: 'turn/end', data: { turn: 1 } },
  ])
  handlers.get('session/event')(s1, { type: 'turn/end' })
  // Wait briefly for async flush
  for (let i = 0; i < 20; i += 1) {
    if ((await readdir(dir)).length > 0) break
    await new Promise((r) => setTimeout(r, 10))
  }

  const s2 = makeSession('sess-two', [user(1, 'continue work')])
  const preStep = handlers.get('agent/pre-step')
  const first = await preStep({ agent: { session: s2 }, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.messages.length, 1)
  assert.match(first.messages[0].content[0].text, /<previous_session>/)
  assert.match(first.messages[0].content[0].text, /investigate context folding/)

  // Second turn of the same session must not re-inject.
  const second = await preStep({ agent: { session: s2 }, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(second.messages.length, 0)
})

test('injects the newest digest by write time, not by filename order', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sess-dig-order-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const handlers = new Map()
  const ctx = {
    on: (ev, fn) => { handlers.set(ev, fn) },
    logger: { warn() {} },
  }
  apply(ctx, { dir })

  // Same-day names sort by session id: "ffff" beats "0000" lexicographically,
  // but "0000" is the digest written last.
  const older = join(dir, '2026-11-17-session-ffffffff.md')
  const newer = join(dir, '2026-11-17-session-00000000.md')
  await writeFile(older, '# old\n- stale question\n', 'utf8')
  await writeFile(newer, '# new\n- fresh question\n', 'utf8')
  await utimes(older, new Date(1_000), new Date(1_000))
  await utimes(newer, new Date(2_000), new Date(2_000))

  const session = makeSession('sess-current', [user(1, 'continue')])
  const preStep = handlers.get('agent/pre-step')
  const result = await preStep({ agent: { session }, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(result.messages.length, 1)
  assert.match(result.messages[0].content[0].text, /fresh question/)
  assert.doesNotMatch(result.messages[0].content[0].text, /stale question/)
})

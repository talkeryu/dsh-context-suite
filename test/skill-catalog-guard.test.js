import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, render } from '../lib/skill-catalog-guard.js'

test('filters out skills with modelInvocable === false in both shapes', () => {
  const text = render(
    [
      { name: 'alpha', description: 'Visible skill\nextra line' },
      { name: 'hidden-nested', description: 'Secret', invocation: { modelInvocable: false } },
      { name: 'hidden-flat', description: 'Secret', modelInvocable: false },
    ],
    200,
    false,
  )
  assert.match(text, /`alpha`: Visible skill/)
  assert.doesNotMatch(text, /hidden-nested/)
  assert.doesNotMatch(text, /hidden-flat/)
  assert.match(text, /listing may be incomplete/)
})

test('skips step 1 when dsh-tool-skill already queued a catalog in decision.messages, and restores after fold', async () => {
  const handlers = new Map()
  const ctx = {
    skills: {
      snapshot: async () => ({
        skills: [{ name: 'context-mechanics', description: 'Survive folds', invocation: { modelInvocable: true } }],
        complete: true,
      }),
    },
    workingDirectory: { ensure: async () => '/tmp' },
    on: (ev, fn) => { handlers.set(ev, fn) },
    logger: { warn() {} },
  }
  apply(ctx, { maxDescriptionChars: 80 })
  const preStep = handlers.get('agent/pre-step')

  const emptySurfaceSession = {
    surface: { nodes: [] },
    eventAt: () => undefined,
    deriveEventMessage: (e) => e?.data,
  }

  // Step 1: dsh-tool-skill already appended its catalog into decision.messages.
  const step1 = await preStep(
    { agent: { session: emptySurfaceSession } },
    async () => ({
      kind: 'enter',
      messages: [{ role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'initial' }] }],
    }),
  )
  assert.equal(step1.messages.length, 1)

  // Post-fold: neither surface nor decision.messages has the catalog -> re-injects.
  const postFold = await preStep(
    { agent: { session: emptySurfaceSession } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(postFold.messages.length, 1)
  assert.match(postFold.messages[0].content[0].text, /`context-mechanics`: Survive folds/)

  // When surface still contains the marker -> stays silent.
  const visibleSession = {
    surface: { nodes: [1] },
    eventAt: () => ({
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'A skill is a reusable set of task-specific instructions' }] },
    }),
    deriveEventMessage: (e) => e.data,
  }
  const intact = await preStep(
    { agent: { session: visibleSession } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(intact.messages.length, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/note-index.js'

test('lists recent notes newest-first on step 1 and skips stale notes and later steps', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'notes-idx-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const oldPath = join(dir, 'old.md')
  const olderRecent = join(dir, 'a.md')
  const newestRecent = join(dir, 'b.md')
  await writeFile(oldPath, '# Old\nstale body\n', 'utf8')
  await writeFile(olderRecent, '# Heading\nfirst recent note\n', 'utf8')
  await writeFile(newestRecent, '# Heading\nnewest note headline\n', 'utf8')

  const now = Date.now() / 1000
  await utimes(oldPath, now - 48 * 3600, now - 48 * 3600)
  await utimes(olderRecent, now - 120, now - 120)
  await utimes(newestRecent, now - 10, now - 10)

  let handler
  apply({ on: (_ev, fn) => { handler = fn }, logger: { warn() {} } }, { dir, maxNotes: 2, maxAgeHours: 24 })

  const step2 = await handler({ step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(step2.messages.length, 0)

  const step1 = await handler({ step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(step1.messages.length, 1)
  const body = step1.messages[0].content[0].text
  assert.match(body, /- b\.md — newest note headline\n- a\.md — first recent note/)
  assert.doesNotMatch(body, /old\.md/)
})

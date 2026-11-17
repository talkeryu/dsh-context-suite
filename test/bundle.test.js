import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as root from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('bundle entry exports a valid no-op Cordis plugin', () => {
  assert.equal(root.name, 'dsh-context-suite')
  assert.equal(typeof root.apply, 'function')
  assert.equal(root.apply(), undefined)
})

test('cordis.patch.yml re-enables tool-result-pruner for desktop and matches package exports', async () => {
  const [patch, pkgRaw] = await Promise.all([
    readFile(join(ROOT, 'cordis.patch.yml'), 'utf8'),
    readFile(join(ROOT, 'package.json'), 'utf8'),
  ])
  const pkg = JSON.parse(pkgRaw)

  // Must explicitly set disabled: false on tool-result-pruner so dsh-web-app's
  // host-plane `disabled: true` is overridden during shallow key merge.
  assert.match(patch, /- id: tool-result-pruner\n\s+disabled: false\n\s+config:/)

  // Every subpath referenced in cordis.patch.yml must exist in package.json exports.
  const refs = [...patch.matchAll(/name:\s*'dsh-context-suite\/([^']+)'/g)].map((m) => `./${m[1]}`)
  assert.equal(refs.length, 8)
  for (const subpath of refs) {
    assert.ok(pkg.exports[subpath], `missing export for ${subpath}`)
  }
})

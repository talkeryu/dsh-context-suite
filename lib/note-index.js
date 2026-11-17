/**
 * Note index.
 *
 * Compaction replaces history with a summary written by a summarizer. The note
 * file was written by the agent while it still had the details, so it is the
 * better recovery source — but after a fold nothing in the context says a note
 * exists. This plugin lists the recent ones at the start of every turn.
 *
 * The bundle is installed by linking its directory, so Node resolves imports
 * from the checkout rather than the profile: this module imports only Node
 * builtins and builds the message by hand.
 *
 * @module @local/dsh-note-index
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_MAX_NOTES = 3
const DEFAULT_MAX_AGE_HOURS = 24
const DEFAULT_DIR = join(homedir(), '.dsh', 'notes')
const HEADLINE_CHARS = 120

export const name = 'note-index'

/**
 * Read one row configuration, tolerating absent or malformed fields.
 * @param config - the raw row configuration from the patch.
 * @returns the directory, the row cap and the age cap.
 */
function resolveConfig(config) {
  const raw = config ?? {}
  const maxNotes = raw.maxNotes
  const maxAgeHours = raw.maxAgeHours
  // `dir` is the documented name; `notesDir` is kept for older rows.
  const dir = typeof raw.dir === 'string' && raw.dir.length > 0
    ? raw.dir
    : typeof raw.notesDir === 'string' && raw.notesDir.length > 0
      ? raw.notesDir
      : DEFAULT_DIR
  return {
    notesDir: dir.replace(/^~(?=\/|$)/, homedir()),
    maxNotes: typeof maxNotes === 'number' && maxNotes > 0 ? Math.floor(maxNotes) : DEFAULT_MAX_NOTES,
    maxAgeHours: typeof maxAgeHours === 'number' && maxAgeHours > 0 ? maxAgeHours : DEFAULT_MAX_AGE_HOURS,
  }
}

/**
 * Find the first non-empty line that is not a heading, for a one-line summary.
 * @param text - the note file contents.
 * @returns a trimmed headline, or the empty string.
 */
function headline(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('#')) continue
    return trimmed.length > HEADLINE_CHARS ? `${trimmed.slice(0, HEADLINE_CHARS)}…` : trimmed
  }
  return ''
}

/**
 * Collect the recent notes, newest first.
 * @param settings - resolved configuration.
 * @returns rows of file name and headline.
 */
async function recentNotes(settings) {
  let entries
  try {
    entries = await readdir(settings.notesDir)
  } catch {
    return []
  }
  const cutoff = Date.now() - settings.maxAgeHours * 3600 * 1000
  const rows = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const path = join(settings.notesDir, entry)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.mtimeMs < cutoff) continue
      rows.push({ name: entry, mtime: info.mtimeMs, path })
    } catch {
      // A note that vanished between readdir and stat is simply absent.
    }
  }
  rows.sort((left, right) => right.mtime - left.mtime)
  const selected = rows.slice(0, settings.maxNotes)
  const out = []
  for (const row of selected) {
    let text = ''
    try {
      text = await readFile(row.path, 'utf8')
    } catch {
      // Keep the file name even when the body is unreadable.
    }
    out.push({ name: row.name, headline: headline(text) })
  }
  return out
}

/**
 * Render the index block.
 * @param rows - collected notes.
 * @returns the message text.
 */
function render(rows) {
  const lines = rows.map(row => (row.headline.length > 0 ? `- ${row.name} — ${row.headline}` : `- ${row.name}`))
  return `<active_notes>
Notes you wrote recently, newest first. Before continuing a task that spans a fold, read the matching one — it was written while you still had the details.
${lines.join('\n')}
</active_notes>`
}

/**
 * Build the immutable user message that carries the index.
 * @param text - rendered index text.
 * @returns a frozen user message with a fresh identity.
 */
function indexMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'note-index' }),
  })
}

/**
 * Register the index on the agent step waterfall.
 * @param ctx - the plugin context.
 * @param config - raw row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  ctx.on('agent/pre-step', async ({ step }, next) => {
    const decision = await next()
    try {
      if (step !== 1) return decision
      if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision

      const rows = await recentNotes(settings)
      if (rows.length === 0) return decision

      const text = render(rows)
      const present = decision.messages.some(
        message => message?.source?.kind === 'note-index'
          && message.content?.[0]?.text === text,
      )
      if (present) return decision

      return { ...decision, messages: [...decision.messages, indexMessage(text)] }
    } catch (error) {
      ctx.logger?.warn?.('note-index: %o', error)
      return decision
    }
  })
}

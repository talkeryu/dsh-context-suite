/**
 * Context-window reminder + fold notice.
 *
 * DSH folds history when the context grows past a threshold, and the fold is
 * silent: the agent keeps working without knowing that the details it relied
 * on have become a summary. Codex solves this with `reminder_threshold_tokens`
 * plus an explicit `<context_window>` marker after a reset.
 *
 * The constant does not translate directly. A DSH session on a 1M-token route
 * rarely approaches the window, because the proxy folds long before that; the
 * turnover this plugin must warn about is the fold, not the window. So the
 * trigger is growth since the last observed drop in request pressure: a drop
 * means a fold replaced history, and growth since then is what the next fold
 * will consume.
 *
 * Two messages:
 *   - `<context_window_reminder>` before the next fold (write a checkpoint now)
 *   - `<context_folded>` right after a fold (read the checkpoint back)
 *
 * The bundle is installed by linking its directory, so Node resolves imports
 * from the checkout rather than the profile: this module imports only Node
 * builtins and builds messages by hand.
 *
 * @module @local/dsh-context-reminder
 */
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_GROWTH_TOKENS = 35000
const DEFAULT_DROP_TOKENS = 8000
const NOTE_DIR = join(homedir(), '.dsh', 'notes')
const NOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000

const DEFAULT_TEXT = `<context_window_reminder>
About {since} tokens have accumulated since the last fold, and compaction is close. If this task will outlive it, append a checkpoint to your note file now: goal, decisions and why, progress, next steps, and the mNNNNN refs of anything you would need to decompress. Then continue. Your note is written by you while you still have the details; the summary is not.
</context_window_reminder>`

const DEFAULT_FOLD_TEXT = `<context_folded>
History was just folded: the messages before this point are now a summary, not the originals. Recover from your own note first{note} — it was written while the details were still in context. Then use search_context / decompress for anything the note does not cover. Do not trust the summary for exact numbers, paths, or quotes.
</context_folded>`

export const name = 'context-reminder'

/** The plugin reads token pressure; without the meter it stays inactive. */
export const inject = ['tokenMeter']

/**
 * Read one row configuration, tolerating absent or malformed fields.
 * @param config - the raw row configuration from the patch.
 * @returns the growth trigger, the drop that counts as a fold, and the texts.
 */
function resolveConfig(config) {
  const raw = config ?? {}
  const growth = raw.growthTokens
  const drop = raw.dropTokens
  const dir = typeof raw.dir === 'string' && raw.dir.length > 0
    ? raw.dir
    : typeof raw.notesDir === 'string' && raw.notesDir.length > 0
      ? raw.notesDir
      : NOTE_DIR
  return {
    growthTokens: typeof growth === 'number' && growth > 0 ? growth : DEFAULT_GROWTH_TOKENS,
    dropTokens: typeof drop === 'number' && drop > 0 ? drop : DEFAULT_DROP_TOKENS,
    notesDir: dir.replace(/^~(?=\/|$)/, homedir()),
    text: typeof raw.text === 'string' && raw.text.length > 0 ? raw.text : DEFAULT_TEXT,
    foldText: typeof raw.foldText === 'string' && raw.foldText.length > 0 ? raw.foldText : DEFAULT_FOLD_TEXT,
    foldNotice: raw.foldNotice !== false,
  }
}

/**
 * Build the immutable user message that carries one injected notice.
 * @param text - rendered text.
 * @param kind - which notice this is.
 * @param step - the step the message enters.
 * @returns a frozen user message with a fresh identity.
 */
function noticeMessage(text, kind, step) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'context-reminder', notice: kind, step }),
  })
}

/**
 * Find the most recent note file, if one was written today.
 * @param notesDir - directory holding `.md` notes.
 * @returns a rendered " (newest note: <path>)" suffix, or an empty string.
 */
async function newestNoteSuffix(notesDir) {
  try {
    const names = (await readdir(notesDir)).filter((n) => n.endsWith('.md'))
    let best
    for (const name of names) {
      const path = join(notesDir, name)
      const info = await stat(path)
      if (Date.now() - info.mtimeMs > NOTE_MAX_AGE_MS) continue
      if (best === undefined || info.mtimeMs > best.mtimeMs) best = { path, mtimeMs: info.mtimeMs }
    }
    return best === undefined ? '' : ` (newest note: ${best.path})`
  } catch {
    return ''
  }
}

/**
 * Register the notices on the agent step waterfall.
 * @param ctx - the plugin context.
 * @param config - raw row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  // Per-session growth accounting. `last` is the previous measured pressure,
  // `since` the growth accumulated since the last fold, `band` the highest
  // growth band already reminded, `folded` a fold not yet announced.
  const state = new WeakMap()
  // Tokens the tool-result pruner removed since the last step. A prune lowers
  // `pressureTokens` exactly like a fold does — `pressureTokens` is the last
  // request's prompt size — so the drop has to be attributed before it can be
  // called a fold. Without this, a bundle that prunes every step tells the
  // model its history was folded when nothing was folded.
  const pruned = new WeakMap()
  // Estimated schema tokens removed when `request/header` declares fewer tools
  // than the previous request (e.g. 298 -> 43 tools removes ~329 KB / ~83k tokens).
  // Accounting the size quantitatively instead of a boolean flag suppresses the
  // false fold from schema unloading while still catching a real fold that
  // happens to land on the same step.
  const toolHeaders = new WeakMap()
  const toolRemoved = new WeakMap()

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'compaction/prune') {
      const removed = event?.data?.shadowedTokenCount
      if (typeof removed === 'number' && removed > 0) {
        pruned.set(session, (pruned.get(session) ?? 0) + removed)
      }
      return
    }
    if (event?.type === 'request/header') {
      const list = event?.data?.header?.tools ?? event?.data?.tools
      if (Array.isArray(list)) {
        let chars = 0
        try {
          chars = JSON.stringify(list).length
        } catch {
          chars = 0
        }
        const prev = toolHeaders.get(session)
        if (prev !== undefined && list.length < prev.count) {
          const charDelta = Math.max(0, prev.chars - chars)
          const estTokens = Math.max(Math.ceil(charDelta / 3.5), (prev.count - list.length) * 350)
          toolRemoved.set(session, (toolRemoved.get(session) ?? 0) + estTokens)
        }
        toolHeaders.set(session, { count: list.length, chars })
      }
    }
  })

  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const session = agent?.session
      if (session === undefined) return decision
      const used = ctx.tokenMeter.contextPressure(session)?.pressureTokens
      if (typeof used !== 'number') return decision

      const entry = state.get(session) ?? { last: undefined, since: 0, band: 0, folded: false }
      // If no request has updated `pressureTokens` since the last check, keep
      // any queued `compaction/prune` or tool-unload credit for the step that sees it.
      if (entry.last !== undefined && used === entry.last) return decision

      const prunedSince = pruned.get(session) ?? 0
      pruned.set(session, 0)
      const unloadedToolsSince = toolRemoved.get(session) ?? 0
      toolRemoved.set(session, 0)

      if (entry.last !== undefined) {
        const delta = used - entry.last
        // Add back what pruning removed; for fold detection also add back
        // unloaded tool-schema tokens (never counting schema unload as growth).
        const effective = delta + prunedSince
        const foldDelta = effective + unloadedToolsSince
        if (foldDelta <= -settings.dropTokens) {
          // A fold replaced history: the next fold is that far away again.
          entry.since = 0
          entry.band = 0
          entry.folded = true
        } else if (effective > 0) {
          entry.since += effective
        }
      }
      entry.last = used
      state.set(session, entry)

      // A fold notice wins over a growth reminder for the same step: the agent
      // needs to know its history changed before it is warned about the next one.
      if (entry.folded && settings.foldNotice) {
        entry.folded = false
        const text = settings.foldText.replaceAll('{note}', await newestNoteSuffix(settings.notesDir))
        return { ...decision, messages: [...decision.messages, noticeMessage(text, 'folded', step)] }
      }
      entry.folded = false

      const band = Math.floor(entry.since / settings.growthTokens)
      if (band === 0 || band <= entry.band) return decision
      entry.band = band

      const text = settings.text.replaceAll('{since}', String(entry.since))
      return { ...decision, messages: [...decision.messages, noticeMessage(text, 'reminder', step)] }
    } catch (error) {
      ctx.logger?.warn?.('context-reminder: %o', error)
      return decision
    }
  })
}

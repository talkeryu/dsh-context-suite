/**
 * Session digest — carry what happened into the *next* session.
 *
 * Codex writes durable memories by running a separate LLM over finished
 * rollouts. That needs judgment, and judgment is what a summarizer is for — but
 * the raw material has to exist first, and here it does not: a new session
 * starts with no idea what the previous one was about.
 *
 * This plugin keeps that material mechanically, with no model call. At every
 * `turn/end` it rewrites one small file describing the session so far — what the
 * user asked, in order, and which tools did the work. At the first step of a
 * turn it injects the newest digest belonging to a *different* session, so a
 * fresh window opens knowing where the last one stopped.
 *
 * Installed by `link:`, so only Node builtins are imported.
 *
 * @module @local/dsh-session-digest
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'session-digest'

/** Nothing is injected before the session has a surface to read. */
const SCAN_LIMIT = 2000

/**
 * Read the text of one message event.
 * @param session - the session.
 * @param event - a `user/message` event.
 * @returns the concatenated text, or an empty string.
 */
function messageText(session, event) {
  let message
  try {
    message = session.deriveEventMessage(event)
  } catch {
    return ''
  }
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Whether a user message is synthetic (injected by a plugin or the runtime).
 * @param event - the `user/message` event.
 * @returns true when the message was not typed by the user.
 */
export function isSynthetic(event) {
  // A `user/message` event's `data` *is* the message (see `deriveEventMessage`),
  // so the source sits at `data.source` — not `data.message.source`.
  const kind = event?.data?.source?.kind
  return typeof kind === 'string' && kind !== 'user' && kind !== 'repl'
}

/**
 * Build the digest for one session.
 * @param session - the session to describe.
 * @param maxUserChars - per-message truncation.
 * @param maxUsers - how many user messages to keep.
 * @returns the digest text.
 */
export function buildDigest(session, maxUserChars, maxUsers) {
  const nodes = session?.surface?.nodes
  if (nodes === undefined || nodes.length === 0) return undefined
  const users = []
  const tools = new Map()
  let turns = 0
  let steps = 0
  // `surface.nodes` holds only the five message-producing event types, so
  // `turn/end`, `step/end` and `tool/call` never appear there. Walk the seq
  // range the nodes span instead; `eventAt` returns the log event for any seq.
  const seqs = [...nodes].slice(-SCAN_LIMIT)
  // `session.seq` is the log's last seq; the last surface node can be well
  // before it (a turn ends after its final message).
  const last = typeof session.seq === 'number' ? session.seq : seqs[seqs.length - 1]
  const first = Math.max(seqs[0], last - SCAN_LIMIT * 4)
  for (let seq = first; seq <= last; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/end') turns += 1
    else if (event.type === 'step/end') steps += 1
    else if (event.type === 'tool/call') {
      const tool = event?.data?.name ?? event?.data?.toolName
      if (typeof tool === 'string') tools.set(tool, (tools.get(tool) ?? 0) + 1)
    } else if (event.type === 'user/message' && !isSynthetic(event)) {
      const text = messageText(session, event)
      if (text === '') continue
      const short = text.length > maxUserChars ? `${text.slice(0, maxUserChars)}…` : text
      users.push(`- (seq ${seq}) ${short}`)
    }
  }
  if (users.length === 0 && tools.size === 0) return undefined

  const top = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const lines = [
    `# session ${session.id ?? '?'} · ${new Date().toISOString().slice(0, 10)}`,
    `turns ${turns} · steps ${steps} · tool calls ${[...tools.values()].reduce((a, b) => a + b, 0)}`,
  ]
  if (top.length > 0) lines.push(`tools: ${top.map(([n, c]) => `${n}×${c}`).join(' · ')}`)
  if (users.length > 0) {
    lines.push('', '## what the user asked, in order')
    lines.push(...users.slice(-maxUsers))
  }
  return lines.join('\n')
}

/**
 * Register the digest writer and the cross-session injector.
 * @param ctx - the plugin context.
 * @param config - raw row configuration.
 */
export function apply(ctx, config) {
  const dir =
    typeof config?.dir === 'string' && config.dir !== ''
      ? config.dir.replace(/^~(?=\/|$)/, homedir())
      : join(homedir(), '.dsh', 'self-study', 'sessions')
  const maxUserChars = typeof config?.maxUserChars === 'number' ? config.maxUserChars : 160
  const maxUsers = typeof config?.maxUsers === 'number' ? config.maxUsers : 12
  const maxInjectChars = typeof config?.maxInjectChars === 'number' ? config.maxInjectChars : 1600

  let writing = false
  let pending = false

  /**
   * Rewrite this session's digest file.
   * @param session - the session to describe.
   */
  async function flush(session) {
    if (writing) {
      pending = true
      return
    }
    writing = true
    try {
      const digest = buildDigest(session, maxUserChars, maxUsers)
      if (digest === undefined) return
      await mkdir(dir, { recursive: true })
      const stamp = new Date().toISOString().slice(0, 10)
      const id = String(session.id ?? 'unknown').replace(/[^\w.-]/g, '_')
      await writeFile(join(dir, `${stamp}-${id}.md`), `${digest}\n`, 'utf8')
    } catch (error) {
      ctx.logger?.warn?.('session-digest: %o', error)
    } finally {
      writing = false
      if (pending) {
        pending = false
        void flush(session)
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    void flush(session)
  })

  /**
   * Find the newest digest written by a different session.
   *
   * Filenames are `YYYY-MM-DD-<sessionId>.md`, so same-day names sort by
   * session id, not by write time. Order by mtime instead: the digest the
   * user just finished is the one worth carrying forward.
   *
   * @param currentId - the id to exclude.
   * @returns the digest text, or undefined.
   */
  async function previousDigest(currentId) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      return undefined
    }
    const current = String(currentId ?? '').replace(/[^\w.-]/g, '_')
    const candidates = names.filter((n) => n.endsWith('.md') && !n.includes(current))
    const stamped = []
    for (const name of candidates) {
      try {
        stamped.push({ name, mtime: (await stat(join(dir, name))).mtimeMs })
      } catch {
        continue
      }
    }
    stamped.sort((a, b) => b.mtime - a.mtime)
    for (const { name } of stamped.slice(0, 3)) {
      try {
        const text = (await readFile(join(dir, name), 'utf8')).trim()
        if (text !== '') return text
      } catch {
        continue
      }
    }
    return undefined
  }

  /** Sessions that already received a digest. Bounded so a long-lived host
   * does not grow it without limit. */
  const injectedFor = new Set()
  const INJECT_LIMIT = 500

  function rememberSession(id) {
    injectedFor.add(id)
    if (injectedFor.size > INJECT_LIMIT) {
      const oldest = injectedFor.values().next().value
      injectedFor.delete(oldest)
    }
  }

  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || step !== 1) return decision
      const session = agent?.session
      if (session === undefined) return decision
      if (injectedFor.has(session.id)) return decision
      rememberSession(session.id)

      const text = await previousDigest(session.id)
      if (text === undefined) return decision
      const body = text.length > maxInjectChars ? `${text.slice(0, maxInjectChars)}…` : text
      const message = {
        id: `${session.id ?? 'session'}-digest`,
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '<previous_session>',
              'A mechanical digest of the most recent other session in this install. It is not a summary written by a model — it is what the user actually asked, in order, plus which tools ran. Use it to pick up context; read the matching note under `~/.dsh/notes/` for the reasoning.',
              body,
              '</previous_session>',
            ].join('\n'),
          },
        ],
        source: { kind: 'session-digest' },
      }
      return { ...decision, messages: [message, ...decision.messages] }
    } catch (error) {
      ctx.logger?.warn?.('session-digest: %o', error)
      return decision
    }
  })
}

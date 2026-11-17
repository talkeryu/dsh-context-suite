/**
 * Goal audit — put evidence in front of the model at the start of a goal round.
 *
 * A goal round opens with the same paragraph every time: "make concrete
 * progress". Codex asks the model to classify the previous round as progress,
 * a verified wait, or no progress — but the model has to remember what it did.
 * Here the previous round's evidence is computable, so compute it: how many
 * tool calls ran, which tools, which files were written, how many results
 * errored. A round that wrote nothing and errored twice is visible as such
 * before the model starts planning.
 *
 * The round message is identified by `source.kind === 'goal'`, the same marker
 * `dsh-goal-round-driver` uses to reserve a round, so this does not depend on
 * matching prompt text.
 *
 * Installed by `link:`, so only Node builtins are imported.
 *
 * @module @local/dsh-goal-audit
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'goal-audit'

/** How far back to look for the previous round's boundary. */
const SCAN_LIMIT = 4000

/**
 * Whether an event is a goal-round user message.
 * @param event - a session event.
 * @returns true when the event carries a goal round.
 */
function isGoalRound(event) {
  if (event?.type !== 'user/message') return false
  const source = event?.data?.source ?? event?.data?.message?.source
  return source?.kind === 'goal' && typeof source.round === 'number' && source.round > 0
}

/**
 * Extract file paths named by a write or edit call.
 * @param event - a `tool/call` event.
 * @returns the paths mentioned, possibly empty.
 */
function writtenPaths(event) {
  const raw = event?.data?.arguments ?? event?.data?.input
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (args === null || typeof args !== 'object') return []
  const out = []
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') out.push(value)
  }
  return out
}

/**
 * Summarize what happened between two surface positions.
 * @param session - the session.
 * @param nodes - the surface seq list.
 * @param fromIndex - index of the previous round's message.
 * @returns a rendered audit, or undefined when nothing ran.
 */
export function summarize(session, nodes, fromIndex, maxPaths, log) {
  const tools = new Map()
  const types = new Map()
  const files = new Set()
  let calls = 0
  let results = 0
  let errors = 0
  // `tool/call` is an event but not a surface node, so scan the seq range
  // between the two round boundaries rather than the surface list.
  const startSeq = nodes[fromIndex] ?? 0
  const endSeq = nodes[nodes.length - 1] ?? startSeq
  for (let seq = startSeq + 1; seq <= endSeq; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) { types.set('undefined', (types.get('undefined') ?? 0) + 1); continue }
    types.set(event.type, (types.get(event.type) ?? 0) + 1)
    if (event.type === 'tool/call') {
      calls += 1
      const tool = event?.data?.name ?? event?.data?.toolName
      if (typeof tool === 'string') {
        tools.set(tool, (tools.get(tool) ?? 0) + 1)
        if (tool === 'write' || tool === 'edit') {
          for (const path of writtenPaths(event)) files.add(path)
        }
      }
    } else if (event.type === 'tool/result') {
      // A background job's result can land in a later round than its call, so
      // results are activity in their own right: counting only calls reports
      // "nothing ran" for a round that actually received work.
      results += 1
      if (event?.data?.isError === true) errors += 1
    }
  }
  log?.(`summarize calls=${calls} results=${results} errors=${errors} span=${endSeq - startSeq} types=${[...types].map(([k, v]) => `${k}x${v}`).join(' ')}`)
  if (calls === 0 && results === 0 && errors === 0) {
    // An idle round is the most important thing to report, not a reason to
    // stay silent: the model must see that the previous round changed nothing.
    return 'Previous round: no tool calls, no tool results.'
  }

  const top = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  const lines = [`Previous round: ${calls} tool call${calls === 1 ? '' : 's'}, ${results} tool result${results === 1 ? '' : 's'}, ${errors} error${errors === 1 ? '' : 's'}.`]
  if (top.length > 0) lines.push(`Tools: ${top.map(([n, c]) => `${n}×${c}`).join(' · ')}`)
  if (files.size > 0) {
    const list = [...files].slice(0, maxPaths)
    lines.push(`Files written: ${list.join(', ')}${files.size > list.length ? ` (+${files.size - list.length} more)` : ''}`)
  } else {
    lines.push('Files written: none')
  }
  return lines.join('\n')
}

/**
 * Register the audit on the agent step waterfall.
 * @param ctx - the plugin context.
 * @param config - raw row configuration.
 */
export const inject = ['agents']

export function apply(ctx, config) {
  const maxPaths = typeof config?.maxPaths === 'number' && config.maxPaths > 0 ? config.maxPaths : 8

  const sink = config?.debug === true
    ? (typeof config?.debugPath === 'string' && config.debugPath !== ''
        ? config.debugPath
        : join(tmpdir(), 'goal-audit.log'))
    : null

  function dbg(line) {
    if (sink === null) return
    try {
      appendFileSync(sink, `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }

  dbg('apply')

  /** Rounds already audited, keyed by agent. Bounded so a long-lived host
   * does not grow it without limit. */
  const audited = new Set()
  const AUDIT_LIMIT = 500

  function remember(key) {
    audited.add(key)
    if (audited.size > AUDIT_LIMIT) {
      const oldest = audited.values().next().value
      audited.delete(oldest)
    }
  }

  /**
   * Build the audit for the round that just ended and hand it to the agent.
   * @param agent - the agent whose round just ended.
   * @param round - the round number that is about to start.
   */
  function audit(agent, round) {
    const key = `${agent?.id ?? '?'}:${round}`
    if (audited.has(key)) return
    remember(key)
    try {
      const session = agent?.session
      const nodes = session?.surface?.nodes
      if (nodes === undefined) { dbg('audit: no nodes'); return }
      const recent = [...nodes].slice(-SCAN_LIMIT)
      // The newest goal message is this round's own prompt; the one before it
      // opens the round that just ended.
      const goalIndices = []
      for (let i = recent.length - 1; i >= 0 && goalIndices.length < 2; i -= 1) {
        if (isGoalRound(session.eventAt(recent[i]))) goalIndices.push(i)
      }
      if (goalIndices.length < 2) { dbg(`audit: ${goalIndices.length} goal rounds in ${recent.length} nodes`); return }
      const boundary = goalIndices[1]
      dbg(`audit boundary=${boundary} of ${recent.length} goalIdx=${goalIndices.join(',')}`)
      const body = summarize(session, recent, boundary, maxPaths, dbg)
      if (body === undefined) { dbg('audit: empty body'); return }
      const text = [
        '<goal_round_audit>',
        body,
        '',
        'Classify that round before planning this one: progress (authoritative state changed, work completed, or evidence that changes the next action), a verified wait (a specific live handle was polled), or no progress. If it was no progress, the next action must change state — not restate the plan. If the same genuine blocker has persisted, say so concretely rather than starting a parallel line of work.',
        '</goal_round_audit>',
      ].join('\n')
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'goal-audit', round },
      }
      dbg(`inject round=${round}`)
      agent.inject(message)
    } catch (error) {
      ctx.logger?.warn?.('goal-audit: %o', error)
    }
  }

  let seen = 0
  ctx.on('session/event', (session, event) => {
    if (seen < 400) {
      seen += 1
      dbg(`ev ${event?.type} keys=${Object.keys(event?.data ?? {}).join(",")}`)
    }
    if (event?.type !== 'user/message') return
    // The event data IS the message (content/source/role/id), not { message }.
    const source = event?.data?.source ?? event?.data?.message?.source
    let agent
    try {
      agent = ctx.agents?.get(session.id)
    } catch (error) {
      dbg(`agents lookup threw: ${error?.message ?? error}`)
      return
    }
    dbg(`user msg kind=${source?.kind} round=${source?.round ?? '-'} agent=${agent?.id ?? 'none'}`)
    if (source?.kind !== 'goal') return
    if (typeof source.round !== 'number' || source.round <= 1) return
    if (agent === undefined) return
    // Let the append settle before adding to the inbox.
    queueMicrotask(() => audit(agent, source.round))
  })
}

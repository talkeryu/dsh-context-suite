/**
 * lazy-tools — hide large MCP tool groups behind one loader tool.
 *
 * Why: every registered tool contributes its full JSON Schema to every
 * request. A 255-tool MCP server costs ~88k tokens per request even when
 * the session never calls one of them. This plugin denies those tools for
 * the agent and exposes a single `load_tools` meta-tool that lifts the
 * denial on demand.
 *
 * State is per agent and per group:
 *   - absent: not yet restricted (or tools / scoped context not ready — retried)
 *   - `{ status: 'hidden', names, dispose }`: currently denied on `agent.ctx.tools`
 *   - `{ status: 'revealed' }`: explicitly unlocked by this agent; `pre-step` leaves it visible
 *
 * Only node: builtins are imported: a bundle installed by `link:` resolves
 * imports from its real checkout path, not from the profile's node_modules,
 * so `@deepseek-ai/*` would fail to resolve.
 */

const DEFAULTS = { toolName: 'load_tools', groups: [] }

export const name = 'lazy-tools'
export const inject = ['tools']

export function apply(ctx, config) {
  const toolName = typeof config?.toolName === 'string' && config.toolName ? config.toolName : DEFAULTS.toolName
  const groups = (Array.isArray(config?.groups) ? config.groups : DEFAULTS.groups)
    .filter((g) => g && typeof g.id === 'string' && typeof g.prefix === 'string' && g.id && g.prefix)
  if (groups.length === 0) return

  /** agentKey -> Map<groupId, { status: 'hidden', names: string[], dispose: () => void } | { status: 'revealed' }> */
  const state = new Map()
  /** sessionId -> agent, used to hide newly registered MCP tools at `turn/start` before `tools.resolve()`. */
  const bySession = new Map()

  /**
   * Read `agent.ctx.tools` safely.
   * Two production invariants in DSH:
   *   1. Reading an un-injected property on a Cordis fiber context throws.
   *   2. `ctx.tools.restrict()` on the root context throws (`requires a scoped context (agent.ctx)`).
   * So restriction MUST run on `agent.ctx.tools`; when it is unavailable, wait and retry.
   */
  const scopedTools = (agent) => {
    try {
      const svc = agent?.ctx?.tools
      return svc && typeof svc.restrict === 'function' ? svc : undefined
    } catch {
      return undefined
    }
  }

  const visibleNames = (agent) => {
    const agentTools = scopedTools(agent)
    const services = agentTools && agentTools !== ctx.tools ? [agentTools, ctx.tools] : [ctx.tools]
    const scope = (() => {
      try { return agent?.ctx ?? ctx } catch { return ctx }
    })()
    for (const svc of services) {
      if (!svc) continue
      for (const fn of ['schemas', 'definitions']) {
        if (typeof svc[fn] !== 'function') continue
        try {
          const rows = svc[fn](scope)
          if (Array.isArray(rows) && rows.length > 0) {
            return rows.map((r) => r?.name).filter((n) => typeof n === 'string')
          }
        } catch {
          /* try the next accessor */
        }
      }
    }
    return []
  }

  const agentKey = (agent) => String(agent?.id ?? agent?.sessionId ?? agent?.session?.id ?? 'default')

  const trackAgent = (agent) => {
    if (agent === undefined) return
    lastAgent = agent
    const sid = agent?.session?.id ?? agent?.sessionId
    if (sid !== undefined) bySession.set(sid, agent)
  }

  const groupsFor = (key) => {
    let perAgent = state.get(key)
    if (perAgent === undefined) {
      perAgent = new Map()
      state.set(key, perAgent)
    }
    return perAgent
  }

  /**
   * Deny one group's tools on `agent.ctx.tools`.
   * Never falls back to root `ctx.tools.restrict()`, which throws in production DSH.
   */
  const hideGroup = (agent, group, { force = false } = {}) => {
    const key = agentKey(agent)
    const existing = state.get(key)?.get(group.id)
    if (existing?.status === 'hidden') {
      return { kind: 'already-hidden', count: existing.names.length }
    }
    if (!force && existing?.status === 'revealed') {
      return { kind: 'skipped', count: 0 }
    }

    const toolsSvc = scopedTools(agent)
    if (toolsSvc === undefined) return { kind: 'not-registered', count: 0 }

    const names = visibleNames(agent)
    if (names.length === 0) return { kind: 'not-registered', count: 0 }
    const deny = names.filter((n) => n.startsWith(group.prefix))
    if (deny.length === 0) return { kind: 'not-registered', count: 0 }

    try {
      const dispose = toolsSvc.restrict({ deny })
      groupsFor(key).set(group.id, { status: 'hidden', names: deny, dispose })
      return { kind: 'hid', count: deny.length }
    } catch (error) {
      ctx.logger?.warn?.(`lazy-tools: could not restrict ${deny.length} tools: ${error?.message ?? error}`)
      return { kind: 'error', count: 0 }
    }
  }

  /** Auto-hide every uninitialized group for this agent. */
  const hideAll = (agent) => {
    for (const group of groups) hideGroup(agent, group)
  }

  /** Lift the denial on one group for one agent and latch it open across future steps. */
  const revealGroup = (agent, group) => {
    const key = agentKey(agent)
    const existing = state.get(key)?.get(group.id)
    if (existing?.status === 'hidden') {
      existing.dispose()
      groupsFor(key).set(group.id, { status: 'revealed' })
      return { kind: 'revealed', count: existing.names.length }
    }
    if (existing?.status === 'revealed') {
      return { kind: 'already-visible', count: 0 }
    }
    const matching = visibleNames(agent).filter((n) => n.startsWith(group.prefix))
    if (matching.length > 0) {
      groupsFor(key).set(group.id, { status: 'revealed' })
      return { kind: 'already-visible', count: matching.length }
    }
    return { kind: 'not-registered', count: 0 }
  }

  let lastAgent

  // 1. Hide at agent creation when MCP tools are already registered.
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent !== undefined) {
      trackAgent(agent)
      hideAll(agent)
    }
  })

  // 2. Cold-start catch-up: if `agent/created` fired before MCP finished its
  // handshake, `turn/start` fires synchronously at the top of `Agent.turn()`
  // BEFORE `preStep()` calls `tools.resolve()` for Step 1.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start' || session?.id === undefined) return
    const agent = bySession.get(session.id)
    if (agent !== undefined) hideAll(agent)
  })

  // 3. Reclaim per-agent state when subagents or sessions dispose.
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    state.delete(agentKey(agent))
    const sid = agent?.session?.id ?? agent?.sessionId
    if (sid !== undefined && bySession.get(sid) === agent) bySession.delete(sid)
    if (lastAgent === agent) lastAgent = undefined
  })

  // 4. Fallback on `pre-step` if an MCP server registered mid-turn.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload?.agent
    if (agent !== undefined) {
      trackAgent(agent)
      hideAll(agent)
    }
    return decision
  })

  const groupLines = groups.map((g) => `- "${g.id}": ${g.description ?? g.prefix}`).join('\n')

  ctx.tools.register({
    name: toolName,
    description:
      'Reveal a hidden group of tools. Some tool groups are hidden to save context; '
      + 'their schemas are not loaded until you ask for them. Call this once when a task needs one; '
      + 'pass hide:true to put the group back and reclaim the tokens.\n'
      + groupLines,
    parameters: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          enum: groups.map((g) => g.id),
          description: 'Which group to act on.',
        },
        hide: {
          type: 'boolean',
          description: 'Pass true to hide the group again and reclaim its schema tokens.',
        },
      },
      required: ['group'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const wanted = String(args?.group ?? '')
      const group = groups.find((g) => g.id === wanted)
      if (group === undefined) {
        return `Unknown group "${wanted}". Available: ${groups.map((g) => g.id).join(', ')}.`
      }
      // `exec.agent` is the caller; `lastAgent` is only a fallback for hosts
      // that do not pass a run context.
      const agent = exec?.agent ?? lastAgent
      if (agent === undefined) return `No agent scope captured yet; cannot act on "${group.id}".`

      if (args?.hide === true) {
        const res = hideGroup(agent, group, { force: true })
        if (res.kind === 'hid') {
          return `Hid ${res.count} tools from group "${group.id}". Their schemas stop costing context from the next step onward.`
        }
        if (res.kind === 'already-hidden') {
          return `Group "${group.id}" is already hidden (${res.count} tools).`
        }
        return `Group "${group.id}" has no registered tools to hide yet.`
      }

      const res = revealGroup(agent, group)
      if (res.kind === 'revealed') {
        return `Revealed ${res.count} tools from group "${group.id}". They are visible from the next step onward.`
      }
      if (res.kind === 'already-visible') {
        return `Group "${group.id}" is already visible.`
      }
      return `Group "${group.id}" is not registered yet. If the server is still starting, call this again on a later step.`
    },
  })
}

/**
 * Skill catalog guard — put the skill list back after a fold removes it.
 *
 * `dsh-tool-skill` injects the catalog once, at the session's first
 * `agent/pre-step`, and re-injects only when the catalog *digest* changes. The
 * digest is computed from session events (`catalogHistory`), not from the
 * visible surface, so a fold that swallows the catalog leaves the model with no
 * skill list and no trigger to bring it back. Measured in this session: the
 * catalog text appears exactly once (seq 20) across 19 folds.
 *
 * This plugin scans the visible surface for the catalog marker and, when it is
 * gone, injects a compact replacement built from the same `ctx.skills`
 * snapshot the real catalog uses — so bundled, project and user skills all
 * appear, not just the ones under `~/.dsh/skills`.
 *
 * Installed by `link:`, so only Node builtins are imported.
 *
 * @module @local/dsh-skill-catalog-guard
 */
import { randomUUID } from 'node:crypto'

export const name = 'skill-catalog-guard'

/** The `ctx.skills` registry and the working-directory resolver. */
export const inject = ['skills', 'workingDirectory']

/** Text that only the skill catalog carries. */
const MARKER = 'A skill is a reusable set of task-specific instructions'

/** How far back to scan the surface for the marker. */
const SCAN_LIMIT = 400

/**
 * Whether the visible surface still carries a skill catalog.
 * @param session - the agent's session.
 * @returns true when the marker is still visible.
 */
function catalogVisible(session) {
  const nodes = session?.surface?.nodes
  if (nodes === undefined) return true
  for (const seq of [...nodes].slice(-SCAN_LIMIT)) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    let message
    try {
      message = session.deriveEventMessage(event)
    } catch {
      continue
    }
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.includes(MARKER)) return true
    }
  }
  return false
}

/**
 * Whether a message list already carries a skill catalog.
 * On the first step of a session `dsh-tool-skill` places its catalog in
 * `decision.messages` before that message is committed to `surface.nodes`;
 * checking both avoids injecting a duplicate catalog on step 1.
 * @param messages - incremental step messages.
 * @returns true when a catalog message is already queued for this step.
 */
function catalogQueued(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    const kind = message?.source?.kind
    if (kind === 'skill-catalog' || kind === 'skill-catalog-guard') return true
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.includes(MARKER)) return true
    }
  }
  return false
}

/**
 * Render the replacement catalog.
 * @param skills - skills from the registry snapshot.
 * @param maxDescriptionChars - per-skill description budget.
 * @returns the catalog text.
 */
export function render(skills, maxDescriptionChars, complete = true) {
  const lines = []
  for (const skill of skills) {
    if (typeof skill?.name !== 'string' || skill.name === '') continue
    // `dsh-tool-skill` advertises only model-invocable skills; a skill marked
    // "explicit invocation only" must not appear in the catalog.
    if (skill.invocation?.modelInvocable === false || skill.modelInvocable === false) continue
    const first = typeof skill.description === 'string' ? skill.description.split('\n')[0].trim() : ''
    if (first === '') {
      lines.push(`- \`${skill.name}\``)
      continue
    }
    const short = first.length > maxDescriptionChars ? `${first.slice(0, maxDescriptionChars)}…` : first
    lines.push(`- \`${skill.name}\`: ${short}`)
  }
  if (lines.length === 0) return undefined
  return [
    '<available_skills>',
    'A skill is a reusable set of task-specific instructions. This catalog was re-injected because a fold removed the original one. Call `skill({name})` to load a skill.',
    ...(complete ? [] : ['(This listing may be incomplete: some skill sources could not be read.)']),
    ...lines,
    '</available_skills>',
  ].join('\n')
}

/**
 * Register the guard on the agent step waterfall.
 * @param ctx - the plugin context.
 * @param config - raw row configuration.
 */
export function apply(ctx, config) {
  const maxDescriptionChars =
    typeof config?.maxDescriptionChars === 'number' && config.maxDescriptionChars > 0
      ? config.maxDescriptionChars
      : 200

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter') return decision
      const session = agent?.session
      if (session === undefined || catalogQueued(decision.messages) || catalogVisible(session)) return decision

      const snapshot = await ctx.skills.snapshot({
        cwd: await ctx.workingDirectory.ensure(agent, signal),
        signal,
        scope: agent,
      })
      const text = render(snapshot?.skills ?? [], maxDescriptionChars, snapshot?.complete !== false)
      if (text === undefined) return decision

      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'skill-catalog-guard' },
      }
      return { ...decision, messages: [message, ...decision.messages] }
    } catch (error) {
      ctx.logger?.warn?.('skill-catalog-guard: %o', error)
      return decision
    }
  })
}

/**
 * Result budget — run DSH's own tool-result pruner on every step.
 *
 * `dsh-compaction-tool-result-pruner` is a real, tested implementation: it
 * replaces the middle of an over-budget tool result with a marker, keeps
 * `headChars` + `tailChars`, slices by Unicode code point, and records the
 * shadowed node so replay can recover the original. But it is only *called* by
 * `dsh-compaction-basic`, and billion-context sets that plugin to
 * `auto: false` — so in this profile the pruner is loaded and never invoked.
 * Measured: zero `compaction/prune` events in a 438-result session, and a
 * 20 KB `read` arrived intact.
 *
 * This plugin calls `pruneSession` once per step. It adds no policy of its own:
 * the budgets stay in the pruner's own row config.
 *
 * @module @local/dsh-result-budget
 */

export const name = 'result-budget'

/** The pruner service must be loaded before this plugin runs. */
export const inject = ['toolResultPruner', 'tokenMeter']

/**
 * Prune the agent's current surface before each step is assembled.
 * @param ctx - the plugin context.
 */
export function apply(ctx, config) {
  // 0 = prune on every step (the measured behaviour). Set a token count to
  // prune only once the session is under that much pressure, so a roomy
  // window keeps full tool output.
  const pressureThreshold =
    typeof config?.pressureThreshold === 'number' && config.pressureThreshold > 0
      ? config.pressureThreshold
      : 0

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    try {
      const session = agent?.session
      if (session === undefined) return decision
      if (pressureThreshold > 0) {
        let used
        try {
          const meter = ctx.tokenMeter
          used = meter?.contextPressure?.(session)?.pressureTokens
        } catch {
          used = undefined
        }
        if (typeof used === 'number' && used < pressureThreshold) return decision
      }
      const pruner = ctx.toolResultPruner
      pruner.pruneSession(session)
    } catch (error) {
      ctx.logger?.warn?.('result-budget: %o', error)
    }
    return decision
  })
}

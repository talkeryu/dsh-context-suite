/**
 * Sampling default — pin `temperature` for one provider's conversation calls.
 *
 * DSH never sends `temperature`. The agent loop builds the call config from the
 * session's model selection and `maxTokens` only, `llm-pi-ai` forwards
 * `options.temperature` when it is defined, and pi-ai writes it into the
 * request body — so with nothing set, the provider's own default wins. For a
 * local engine started with `--temperature 0.7`, that default is the only
 * sampling setting in play, and it cannot be changed without restarting the
 * engine.
 *
 * `agent/request` is the sanctioned place to replace sampling controls: it
 * receives the frozen call-config seed and may return a replacement, as long
 * as provider, model and the explicit reasoning effort survive. This plugin
 * returns the seed unchanged for every other provider, and adds `temperature`
 * only when the seed does not already carry one.
 *
 * @module @local/dsh-sampling-default
 */

export const name = 'sampling-default'

const DEFAULT_PROVIDER = 'local-ubuntu'
const DEFAULT_TEMPERATURE = 0.5

/**
 * Read one row configuration, tolerating absent or malformed fields.
 * @param config - the raw row configuration from the patch.
 * @returns the provider id and the temperature to pin.
 */
function resolveConfig(config) {
  const raw = config ?? {}
  const temperature = raw.temperature
  return {
    provider: typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : DEFAULT_PROVIDER,
    temperature: typeof temperature === 'number' && temperature >= 0 && temperature <= 2 ? temperature : DEFAULT_TEMPERATURE,
  }
}

/**
 * Pin the configured temperature on the matching provider's requests.
 * @param ctx - the plugin context.
 * @param config - the plugin config.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  ctx.on('agent/request', async (_payload, next) => {
    const seed = await next()
    if (!seed || seed.provider !== settings.provider) return seed
    if (seed.temperature !== undefined) return seed
    return { ...seed, temperature: settings.temperature }
  })
}

/**
 * Bundle entry point.
 *
 * The bundle's real work is done by the eight subpath modules named in
 * `cordis.patch.yml`; this module only exists so `import('dsh-context-suite')`
 * resolves. It registers nothing.
 *
 * @module dsh-context-suite
 */

export const name = 'dsh-context-suite'

export function apply() {}

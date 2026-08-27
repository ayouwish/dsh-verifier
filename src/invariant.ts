/**
 * Package-owned invariant companion for `@asyouwish/dsh-verifier`.
 * @module @asyouwish/dsh-verifier/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@asyouwish/dsh-verifier'

/** Cordis companion plugin name. */
export const name = 'verifier-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the pipeline is stateless per call (route resolution,
 * candidate fan-out, and selection), so this thin provider only reserves the
 * package name in the invariant registry.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

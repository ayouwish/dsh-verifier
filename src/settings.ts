/**
 * Verifier settings contract, shared between the host plugin (owns the section)
 * and the browser settings row that toggles auto-verification.
 * @module @deepseek-ai/dsh-verifier/settings
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace owning this plugin's persisted configuration. */
export const VERIFIER_SETTINGS_NAMESPACE = settingsNamespace('verifier')

/** Field controlling whether every agent final answer is auto-verified. */
export const AUTO_VERIFY_FIELD = 'autoVerify'

/** Persisted verifier settings section. */
export interface VerifierSettings {
  /** When true, every agent final answer runs best-of-n + verifier selection. */
  readonly autoVerify: boolean
}

/** Schema resolving the `verifier` settings section. */
export const VerifierSettingsSchema: z<VerifierSettings> = z.object({
  autoVerify: z.boolean().default(false),
})

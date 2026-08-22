/**
 * Auto-verification mode: when the persisted `verifier.autoVerify` setting is
 * on, every agent final answer is produced by the parallel-N + verifier-select
 * pipeline instead of the model's single pass. This wires the
 * `agent/verify-answer` hook (added to `@deepseek-ai/dsh-agent`) to the
 * verifier service, gated by the browser-toggleable setting.
 * @module @deepseek-ai/dsh-verifier/auto-verify
 */

// The `agent/verify-answer` waterfall event lives in `@deepseek-ai/dsh-agent`
// runtime-types and is dispatched by `@deepseek-ai/dsh-agent-loop`. Published
// `@deepseek-ai/dsh-agent@0.1.1-rc.2` does not declare it yet, so this
// standalone package supplies the event typing itself; the signature mirrors
// the upstream declaration. Remove this shim once an upstream release carries
// the event.
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Scoped } from '@deepseek-ai/dsh-scope'
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/verify-answer'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; candidate: string; signal: AbortSignal }, next: () => Promise<VerifyAnswerOutcome>): Promise<VerifyAnswerOutcome>
  }
}

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'

/** One verification waterfall outcome: keep the model's answer, or replace it. */
export type VerifyAnswerOutcome = { kind: 'unchanged' } | { kind: 'replaced'; text: string }

import { extractQuestion, resolveAgentRoute } from './session.ts'
import {
  VERIFIER_SETTINGS_NAMESPACE,
  VerifierSettingsSchema,
  type VerifierSettings,
} from './settings.ts'
import type { VerifierConfig } from './types.ts'

/**
 * Install the persisted `verifier` settings section and the `agent/verify-answer`
 * listener. When auto-verification is active, the listener replaces the agent's
 * final answer with the verified selection. No settings layer mounted, or the
 * toggle off, leaves the agent's own answer untouched.
 * @param ctx - registrant context carrying verifier/settings/agent services.
 * @param config - validated plugin configuration (seed for the settings base).
 */
export function installAutoVerify(ctx: Context, config: VerifierConfig): void {
  // The source thunk tracks the authoritative setting (settings scope when
  // mounted, composition entry otherwise). Resolution: schema default ->
  // composition base -> user settings layer.
  let source: () => VerifierSettings = () => ({ autoVerify: config.autoVerify === true })
  installSettingsSection(ctx, VERIFIER_SETTINGS_NAMESPACE, VerifierSettingsSchema, {
    autoVerify: config.autoVerify === true,
  }, {
    setSource: (current) => {
      source = current
    },
    onChange: () => {},
  })

  ctx.on('agent/verify-answer', async ({ agent, signal }, next) => {
    if (!source().autoVerify) return next()
    const question = extractQuestion(agent.session)
    if (question === undefined) return next()
    const route = resolveAgentRoute(agent)
    let result
    try {
      result = await ctx.verifier.verify({
        question,
        n: config.n,
        strategy: config.strategy,
        signal,
        ...(route !== undefined ? { route } : {}),
        sessionId: agent.session.id,
      })
    } catch {
      // Verification failure must never break the agent's own answer.
      return next()
    }
    const text = result.best.text
    return text.trim().length > 0 ? { kind: 'replaced', text } : next()
  })
}

/**
 * LLM-as-a-verifier plugin: verification mode.
 *
 * When enabled, this plugin registers the `ctx.verifier` service and the
 * model-facing `verify_answer` tool. The tool runs the user-requested mode:
 * generate `n` candidate answers **in parallel** (concurrent model calls),
 * then a verifier model pass selects the single most suitable candidate and
 * reports the verdict. Selection is either one-pass scoring (`score`) or a
 * pairwise knockout tournament (`tournament`).
 * @module @ayouwish/dsh-verifier
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_CANDIDATES, MAX_TIMER_DELAY_MS } from './pipeline.ts'
import { installAutoVerify } from './auto-verify.ts'
import { VerifierService } from './service.ts'
import type { ModelRoute, VerifierConfig, VerifyRequest } from './types.ts'

export * from './pipeline.ts'
export * from './prompts.ts'
export { VerifierService } from './service.ts'
export type * from './types.ts'

export const name = 'verifier'
export const inject = ['tools', 'llm']

/** Configuration schema; `provider`/`model` are optional and fall back to the calling session's route. */
export const Config: z<VerifierConfig> = z.object({
  n: z.number().step(1).min(1).max(MAX_CANDIDATES).required(),
  strategy: z.union(['score', 'tournament'] as const).required(),
  generation: z.union(['raw', 'subagent'] as const).default('raw'),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  enabled: z.boolean().required(),
  provider: z.string(),
  model: z.string(),
  subagentProvider: z.string(),
  autoVerify: z.boolean(),
})

/** Loader schema shared with config validation. */
export const VerifierConfigSchema: z<VerifierConfig> = Config

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'n',
  'strategy',
  'generation',
  'maxOutputTokens',
  'timeoutMs',
  'enabled',
  'provider',
  'model',
  'subagentProvider',
  'autoVerify',
])

/**
 * Validate and detach plugin configuration.
 * @param config - untrusted plugin configuration.
 * @returns immutable configuration.
 */
export function resolveVerifierConfig(config: VerifierConfig): VerifierConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('dsh-verifier: configuration is required')
  }
  const value = candidate as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-verifier: unknown config key "${key}"`)
  }
  const n = value.n
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CANDIDATES) {
    throw new Error(`dsh-verifier: n must be an integer in [1, ${MAX_CANDIDATES}]`)
  }
  const strategy = value.strategy
  if (strategy !== 'score' && strategy !== 'tournament') {
    throw new Error('dsh-verifier: strategy must be \'score\' or \'tournament\'')
  }
  const generationRaw = value.generation
  const generation = generationRaw === undefined ? 'raw' : generationRaw
  if (generation !== 'raw' && generation !== 'subagent') {
    throw new Error('dsh-verifier: generation must be \'raw\' or \'subagent\'')
  }
  const hasSubagentProvider = value.subagentProvider !== undefined
  if (hasSubagentProvider
    && (typeof value.subagentProvider !== 'string' || value.subagentProvider.length === 0)) {
    throw new Error('dsh-verifier: subagentProvider must be a non-empty string')
  }
  const maxOutputTokens = value.maxOutputTokens
  if (typeof maxOutputTokens !== 'number' || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error('dsh-verifier: maxOutputTokens must be a positive integer')
  }
  const timeoutMs = value.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-verifier: timeoutMs must be in [1, ${MAX_TIMER_DELAY_MS}]`)
  }
  const hasProvider = value.provider !== undefined
  const hasModel = value.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('dsh-verifier: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('dsh-verifier: provider and model overrides must be non-empty strings')
  }
  return Object.freeze({
    n,
    strategy,
    generation,
    maxOutputTokens,
    timeoutMs,
    enabled: value.enabled === true,
    autoVerify: value.autoVerify === true,
    ...(hasSubagentProvider ? { subagentProvider: value.subagentProvider as string } : {}),
    ...(hasProvider ? { provider: value.provider as string, model: value.model as string } : {}),
  })
}

/** Structural view of the agent the tool needs for route fallback. */
interface RouteAgent {
  session: {
    requestHeader(): { config: { provider: string; model: string } } | undefined
  }
}

/** Resolve the tool's route from config or the calling agent's session header. */
function toolRoute(config: VerifierConfig, agent: RouteAgent | undefined): ModelRoute | undefined {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const header = agent?.session.requestHeader()
  if (header !== undefined) {
    return { provider: header.config.provider, model: header.config.model }
  }
  return undefined
}

/**
 * Install the verifier service and, when verification mode is enabled, the
 * `verify_answer` tool.
 * @param ctx - registrant context carrying the tool and LLM services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: VerifierConfig): void {
  const resolved = resolveVerifierConfig(config)
  // Constructing the service registers `ctx.verifier` on this context.
  new VerifierService(ctx, resolved)
  // Register the persisted `verifier` settings section and the
  // `agent/verify-answer` auto-verification listener (opt-in via the toggle).
  installAutoVerify(ctx, resolved)
  if (!resolved.enabled) return
  ctx.tools.register(defineTool({
    name: 'verify_answer',
    description:
      'Verification mode: generate several candidate answers to a question in parallel '
      + 'and use a separate verifier model pass to select the single most suitable one. '
      + 'Use this when correctness matters and you want independent answers compared '
      + 'before committing to a final response. Pass the question (and optional context) '
      + 'and receive the selected best answer with the verifier\'s reasoning.',
    parameters: {
      question: { type: 'string', required: true, description: 'The question the candidates must answer.' },
      context: { type: 'string', description: 'Optional context that every candidate should consider.' },
      n: { type: 'integer', description: 'Number of parallel candidates; defaults to the configured value.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          best: { type: 'string', required: true },
          index: { type: 'integer', required: true },
          score: { type: 'number', required: true },
          reason: { type: 'string', required: true },
          candidates: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Verified answer (candidate ${value.index}, score ${value.score}):\n${value.best}`
          + (value.reason.length > 0 ? `\nVerifier: ${value.reason}` : ''),
      }],
    },
    execute(args, exec) {
      const route = toolRoute(resolved, exec.agent)
      const request: VerifyRequest = {
        question: args.question,
        ...(args.context !== undefined ? { context: args.context } : {}),
        ...(args.n !== undefined ? { n: args.n } : {}),
        ...(route !== undefined ? { route } : {}),
        signal: exec.signal,
        ...(exec.agent !== undefined ? { parent: exec.agent, sessionId: exec.agent.session.id } : {}),
      }
      return ctx.verifier.verify(request).then(result => ({
        best: result.best.text,
        index: result.verdict.index,
        score: result.verdict.score,
        reason: result.verdict.reason,
        candidates: result.candidates.map(candidate => candidate.text),
      }))
    },
  }))
}

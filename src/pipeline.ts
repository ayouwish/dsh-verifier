/**
 * Core LLM-as-a-verifier pipeline: N parallel candidate generations followed by
 * one verifier selection pass.
 *
 * Phase 1 (generate) fans out `n` independent {@link LlmRuntime.stream} calls
 * concurrently — each call carries the same question with a generator system
 * prompt and produces one candidate answer. Phase 2 (verify) runs a separate
 * verifier model call that either scores every candidate in one pass
 * (`score`) or compares candidates pairwise in a knockout bracket
 * (`tournament`) and returns the chosen winner.
 * @module @asyouwish/dsh-verifier/pipeline
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SubagentRun, SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  generatorSystemPrompt,
  generatorUserPrompt,
  verifierScoreSystemPrompt,
  verifierScoreUserPrompt,
  verifierTournamentSystemPrompt,
  verifierTournamentUserPrompt,
} from './prompts.ts'
import type {
  CandidateAnswer,
  ModelRoute,
  Verdict,
  VerifyRequest,
  VerifyResult,
  VerifierConfig,
  VerifierStrategy,
} from './types.ts'

/**
 * Telemetry marker for auxiliary verification calls. The published
 * `@deepseek-ai/dsh-llm` `GenerateOptions.purpose` union does not include
 * `'verifier'` yet (upstream adds it after 0.1.1-rc.2); a provider that sees
 * the unrecognized value treats it as unset, so the marker is safe to send.
 */
const VERIFIER_PURPOSE = 'verifier' as unknown as NonNullable<GenerateOptions['purpose']>

/** Capability-owned timeout reason code for auxiliary verifier requests. */
export const VERIFIER_TIMEOUT_CODE = 'VERIFIER_TIMEOUT'

/** Upper bound on parallel candidates, protecting deployments from unbounded fan-out. */
export const MAX_CANDIDATES = 8

/** Source plugin tag stamped on every auxiliary message. */
const SOURCE_PLUGIN = 'dsh-verifier'

/** Translate a terminal finish reason into a verifier-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('dsh-verifier: model output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('dsh-verifier: auxiliary model unexpectedly requested a tool')
    default:
      return new Error(`dsh-verifier: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Run one auxiliary model call and assemble its text blocks.
 * @param ctx - context exposing the registered LLM service.
 * @param options - frozen generate options for this auxiliary call.
 * @returns the assembled text output.
 */
async function streamText(ctx: Context, options: GenerateOptions): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    assembler.push(chunk)
  }
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('dsh-verifier: auxiliary output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  if (text.length === 0) throw new Error('dsh-verifier: auxiliary model produced no text')
  return text
}

/** Resolve the concrete route: explicit request route, then config pair. */
function resolveRoute(config: VerifierConfig, request: VerifyRequest): ModelRoute {
  if (request.route !== undefined) return request.route
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  throw new Error(
    'dsh-verifier: no model route available; pass request.route or configure provider and model together',
  )
}

/** Build the shared auxiliary call options for one phase-1 or phase-2 call. */
function buildOptions(
  config: VerifierConfig,
  route: ModelRoute,
  request: VerifyRequest,
  system: string,
  userText: string,
  signal: AbortSignal,
): GenerateOptions {
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: SOURCE_PLUGIN },
  })]
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    purpose: VERIFIER_PURPOSE,
    signal,
  }
  if (request.sessionId !== undefined) {
    options.sessionId = request.sessionId as NonNullable<GenerateOptions['sessionId']>
  }
  return deepFreeze(options)
}

/**
 * Phase 1: generate `n` candidate answers concurrently.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated plugin configuration.
 * @param request - the verification request.
 * @param route - the resolved model route.
 * @param signal - fused caller+deadline signal for this batch.
 * @returns the parallel candidates, in batch order.
 */
export async function generateCandidates(
  ctx: Context,
  config: VerifierConfig,
  request: VerifyRequest,
  route: ModelRoute,
  signal: AbortSignal,
): Promise<CandidateAnswer[]> {
  const count = clampCandidateCount(request.n ?? config.n)
  const jobs = Array.from({ length: count }, (_, index) => {
    const system = generatorSystemPrompt()
    const userText = generatorUserPrompt(request)
    const options = buildOptions(config, route, request, system, userText, signal)
    return streamText(ctx, options).then(text => ({ index, text }))
  })
  // Promise.all runs every stream concurrently — the user-requested fan-out.
  return Promise.all(jobs)
}

/** Default `ctx.subagents` provider name for subagent-backed generation. */
export const SUBAGENT_PROVIDER_DEFAULT = 'spawn'

/**
 * Phase 1 (`generation: 'subagent'`): spawn `n` parallel subagents, one
 * candidate each, and collect their final outputs. The calling agent
 * (`request.parent`) is required: the subagent seam derives workspace,
 * lineage, and delegation depth from its session.
 * @param ctx - context exposing the subagent runtime.
 * @param config - validated plugin configuration.
 * @param request - the verification request; `parent` must identify the caller.
 * @param route - the resolved model route handed to each child.
 * @param signal - fused caller+deadline signal for this batch.
 * @returns the parallel candidates, in batch order.
 */
export async function generateCandidatesBySubagent(
  ctx: Context,
  config: VerifierConfig,
  request: VerifyRequest,
  route: ModelRoute,
  signal: AbortSignal,
): Promise<CandidateAnswer[]> {
  const count = clampCandidateCount(request.n ?? config.n)
  const parent = request.parent
  if (parent === undefined) {
    throw new Error('dsh-verifier: generation "subagent" requires the calling agent (request.parent)')
  }
  const runtime = subagentRuntime(ctx)
  const game = `${generatorSystemPrompt()}\n\n${generatorUserPrompt(request)}`
  const provider = config.subagentProvider ?? SUBAGENT_PROVIDER_DEFAULT
  const jobs = Array.from({ length: count }, async (_, index) => {
    const start: SubagentStartRequest = {
      label: `verifier-candidate-${index + 1}`,
      prompt: [{ type: 'text', text: game }],
      parent,
      signal,
      agentOptions: { provider: route.provider, model: route.model },
    }
    const run = await runtime.start(provider, start)
    return { index, text: await candidateText(run, index) }
  })
  return Promise.all(jobs)
}

/** Resolve the live subagent runtime or fail loud when no provider is composed. */
function subagentRuntime(ctx: Context): SubagentRuntime {
  let runtime: SubagentRuntime | undefined
  try {
    runtime = ctx.subagents
  } catch {
    // Loader contexts (DSH web) do not inherit services that sibling loader
    // entries provide; the composed root carries them.
    runtime = undefined
  }
  if (runtime === undefined && ctx.root !== undefined) {
    try {
      runtime = ctx.root.subagents
    } catch {
      runtime = undefined
    }
  }
  if (runtime === undefined) {
    throw new Error(
      'dsh-verifier: generation "subagent" requires a loaded subagent provider '
      + '(compose a plugin providing ctx.subagents, e.g. an in-process driver)',
    )
  }
  return runtime
}

/** Extract a subagent run's final text, or fail the candidate loudly. */
async function candidateText(run: SubagentRun, index: number): Promise<string> {
  const result = await run.result
  await run.dispose().catch(() => {})
  if (result.stopReason !== 'completed') {
    const detail = result.diagnostic === undefined
      ? result.stopReason
      : `${result.stopReason}: ${result.diagnostic}`
    throw new Error(`dsh-verifier: subagent candidate ${index} failed (${detail})`)
  }
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  if (text.trim().length === 0) {
    throw new Error(`dsh-verifier: subagent candidate ${index} returned no text`)
  }
  return text
}

/** Clamp the candidate count to [1, MAX_CANDIDATES]. */
function clampCandidateCount(n: number): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`dsh-verifier: candidate count must be a positive integer, got ${n}`)
  }
  return Math.min(n, MAX_CANDIDATES)
}

/** Extract the first JSON object from model output (tolerates code fences/prose). */
function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`dsh-verifier: verifier returned no JSON object: ${JSON.stringify(text)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    throw new Error(`dsh-verifier: verifier JSON parse failed: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('dsh-verifier: verifier JSON must be an object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Phase 2 (`score` strategy): one verifier call scores every candidate and
 * returns the best index.
 */
export async function selectBestByScore(
  ctx: Context,
  config: VerifierConfig,
  request: VerifyRequest,
  route: ModelRoute,
  candidates: readonly CandidateAnswer[],
  signal: AbortSignal,
): Promise<Verdict> {
  const system = verifierScoreSystemPrompt()
  const userText = verifierScoreUserPrompt(request, candidates)
  const options = buildOptions(config, route, request, system, userText, signal)
  const raw = await streamText(ctx, options)
  const parsed = extractJsonObject(raw)
  const index = parsed.index
  const score = parsed.score
  const reason = parsed.reason
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new Error(`dsh-verifier: verifier index must be an integer, got ${JSON.stringify(index)}`)
  }
  if (index < 0 || index >= candidates.length) {
    throw new Error(`dsh-verifier: verifier index ${index} out of range for ${candidates.length} candidates`)
  }
  const scoreValue = typeof score === 'number' && Number.isFinite(score) ? clamp01(score) : 1
  const reasonText = typeof reason === 'string' && reason.length > 0 ? reason : ''
  return { index, score: scoreValue, reason: reasonText }
}

/** Clamp a verifier confidence to [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Phase 2 (`tournament` strategy): knockout bracket of pairwise comparisons.
 * Each comparison is its own verifier call; the survivor of `n - 1` matches is
 * the selected best.
 */
export async function selectBestByTournament(
  ctx: Context,
  config: VerifierConfig,
  request: VerifyRequest,
  route: ModelRoute,
  candidates: readonly CandidateAnswer[],
  signal: AbortSignal,
): Promise<Verdict> {
  if (candidates.length === 0) throw new Error('dsh-verifier: tournament requires at least one candidate')
  let bestIndex = 0
  let lastReason = ''
  for (let i = 1; i < candidates.length; i++) {
    const best = candidates[bestIndex]
    const challenger = candidates[i]
    if (best === undefined || challenger === undefined) {
      throw new Error('dsh-verifier: tournament candidate missing at index')
    }
    const system = verifierTournamentSystemPrompt()
    const userText = verifierTournamentUserPrompt(request, best, challenger)
    const options = buildOptions(config, route, request, system, userText, signal)
    const raw = await streamText(ctx, options)
    const parsed = extractJsonObject(raw)
    const winner = parsed.winner
    if (winner !== 'A' && winner !== 'B') {
      throw new Error(`dsh-verifier: tournament winner must be "A" or "B", got ${JSON.stringify(winner)}`)
    }
    const reason = typeof parsed.reason === 'string' ? parsed.reason : ''
    if (winner === 'B') {
      bestIndex = i
      lastReason = reason
    } else {
      lastReason = reason
    }
  }
  return { index: bestIndex, score: 1, reason: lastReason }
}

/** Resolve the effective selection strategy for one request. */
function resolveStrategy(config: VerifierConfig, request: VerifyRequest): VerifierStrategy {
  const requested: unknown = request.strategy ?? config.strategy
  if (requested !== 'score' && requested !== 'tournament') {
    throw new Error(`dsh-verifier: unknown strategy "${String(requested)}"`)
  }
  return requested
}/**
 * Run the full verification pipeline: resolve the route, generate candidates in
 * parallel, then select the best with the configured strategy.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated plugin configuration.
 * @param request - the verification request.
 * @returns the best candidate, the full batch, and the verifier's verdict.
 */
export async function runVerification(
  ctx: Context,
  config: VerifierConfig,
  request: VerifyRequest,
): Promise<VerifyResult> {
  request.signal?.throwIfAborted()
  const route = resolveRoute(config, request)
  const strategy = resolveStrategy(config, request)
  using callDeadline = deadline(request.signal, config.timeoutMs, VERIFIER_TIMEOUT_CODE)
  const signal = callDeadline.signal
  signal.throwIfAborted()
  const candidates = config.generation === 'subagent'
    ? await generateCandidatesBySubagent(ctx, config, request, route, signal)
    : await generateCandidates(ctx, config, request, route, signal)
  signal.throwIfAborted()
  const verdict = strategy === 'tournament'
    ? await selectBestByTournament(ctx, config, request, route, candidates, signal)
    : await selectBestByScore(ctx, config, request, route, candidates, signal)
  const best = candidates[verdict.index]
  if (best === undefined) {
    throw new Error(`dsh-verifier: verifier selected missing candidate index ${verdict.index}`)
  }
  return { best, candidates, verdict, route }
}

/** Re-export the deadline ceiling for config validation. */
export { MAX_TIMER_DELAY_MS }

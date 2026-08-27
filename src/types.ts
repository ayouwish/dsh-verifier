/**
 * Shared types for the LLM-as-a-verifier pipeline.
 * @module @asyouwish/dsh-verifier/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** How candidate answers are produced. */
export type GenerationSource = 'raw' | 'subagent'

/** How the verifier LLM selects the best candidate. */
export type VerifierStrategy = 'score' | 'tournament'

/** One parallel-generated candidate answer. */
export interface CandidateAnswer {
  /** 0-based position in the parallel batch. */
  readonly index: number
  /** Assembled answer text. */
  readonly text: string
}

/** The verifier's selection verdict. */
export interface Verdict {
  /** 0-based index of the selected best candidate. */
  readonly index: number
  /** 0..1 confidence the verifier assigned to the selection. */
  readonly score: number
  /** Verifier's one-sentence justification. */
  readonly reason: string
}

/** Complete verification result. */
export interface VerifyResult {
  /** The selected best candidate. */
  readonly best: CandidateAnswer
  /** All parallel-generated candidates in batch order. */
  readonly candidates: readonly CandidateAnswer[]
  /** Verifier's selection verdict. */
  readonly verdict: Verdict
  /** The model route the verifier pass used. */
  readonly route: ModelRoute
}

/** A concrete provider/model pair. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** Inputs to one verification run. */
export interface VerifyRequest {
  /** The question every candidate must answer. */
  readonly question: string
  /** Optional extra context framed into both generation and verification prompts. */
  readonly context?: string
  /** Number of parallel candidates; defaults to the plugin's configured `n`. */
  readonly n?: number
  /** Selection strategy override; defaults to the plugin's configured strategy. */
  readonly strategy?: VerifierStrategy
  /** Explicit model route; falls back to config, then the calling agent's session header. */
  readonly route?: ModelRoute
  /** Abort signal fused with the per-call deadline. */
  readonly signal?: AbortSignal
  /** Session identity stamped on auxiliary calls for replay and routing. */
  readonly sessionId?: string
  /** The calling agent; required when generation is `subagent` to spawn child agents. */
  readonly parent?: Agent
}

/** Plugin configuration. */
export interface VerifierConfig {
  /** Number of parallel candidates per verification run. */
  readonly n: number
  /** Default selection strategy. */
  readonly strategy: VerifierStrategy
  /** How candidates are produced: raw parallel model calls, or parallel subagents. */
  readonly generation: GenerationSource
  /** Output-token cap for each generation and verification call. */
  readonly maxOutputTokens: number
  /** End-to-end deadline for each auxiliary model call, in milliseconds. */
  readonly timeoutMs: number
  /** Whether verification mode is enabled (registers the `verify_answer` tool). */
  readonly enabled: boolean
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
  /** `ctx.subagents` provider name for subagent generation (default `spawn`). */
  readonly subagentProvider?: string
  /** Optional: when true (default false), every agent final answer is auto-verified (best-of-n + selection). */
  readonly autoVerify?: boolean
}

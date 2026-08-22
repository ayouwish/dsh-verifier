import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

import * as verifierPlugin from '../src/index.ts'
import { generatorSystemPrompt, verifierScoreSystemPrompt } from '../src/prompts.ts'

const testToolSignal = new AbortController().signal

/** Fake parent Agent backed by a real Session, mirroring tool-todo's tests. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

interface CallRecord {
  options: GenerateOptions
  /** Concurrency depth observed while this call was streaming. */
  depth: number
}

/**
 * Adapter that tells generator calls from verifier calls by system prompt and
 * streams a per-role canned response. It also records concurrent depth to
 * prove phase-1 calls run in parallel.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly generatorTexts: string[]
  readonly verifierTexts: string[]
  readonly calls: CallRecord[] = []
  private active = 0
  private maxActive = 0
  private generatorCount = 0
  private verifierCount = 0

  constructor(generatorTexts: string[], verifierTexts: string[]) {
    super()
    this.generatorTexts = generatorTexts
    this.verifierTexts = verifierTexts
  }

  get peakConcurrency(): number {
    return this.maxActive
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    const isGenerator = options.system === generatorSystemPrompt()
    const ordinal = isGenerator ? this.generatorCount++ : this.verifierCount++
    this.calls.push({ options, depth: this.active })
    // Yield a microtask boundary so sibling calls can enter concurrently.
    await Promise.resolve()
    try {
      const text = isGenerator
        ? this.generatorTexts[ordinal] ?? ''
        : this.verifierTexts[ordinal] ?? ''
      if (text.length > 0) yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      this.active -= 1
    }
  }
}

async function setup(config: verifierPlugin.VerifierConfig): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(verifierPlugin, config)
  return ctx
}

const BASE_CONFIG = {
  n: 3,
  strategy: 'score' as const,
  maxOutputTokens: 512,
  timeoutMs: 30_000,
  enabled: true,
  provider: 'verifier-route',
  model: 'verifier-model',
}

describe('dsh-verifier service', () => {
  it('registers `ctx.verifier` and a `verify_answer` tool when enabled', async () => {
    const ctx = await setup({ ...BASE_CONFIG, n: 2 })
    expect(ctx.verifier).toBeDefined()
    const schema = ctx.tools.schemas().find(s => s.name === 'verify_answer')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['context', 'n', 'question'])
  })

  it('does not register the tool when `enabled` is false', async () => {
    const ctx = await setup({ ...BASE_CONFIG, enabled: false })
    expect(ctx.verifier).toBeDefined()
    expect(ctx.tools.schemas().find(s => s.name === 'verify_answer')).toBeUndefined()
  })

  it('generates N candidates concurrently and returns the verifier-selected best (score)', async () => {
    const ctx = await setup(BASE_CONFIG)
    const adapter = new ScriptedAdapter(
      ['candidate zero', 'candidate one', 'candidate two'],
      ['{"index": 1, "score": 0.95, "reason": "candidate one is the most complete"}'],
    )
    ctx.llm.registerAdapter(['verifier-route'], adapter)

    const result = await ctx.verifier.verify({ question: 'What is 2+2?' })

    // Phase 1: exactly n generator calls, observed in parallel (depth reaches 3).
    const generatorCalls = adapter.calls.filter(c => c.options.system === generatorSystemPrompt())
    expect(generatorCalls).toHaveLength(3)
    expect(adapter.peakConcurrency).toBe(3)
    // Phase 2: exactly one verifier call.
    const verifierCalls = adapter.calls.filter(c => c.options.system === verifierScoreSystemPrompt())
    expect(verifierCalls).toHaveLength(1)

    expect(result.candidates.map(c => c.text)).toEqual(['candidate zero', 'candidate one', 'candidate two'])
    expect(result.best.index).toBe(1)
    expect(result.best.text).toBe('candidate one')
    expect(result.verdict.index).toBe(1)
    expect(result.verdict.score).toBe(0.95)
    expect(result.verdict.reason).toContain('most complete')
    expect(result.route).toEqual({ provider: 'verifier-route', model: 'verifier-model' })
  })

  it('rejects a verifier index out of range', async () => {
    const ctx = await setup(BASE_CONFIG)
    const adapter = new ScriptedAdapter(
      ['a', 'b', 'c'],
      ['{"index": 7, "score": 0.9, "reason": "out of range"}'],
    )
    ctx.llm.registerAdapter(['verifier-route'], adapter)
    await expect(ctx.verifier.verify({ question: 'q' })).rejects.toThrow(/out of range/)
  })

  it('uses tournament pairwise comparison when strategy is tournament', async () => {
    const ctx = await setup({ ...BASE_CONFIG, strategy: 'tournament' })
    // 3 candidates => 2 comparisons: A vs B (B wins), then B vs C (C wins).
    const verifierTexts = [
      '{"winner": "B", "reason": "B is clearer"}',
      '{"winner": "B", "reason": "B beats C too"}',
    ]
    const adapter = new ScriptedAdapter(['a', 'b', 'c'], verifierTexts)
    ctx.llm.registerAdapter(['verifier-route'], adapter)

    const result = await ctx.verifier.verify({ question: 'q' })

    const tournamentCalls = adapter.calls.filter(c => c.options.system === verifierScoreSystemPrompt())
    expect(tournamentCalls).toHaveLength(0)
    const compareCalls = adapter.calls.filter(c => c.options.system?.startsWith('You are a strict verifier. You are given a question and two'))
    // 2 pairwise calls for 3 candidates.
    expect(compareCalls).toHaveLength(2)
    expect(result.best.index).toBe(2)
    expect(result.best.text).toBe('c')
    expect(result.verdict.index).toBe(2)
  })
})

describe('dsh-verifier verify_answer tool', () => {
  it('executes the pipeline through ctx.tools and returns the best candidate', async () => {
    const ctx = await setup({ ...BASE_CONFIG, n: 2 })
    const adapter = new ScriptedAdapter(
      ['first answer', 'second answer'],
      ['{"index": 0, "score": 0.8, "reason": "first is exact"}'],
    )
    ctx.llm.registerAdapter(['verifier-route'], adapter)
    const agent = agentWithSession('verifier-tool')

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('call-verify-1'),
      name: 'verify_answer',
      arguments: { question: 'Is the sky blue?' },
      agent,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected verify_answer success')
    expect(result.value).toMatchObject({
      best: 'first answer',
      index: 0,
      score: 0.8,
      candidates: ['first answer', 'second answer'],
    })
  })
})

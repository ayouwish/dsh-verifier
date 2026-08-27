// `generation: 'subagent'`: candidates are produced by parallel subagents
// (spawned through `ctx.subagents`) instead of raw model calls, then the
// verifier pass selects the best exactly as in raw mode.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'

import * as verifierPlugin from '../src/index.ts'
import { generatorSystemPrompt, generatorUserPrompt, verifierScoreSystemPrompt } from '../src/prompts.ts'

const BASE_CONFIG: verifierPlugin.VerifierConfig = {
  n: 3,
  strategy: 'score',
  generation: 'subagent',
  maxOutputTokens: 512,
  timeoutMs: 30_000,
  enabled: true,
  provider: 'mock',
  model: 'mock',
  autoVerify: false,
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Verifier-only adapter: generation must never reach `ctx.llm` in subagent mode. */
class VerifierOnlyAdapter extends LlmAdapter {
  readonly requests: string[] = []
  readonly verifierText: string

  constructor(verifierText: string) {
    super()
    this.verifierText = verifierText
  }

  override async * stream(options: { system?: string }): AsyncIterable<StreamChunk> {
    if (options.system !== verifierScoreSystemPrompt()) {
      throw new Error(`unexpected raw model call with system ${JSON.stringify(options.system)}`)
    }
    this.requests.push(options.system ?? '')
    for (const chunk of textResponse(this.verifierText)) yield chunk
  }
}

/** One spawned child: canned final text, counted starts, configurable name. */
class FakeSubagentProvider {
  readonly calls: {
    prompt: string
    agentOptions: { provider: string; model: string } | undefined
    toolFilter: { allow?: readonly string[]; deny?: readonly string[] } | undefined
  }[] = []
  readonly provider: SubagentProvider

  constructor(texts: string[], name = 'fake') {
    let ordinal = 0
    this.provider = {
      name,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        const index = ordinal++
        this.calls.push({
          prompt: request.prompt
            .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
            .map(block => block.text)
            .join(''),
          agentOptions: request.agentOptions,
          toolFilter: request.toolFilter,
        })
        const output: SubagentResult['output'] = [{ type: 'text', text: texts[index] ?? '' }]
        return {
          id: SessionId(`fake-${index + 1}`),
          localAgent: undefined,
          result: Promise.resolve<SubagentResult>({ output, stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    }
  }
}

async function harness(options: {
  fake: FakeSubagentProvider
  config?: verifierPlugin.VerifierConfig
  verifierText?: string
  withSubagent?: boolean
}): Promise<{ ctx: Context; adapter: VerifierOnlyAdapter; agent: Agent }> {
  const {
    fake,
    config = BASE_CONFIG,
    verifierText = '{"index": 1, "score": 0.9, "reason": "candidate one wins"}',
    withSubagent = true,
  } = options
  const adapter = new VerifierOnlyAdapter(verifierText)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (withSubagent) {
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(fake.provider)
  }
  await ctx.plugin(verifierPlugin, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('sg1'), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, agent }
}

describe('dsh-verifier subagent generation', () => {
  it('spawns one subagent per candidate, collects their outputs, and verifier-selects the best', async () => {
    const fake = new FakeSubagentProvider(['candidate zero', 'candidate one', 'candidate two'], 'spawn')
    const { ctx, adapter, agent } = await harness({ fake })
    try {
      const result = await ctx.verifier.verify({ question: 'Which answer is best?', parent: agent })

      expect(fake.calls).toHaveLength(3)
      expect(fake.calls.map(call => call.agentOptions)).toEqual([
        { provider: 'mock', model: 'mock' },
        { provider: 'mock', model: 'mock' },
        { provider: 'mock', model: 'mock' },
      ])
      // Every child receives the generator role and the question in its prompt.
      for (const call of fake.calls) {
        expect(call.prompt).toContain(generatorSystemPrompt())
        expect(call.prompt).toContain(generatorUserPrompt({ question: 'Which answer is best?' }))
      }
      // Generation never touched the LLM service; only the scorer did.
      expect(adapter.requests).toHaveLength(1)
      expect(result.best.text).toBe('candidate one')
      expect(result.verdict).toEqual({ index: 1, score: 0.9, reason: 'candidate one wins' })
      expect(result.candidates.map(candidate => candidate.text)).toEqual([
        'candidate zero',
        'candidate one',
        'candidate two',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the configured subagentProvider name instead of the default', async () => {
    const fake = new FakeSubagentProvider(['only'], 'custom')
    const { ctx, agent } = await harness({
      fake,
      config: { ...BASE_CONFIG, subagentProvider: 'custom' },
      verifierText: '{"index": 0, "score": 1, "reason": "only candidate"}',
    })
    try {
      const result = await ctx.verifier.verify({ question: 'q', n: 1, parent: agent })
      expect(fake.calls).toHaveLength(1)
      expect(result.best.text).toBe('only')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails loudly when the calling agent is missing', async () => {
    const fake = new FakeSubagentProvider(['x'])
    const { ctx } = await harness({ fake })
    try {
      await expect(ctx.verifier.verify({ question: 'q' }))
        .rejects.toThrow('requires the calling agent')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('inherits the composed tool scope by default (no toolFilter passed)', async () => {
    const fake = new FakeSubagentProvider(['one'])
    const { ctx } = await harness({
      fake,
      config: { ...BASE_CONFIG, subagentProvider: 'fake' },
      verifierText: '{"index": 0, "score": 1, "reason": "ok"}',
    })
    try {
      const result = await ctx.verifier.verify({ question: 'q', n: 1, parent: {} as Agent })
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0].toolFilter).toBeUndefined()
      expect(result.best.text).toBe('one')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hides global tools from candidates when subagentTools is false', async () => {
    const fake = new FakeSubagentProvider(['one'])
    const { ctx } = await harness({
      fake,
      config: { ...BASE_CONFIG, subagentProvider: 'fake', subagentTools: false },
      verifierText: '{"index": 0, "score": 1, "reason": "ok"}',
    })
    try {
      const result = await ctx.verifier.verify({ question: 'q', n: 1, parent: {} as Agent })
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0].toolFilter).toEqual({ allow: [] })
      expect(result.best.text).toBe('one')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails loudly when no subagent provider is composed', async () => {
    const fake = new FakeSubagentProvider(['x'])
    const { ctx } = await harness({ fake, withSubagent: false })
    try {
      await expect(ctx.verifier.verify({ question: 'q', parent: {} as Agent }))
        .rejects.toThrow('requires a loaded subagent provider')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an unknown generation value at configuration time', () => {
    expect(() => verifierPlugin.resolveVerifierConfig({
      ...BASE_CONFIG,
      generation: 'parallel' as verifierPlugin.GenerationSource,
    })).toThrow('generation must be \'raw\' or \'subagent\'')
  })

  it('defaults generation to raw when omitted', () => {
    const { generation, subagentProvider, ...rest } = BASE_CONFIG
    expect(verifierPlugin.resolveVerifierConfig(rest).generation).toBe('raw')
  })
})
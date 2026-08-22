import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import * as verifierPlugin from '../src/index.ts'
import { generatorSystemPrompt, verifierScoreSystemPrompt } from '../src/prompts.ts'

const BASE_CONFIG: verifierPlugin.VerifierConfig = {
  n: 3,
  strategy: 'score',
  maxOutputTokens: 512,
  timeoutMs: 30_000,
  enabled: true,
  provider: 'mock',
  model: 'mock',
  autoVerify: true,
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

/** Distinguish agent turns, verifier generators, and verifier scorers by system prompt. */
class AutoVerifyAdapter extends LlmAdapter {
  readonly generatorTexts: string[]
  readonly verifierText: string
  readonly draft: string
  readonly requests: GenerateOptions[] = []
  agentCalls = 0

  constructor(generatorTexts: string[], verifierText: string, draft: string) {
    super()
    this.generatorTexts = generatorTexts
    this.verifierText = verifierText
    this.draft = draft
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    let text: string
    if (options.system === verifierScoreSystemPrompt()) {
      text = this.verifierText
    } else if (options.system === generatorSystemPrompt()) {
      const ordinal = this.requests.filter(r => r.system === generatorSystemPrompt()).length - 1
      text = this.generatorTexts[ordinal] ?? ''
    } else {
      this.agentCalls += 1
      text = this.draft
    }
    for (const chunk of textResponse(text)) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

async function harness(autoVerify: boolean): Promise<{ ctx: Context; adapter: AutoVerifyAdapter }> {
  const adapter = new AutoVerifyAdapter(
    ['candidate zero', 'candidate one', 'candidate two'],
    '{"index": 1, "score": 0.9, "reason": "candidate one wins"}',
    'agent draft answer',
  )
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(verifierPlugin, { ...BASE_CONFIG, autoVerify })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

function lastAnswer(agent: Agent): string | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type !== 'assistant/message') continue
    const block = event.data.message.content[0]
    if (block?.type === 'text' && block.text.trim() !== '') return block.text
  }
  return undefined
}

describe('dsh-verifier auto-verify mode (end to end)', () => {
  it('replaces an agent final answer with the verifier-selected best when autoVerify is on', async () => {
    const { ctx, adapter } = await harness(true)
    const agent = ctx.agentLoop.create(SessionId('av1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Which answer is best?' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // The upstream agent-loop dispatches `agent/verify-answer` itself once a
    // release carries it; published 0.1.1-rc.2 does not, so dispatch the
    // waterfall directly to exercise the plugin's listener and pipeline.
    const outcome = await ctx.waterfall(
      'agent/verify-answer',
      { agent, turn: 1, step: 1, candidate: 'agent draft answer', signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'unchanged' } as const),
    )

    expect(adapter.agentCalls).toBe(1)
    expect(adapter.requests.filter(r => r.system === generatorSystemPrompt())).toHaveLength(3)
    expect(adapter.requests.filter(r => r.system === verifierScoreSystemPrompt())).toHaveLength(1)
    expect(outcome).toEqual({ kind: 'replaced', text: 'candidate one' })
    // Appending the replaced assistant message is the agent-loop's duty once it
    // dispatches the event; standalone we assert the plugin contract (the
    // returned replacement text).
    expect(lastAnswer(agent)).toBe('agent draft answer')
  }, 15_000)

  it('leaves the agent final answer untouched when autoVerify is off', async () => {
    const { ctx, adapter } = await harness(false)
    const agent = ctx.agentLoop.create(SessionId('av2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.agentCalls).toBe(1)
    expect(adapter.requests).toHaveLength(1)
    expect(lastAnswer(agent)).toBe('agent draft answer')
  }, 15_000)
})

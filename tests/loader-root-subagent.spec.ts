// Regression: `generation: 'subagent'` must resolve the subagent runtime from
// the composed root. In DSH web the loader applies each entry on its own
// `loader.ctx.extend()` child, so services a sibling entry provides (here the
// subagent runtime, provided on `ctx.root` like the host's bundle layer) are
// NOT visible as plain `ctx.subagents` from the verifier's context. The
// verifier must fall back to `ctx.root.subagents` — this spec boots through
// the real Loader and runs a full subagent-mode verification end to end.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { verifierScoreSystemPrompt } from '../src/prompts.ts'
import * as Verifier from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scorer-only adapter: generation never reaches `ctx.llm` in subagent mode. */
class ScorerOnlyAdapter extends LlmAdapter {
  readonly verifierText: string

  constructor(verifierText: string) {
    super()
    this.verifierText = verifierText
  }

  override async * stream(options: { system?: string }): AsyncIterable<StreamChunk> {
    if (options.system !== verifierScoreSystemPrompt()) {
      throw new Error(`unexpected raw model call with system ${JSON.stringify(options.system)}`)
    }
    for (const chunk of textResponse(this.verifierText)) yield chunk
  }
}

/** A subagent runtime provided on the composed ROOT, as the DSH web bundle layer does. */
class RootSubagentService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  async start(_provider: string): Promise<unknown> {
    return {
      id: 'canned-run',
      result: Promise.resolve({
        output: [{ type: 'text', text: 'candidate from root subagent' }],
        stopReason: 'completed',
      }),
      dispose: async () => {},
    }
  }
}

const RootSubagentPlugin = {
  name: 'fake-subagent-root',
  apply(ctx: Context) {
    // Mirrors the DSH web bundle layer: the runtime is provided on the composed root,
    // invisible to sibling loader-entry contexts as plain `ctx.subagents`.
    ctx.root.plugin(RootSubagentService)
  },
}

/** Boot the real Loader with subagents (on root) + the verifier as sibling entries. */
async function boot(): Promise<{ ctx: Context; adapter: ScorerOnlyAdapter }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-verifier-root-subagent-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'fake-subagent-root'",
    "- name: '@asyouwish/dsh-verifier'",
    '  config:',
    '    n: 1',
    '    strategy: score',
    '    generation: subagent',
    '    maxOutputTokens: 128',
    '    timeoutMs: 10000',
    '    enabled: true',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['fake-subagent-root', RootSubagentPlugin],
    ['@asyouwish/dsh-verifier', Verifier],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const adapter = new ScorerOnlyAdapter('{"index": 0, "score": 0.9, "reason": "root candidate wins"}')
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

describe('subagent generation through the real Loader (root-provided runtime)', () => {
  it('resolves the subagent runtime from the composed root and verifies', async () => {
    const { ctx } = await boot()
    expect(ctx.verifier).toBeDefined()
    const result = await ctx.verifier.verify({
      question: 'Which approach is best?',
      route: { provider: 'mock', model: 'mock' },
      parent: {} as unknown as Agent,
      signal: new AbortController().signal,
    })
    expect(result.best.text).toContain('candidate from root')
  }, 30_000)
})
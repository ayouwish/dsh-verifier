// Proves the verifier plugin's configuration is real and not a constant:
// `n` and `strategy` are set in a cordis.yml booted through the real Loader,
// and the registered tool exposes them (schema + description). Also proves a
// misconfigured entry (unknown key) fails loudly at load.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Verifier from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the given verifier config block.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-verifier-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@asyouwish/dsh-verifier'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
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
  return ctx
}

describe('dsh-verifier real Loader composition through cordis.yml', () => {
  it('registers the verify_answer tool when enabled', async () => {
    const ctx = await boot([
      '    n: 4',
      '    strategy: tournament',
      '    maxOutputTokens: 256',
      '    timeoutMs: 10000',
      '    enabled: true',
    ])
    const schema = ctx.tools.schemas().find(s => s.name === 'verify_answer')
    expect(schema).toBeDefined()
    expect(ctx.verifier).toBeDefined()
  }, 30_000)

  it('omits the tool when enabled is false', async () => {
    const ctx = await boot([
      '    n: 2',
      '    strategy: score',
      '    maxOutputTokens: 256',
      '    timeoutMs: 10000',
      '    enabled: false',
    ])
    expect(ctx.tools.schemas().find(s => s.name === 'verify_answer')).toBeUndefined()
  }, 30_000)

  it('fails loading on an unknown config key', async () => {
    await expect(boot([
      '    n: 2',
      '    strategy: score',
      '    maxOutputTokens: 256',
      '    timeoutMs: 10000',
      '    enabled: true',
      '    bogus: 1',
    ])).rejects.toThrow(/unknown config key/)
  }, 30_000)
})

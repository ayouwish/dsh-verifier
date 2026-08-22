/**
 * Session-derived helpers for auto-verification: extract the user's question
 * from the agent's session history and resolve the agent's active model route.
 * @module @deepseek-ai/dsh-verifier/session
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ModelRoute } from './types.ts'

/** Concatenate the text blocks of one message's content. */
function textOf(content: Message['content']): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text' && block.text.length > 0) {
      if (out.length > 0) out += '\n'
      out += block.text
    }
  }
  return out
}

/**
 * Return the last non-empty user text message in the session as the question
 * to verify, or `undefined` when none exists (e.g. a synthetic turn).
 */
export function extractQuestion(session: Session): string | undefined {
  for (const message of [...session.deriveMessages()].reverse()) {
    if (message.role !== 'user') continue
    const text = textOf(message.content).trim()
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * Resolve the agent's active provider/model route from its session header, so
 * the verifier pass uses the same model route as the conversation.
 */
export function resolveAgentRoute(agent: Agent): ModelRoute | undefined {
  const header = agent.session.requestHeader()
  const config = header?.config
  if (config !== undefined) return { provider: config.provider, model: config.model }
  return undefined
}

/**
 * Prompt builders for the LLM-as-a-verifier pipeline.
 *
 * The pipeline has two roles:
 *  - **generator**: produces one candidate answer per parallel call;
 *  - **verifier**: reads every candidate and either scores them all in one pass
 *    (`score` strategy) or compares candidates pairwise in a knockout bracket
 *    (`tournament` strategy).
 * Verifier outputs are strict single-line JSON so the plugin can parse them.
 * @module @asyouwish/dsh-verifier/prompts
 */

import type { CandidateAnswer, VerifyRequest } from './types.ts'

/** Stable system instruction for one candidate generator call. */
export function generatorSystemPrompt(): string {
  return [
    'You are one independent candidate generator.',
    'Answer the user\'s question directly and completely, in the language of the question.',
    'Produce ONLY the answer itself — no commentary, no meta reasoning, no tool calls,',
    'no markdown fences unless the answer genuinely needs formatting.',
    'Be precise, concrete, and self-contained.',
  ].join('\n')
}

/** User message framing for one candidate generator call. */
export function generatorUserPrompt(request: VerifyRequest): string {
  return [
    request.context === undefined ? 'Question:' : 'Question:\n' + request.question,
    request.context === undefined ? request.question : '',
    request.context === undefined ? '' : '\nContext:\n' + request.context,
  ].filter(line => line.length > 0).join('\n')
}

/** Stable system instruction for the one-pass scorer verifier. */
export function verifierScoreSystemPrompt(): string {
  return [
    'You are a strict verifier. You are given a question and several candidate answers.',
    'Evaluate every candidate for correctness, completeness, clarity, and faithfulness to the question.',
    'Pick the single most suitable candidate.',
    'Respond with STRICT JSON ONLY, in exactly this shape, with no prose before or after:',
    '{"index": <0-based index of the best candidate>, "score": <0..1 confidence>, "reason": "<one short sentence, in the question\'s language>"}',
  ].join('\n')
}

/** User message framing the question and all candidates for the scorer verifier. */
export function verifierScoreUserPrompt(request: VerifyRequest, candidates: readonly CandidateAnswer[]): string {
  const body = candidates.map(candidate => `[${candidate.index}] ${candidate.text}`).join('\n')
  return [
    'Question:',
    request.question,
    request.context === undefined ? '' : '\nContext:\n' + request.context,
    '\nCandidate answers:',
    body,
  ].filter(line => line.length > 0).join('\n')
}

/** Stable system instruction for one pairwise tournament comparison. */
export function verifierTournamentSystemPrompt(): string {
  return [
    'You are a strict verifier. You are given a question and two candidate answers, labeled A and B.',
    'Pick the more suitable candidate: the one that is more correct, complete, clear, and faithful to the question.',
    'Respond with STRICT JSON ONLY, in exactly this shape, with no prose before or after:',
    '{"winner": "A" | "B", "reason": "<one short sentence, in the question\'s language>"}',
  ].join('\n')
}

/** User message framing the question and one candidate pair for a tournament comparison. */
export function verifierTournamentUserPrompt(
  request: VerifyRequest,
  a: CandidateAnswer,
  b: CandidateAnswer,
): string {
  return [
    'Question:',
    request.question,
    request.context === undefined ? '' : '\nContext:\n' + request.context,
    '\n[A] ' + a.text,
    '\n[B] ' + b.text,
  ].filter(line => line.length > 0).join('\n')
}

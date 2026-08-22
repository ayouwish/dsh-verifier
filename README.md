# @deepseek-ai/dsh-verifier

English | [中文](README.zh.md)

LLM-as-a-verifier plugin for DeepSeek Harness. When verification mode is
enabled it registers the `ctx.verifier` service and the model-facing
`verify_answer` tool, implementing the *generate-then-verify* pattern:

1. **Generate in parallel** — `n` independent candidate answers to the same
   question are produced by concurrent model calls (the fan-out is a single
   `Promise.all` over `ctx.llm.stream`).
2. **Verify and select** — a separate verifier model pass picks the single most
   suitable candidate and reports its reasoning. Two selection strategies are
   provided: `score` (one pass scores every candidate and returns the best
   index) and `tournament` (pairwise knockout comparisons).

This mirrors the LLM-as-a-verifier line of work (generate multiple candidates,
then let a verifier LLM decide) — e.g. self-verification / best-of-N with
verifier selection — packaged as a pluggable harness capability instead of a
prompt hack inside the agent loop.

Set `autoVerify` to run the pipeline automatically on every agent final answer
(the *auto-verify mode*). The flag is persisted as the `verifier.autoVerify`
setting; the Web GUI's **General** settings panel exposes it as a **Verification
mode** switch (contributed by `@deepseek-ai/dsh-client-ui-verifier`), or write
the settings field directly.

## Configuration

| Key | Type | Description |
| --- | --- | --- |
| `n` | integer `[1,8]` | Number of parallel candidate generations per verification run. |
| `strategy` | `'score' \| 'tournament'` | How the verifier selects the best candidate. |
| `maxOutputTokens` | integer `>= 1` | Output-token cap for each generation and verification call. |
| `timeoutMs` | integer `>= 1` | Per-call deadline for each auxiliary model request. |
| `enabled` | boolean | Whether verification mode is on (registers the `verify_answer` tool). |
| `autoVerify` | boolean | When `true`, every agent final answer is auto-verified (see below) before the turn concludes. |
| `provider` | string (optional) | Explicit provider route; must be paired with `model`. |
| `model` | string (optional) | Explicit model id; must be paired with `provider`. |

When `provider`/`model` are omitted, the tool inherits the exact route from the
calling agent's current logged request header; programmatic callers can pass an
explicit `route` in `VerifyRequest`.

## Wiring

Add the plugin to a cordis composition (for example a profile patch):

```yaml
- insert:
    - id: verifier
      name: '@deepseek-ai/dsh-verifier'
      config:
        n: 3
        strategy: score
        maxOutputTokens: 1024
        timeoutMs: 60000
        enabled: true
```

The invariant companion registers under `@deepseek-ai/dsh-verifier/invariant`.

## Model Experience

### `verify_answer` tool

#### What the model sees

The model calls `verify_answer` with a `question` (and optional `context` / `n`). The tool runs the full pipeline and returns `best` (the selected candidate text), `index` / `score` (the verifier's choice and 0..1 confidence), `reason` (one-sentence justification), and `candidates` (all parallel-generated answers in batch order). Programmatic callers use `ctx.verifier.verify({ question, n, strategy })`.

#### Token effect

One run costs `n` auxiliary generation calls plus `n - 1` (tournament) or `1` (score) verification calls, each bounded by `maxOutputTokens`. The main agent request gains zero tokens. Auxiliary calls are tagged `purpose: 'verifier'` so providers and telemetry can distinguish them.

#### KV Cache effect

The `verify_answer` schema is prefix-stable while the tool definition and visibility are unchanged. Auxiliary generator and verifier calls carry their own distinct system prompts, so they do not reuse the conversation's KV-cache prefix.

### Auto-verify mode

#### What the model sees

When `autoVerify` is on, each clean, tool-free final answer is replaced in place by the verifier-selected best of `n` parallel candidates; the model's own draft is not re-shown, only the replaced text reaches the session. Verification failures fall back to the model's original answer.

#### Token effect

Same per-run cost as a tool call (`n` generator + selection calls), now incurred automatically on every final answer while the mode is on.

#### KV Cache effect

Auxiliary calls use distinct verifier prompts and never share the conversation prefix; the replaced final answer is appended once and is prefix-stable afterward.

## Known Limitations and Deferred Work

- Candidate texts are assembled from text blocks only; tool-calling candidates
  are rejected loudly.
- `tournament` runs sequentially (each comparison awaits the previous), which
  trades latency for selection fidelity; a parallel bracket is future work.
- Auto-verify mode needs an upstream `@deepseek-ai/dsh-agent-loop` release that
  dispatches `agent/verify-answer`; published `0.1.1-rc.2` does not, so the
  hook lies dormant until such a release exists. The `verify_answer` tool and
  the pipeline work regardless of that event.

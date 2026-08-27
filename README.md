# @asyouwish/dsh-verifier

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
| `generation` | `'raw' \| 'subagent'` | How candidates are produced: `raw` (concurrent model calls, the default) or `subagent` (parallel subagents, see below). |
| `subagentProvider` | string (optional) | The `ctx.subagents` provider name used when `generation: 'subagent'`; defaults to `spawn`. |
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
      name: '@asyouwish/dsh-verifier'
      config:
        n: 3
        strategy: score
        maxOutputTokens: 1024
        timeoutMs: 60000
        enabled: true
```

The invariant companion registers under `@asyouwish/dsh-verifier/invariant`.

For `generation: 'subagent'`, also compose the `spawn` backend so the default
`subagentProvider: 'spawn'` resolves:

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
```

> **Complete DSH hosts (the official `web` profile) already ship the full
> subagent stack** (`subagent`, `spawn`/`fork` providers, and the subagent
> tools) in their bundle layer — no extra wiring is needed there; just set
> `generation: subagent`. The verifier resolves the runtime from the composed
> root, which stays correct even though loader entry contexts in DSH don't
> inherit services that sibling loader entries provide.

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

### Subagent-backed generation (`generation: 'subagent'`)

The default `raw` generation fans out bare model calls. With `generation: 'subagent'`,
each candidate is instead produced by one parallel subagent spawned through the
`ctx.subagents` service: `n` children are started concurrently, each receives the
generator role plus the question as its initial prompt, the host collects every
child's final output as one candidate, and the verifier pass then selects the
best exactly as in raw mode. The main agent receives a single verified answer —
never `n` raw drafts.

#### What the model sees

Identical tool and service surface: `verify_answer` / `ctx.verifier.verify`
accept the same inputs. `VerifyRequest.parent` (the calling agent) is required:
the subagent seam derives workspace, lineage, and delegation depth from its
session. The `verify_answer` tool and auto-verify mode supply it automatically.

#### Requirements

- The `@deepseek-ai/dsh-subagent` runtime (a peer dependency) must be
  reachable, and the deployment must compose a *provider* plugin that registers
  `ctx.subagents` under `subagentProvider` (default `spawn`).
- The `spawn` backend ships as `@deepseek-ai/dsh-subagent-spawn-in-process`
  (registered as `spawn` by default) and is published alongside the runtime, so
  the default `subagentProvider: 'spawn'` works as soon as the host composes
  that backend. Other backends (`fork`, `acp`, `codex`, `claude-code`) register
  different names — set `subagentProvider` to match the one your deployment
  composes.
- Missing pieces fail loudly at call time: no provider composed, or no calling
  agent, produces a clear error instead of silently degrading.

#### Token effect

Each candidate is now a full child agent turn (system prompt assembly, session,
any tools the child chooses to call) instead of one bounded completion, so this
mode is strictly more expensive and slower per candidate than `raw`. In
exchange candidates can think, use tools, and carry context — useful for hard,
multi-step questions where shallow parallel drafts are not enough. The verifier
selection pass itself is unchanged.

#### KV Cache effect

Children carry their own fresh contexts and never reuse the parent conversation
prefix; the verifier call uses its own system prompt as in raw mode.

## Known Limitations and Deferred Work

- Candidate texts are assembled from text blocks only; tool-calling candidates
  are rejected loudly.
- `tournament` runs sequentially (each comparison awaits the previous), which
  trades latency for selection fidelity; a parallel bracket is future work.
- Auto-verify mode needs an upstream `@deepseek-ai/dsh-agent-loop` release that
  dispatches `agent/verify-answer`; published `0.1.1-rc.2` does not, so the
  hook lies dormant until such a release exists. The `verify_answer` tool and
  the pipeline work regardless of that event.
- Subagent-backed generation requires the host to compose a `ctx.subagents`
  backend; the `spawn` backend (`@deepseek-ai/dsh-subagent-spawn-in-process`)
  is published and matches the default `subagentProvider`, so deployments need
  only mount it.

# @deepseek-ai/dsh-verifier

[English](README.md) | 中文

DeepSeek Harness 的 LLM-as-a-verifier（LLM 作为验证器）插件。启用验证模式后，它注册 `ctx.verifier` 服务和面向模型的 `verify_answer` 工具，实现"先生成、后验证"的范式：

1. **并行生成** —— 对同一个问题，通过并发的模型调用独立生成 `n` 个候选答案（扇出是一次覆盖 `ctx.llm.stream` 的 `Promise.all`）。
2. **验证并选择** —— 由独立的 verifier 模型调用选出最合适的一个候选，并给出理由。提供两种选择策略：`score`（一次打分所有候选并返回最佳下标）和 `tournament`（两两淘汰比较）。

这与 LLM-as-a-verifier 系列工作（生成多个候选，再由 verifier LLM 裁决，例如 self-verification / 带验证器选择的 best-of-N）一脉相承，只是被打包成可插拔的 harness 能力，而不是塞进 agent 循环里的提示词技巧。

设置 `autoVerify` 可在每个 agent 最终答案上自动运行该流水线（即"自动验证模式"）。该标志持久化为 `verifier.autoVerify` 设置；Web GUI 的 **通用**（General）设置面板把它暴露为 **验证模式** 开关（由 `@deepseek-ai/dsh-client-ui-verifier` 提供），也可以直接写入该设置字段。

## 配置

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `n` | 整数 `[1,8]` | 每次验证并行生成的候选数量。 |
| `strategy` | `'score' \| 'tournament'` | verifier 选择最佳候选的方式。 |
| `generation` | `'raw' \| 'subagent'` | 候选的生成方式：`raw`（并发模型调用，默认）或 `subagent`（并行子 agent，见下文）。 |
| `subagentProvider` | 字符串（可选） | `generation: 'subagent'` 时使用的 `ctx.subagents` provider 名称，默认 `spawn`。 |
| `maxOutputTokens` | 整数 `>= 1` | 每次生成/验证调用的输出 token 上限。 |
| `timeoutMs` | 整数 `>= 1` | 每个辅助模型请求的截止时间。 |
| `enabled` | 布尔 | 是否开启验证模式（注册 `verify_answer` 工具）。 |
| `autoVerify` | 布尔 | 为 `true` 时，每个 agent 最终答案都会在回合结束前被自动验证（见下文）。 |
| `provider` | 字符串（可选） | 显式 provider 路由；必须与 `model` 成对出现。 |
| `model` | 字符串（可选） | 显式模型 id；必须与 `provider` 成对出现。 |

当省略 `provider`/`model` 时，工具继承调用方 agent 当前记录的请求路由；编程调用方可以在 `VerifyRequest` 中传入显式 `route`。

## 接线

把插件加入 cordis 组合（例如某个 profile 的 patch）：

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

invariant 伴生插件注册在 `@deepseek-ai/dsh-verifier/invariant`。

## 模型体验

### `verify_answer` 工具

#### 模型所见

模型用 `question`（可选 `context` / `n`）调用 `verify_answer`。工具执行完整流水线并返回 `best`（被选中的候选文本）、`index` / `score`（verifier 的选择及 0..1 置信度）、`reason`（一句话理由）和 `candidates`（按批次顺序排列的所有并行生成答案）。编程调用方使用 `ctx.verifier.verify({ question, n, strategy })`。

#### Token 开销

一次运行消耗 `n` 次辅助生成调用，加上 `n - 1`（tournament）或 `1`（score）次验证调用，每次受 `maxOutputTokens` 约束。主 agent 请求不增加 token。辅助调用标记为 `purpose: 'verifier'`，便于 provider 与遥测区分。

#### KV 缓存影响

在工具定义与可见性不变时，`verify_answer` 的 schema 是前缀稳定的。辅助的生成与验证调用携带各自不同的 system 提示词，因此不会复用会话的 KV 缓存前缀。

### 自动验证模式

#### 模型所见

当 `autoVerify` 开启时，每个干净、无工具调用的最终答案都会被原位替换为 `n` 个并行候选中由 verifier 选出的最佳答案；模型自己的草稿不会被再次展示，只有替换后的文本进入会话。验证失败会回退到模型的原始答案。

#### Token 开销

与一次工具调用相同的每次运行开销（`n` 次生成 + 选择调用），在模式开启期间会于每个最终答案上自动产生。

#### KV 缓存影响

辅助调用使用不同的 verifier 提示词，从不共享会话前缀；替换后的最终答案只追加一次，之后是前缀稳定的。

### 基于子 agent 的生成（`generation: 'subagent'`）

默认的 `raw` 生成扇出的是裸模型调用。使用 `generation: 'subagent'` 时，每个候选改由通过 `ctx.subagents` 服务启动的一个并行子 agent 产生：`n` 个子 agent 并发启动，每个以"生成器角色 + 问题"作为初始提示，宿主收集每个子 agent 的最终输出作为一个候选，再由 verifier 调用照常选出最佳——主 agent 只拿到一个经过验证的答案，而不是 `n` 份原始草稿。

#### 模型所见

工具与服务面完全不变：`verify_answer` / `ctx.verifier.verify` 接受同样的输入。`VerifyRequest.parent`（调用方 agent）是必需的：subagent 接缝从其会话派生工作区、血缘与委派深度。`verify_answer` 工具与自动验证模式会自动提供它。

#### 依赖要求

- 必须能访问 `@deepseek-ai/dsh-subagent` 运行时（peer 依赖），且部署中必须组合一个提供 `ctx.subagents` 的 provider 插件，注册名即 `subagentProvider`（默认 `spawn`）。
- 截至目前 `@deepseek-ai/dsh-subagent` 服务已发布，但官方 provider 包（如进程内驱动、`tool-subagent`）尚未发布到 npm——使用该模式的部署需自带 provider，直到官方版本发布。
- 缺失项会在调用时响亮失败：没有组合 provider、或没有调用方 agent，都会给出清晰错误而不是静默降级。

#### Token 开销

每个候选现在是一次完整的子 agent 回合（系统提示组装、会话、子 agent 可选调用的工具），而不是一次有上限的补全，因此该模式每个候选的代价与延迟都严格高于 `raw`。换来的是候选能思考、能用工具、能携带上下文——适合需要多步骤推理的难题，此时浅层并行草稿不够用。verifier 选择阶段本身不变。

#### KV 缓存影响

子 agent 携带各自全新的上下文，从不复用父会话前缀；verifier 调用与 raw 模式一样使用自己的 system 提示词。

## 已知限制与后续工作

- 候选文本仅从文本块组装；候选请求工具调用会被明确拒绝。
- `tournament` 串行执行（每次比较等待上一次），用延迟换取选择保真度；并行淘汰赛是后续工作。
- 自动验证模式需要上游 `@deepseek-ai/dsh-agent-loop` 发布支持分发 `agent/verify-answer` 事件的版本；已发布的 `0.1.1-rc.2` 尚不支持，因此在该版本发布前此钩子不会触发。`verify_answer` 工具和流水线不受该事件影响。
- 基于子 agent 的生成需要一个已组合的 `ctx.subagents` provider；官方 provider 包尚未发布，发布前需由部署自备。

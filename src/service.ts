/**
 * `ctx.verifier` service: the LLM-as-a-verifier capability seam.
 *
 * Constructing {@link VerifierService} registers it on the context; consumers
 * call {@link VerifierService.verify} to run the parallel-N + verifier-select
 * pipeline. The plugin entry also exposes the same capability to the model as
 * the `verify_answer` tool (see `index.ts`).
 * @module @deepseek-ai/dsh-verifier/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { runVerification } from './pipeline.ts'
import type { VerifyRequest, VerifyResult, VerifierConfig } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    verifier: VerifierService
  }
}

/**
 * The verifier service. Its single method runs the whole pipeline: resolve the
 * model route, generate `n` candidate answers concurrently, then select the
 * best with the configured strategy.
 */
export class VerifierService extends Service {
  constructor(ctx: Context, private readonly config: VerifierConfig) {
    super(ctx, 'verifier')
  }

  /**
   * Run one verification: N parallel candidate generations + verifier selection.
   * @param request - the question, optional context/strategy/route overrides.
   * @returns the best candidate, the full batch, and the verifier's verdict.
   */
  verify(request: VerifyRequest): Promise<VerifyResult> {
    return runVerification(this.ctx, this.config, request)
  }
}

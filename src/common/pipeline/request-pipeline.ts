// The ordered registry of the request pipeline (decision 018): IP rules, maintenance and the per-IP limit run as Fastify hooks
// before routing-dependent work and before any guard. The order is a table here, not an accident of module loading.
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProblemExceptionFilter } from '../errors';

/**
 * The stages of the request pipeline that run as Fastify hooks, in the order they run (decision 018, ARCHITECTURE § 3).
 *
 * Why: after CORS and the request id, a request meets the IP rules (a blocked address is refused before anything else), then
 * maintenance, then the per-IP rate limit; authentication, CSRF and permissions are Nest guards that run later. A test
 * pins this list.
 */
export const PIPELINE_STAGES = ['ip-rules', 'maintenance', 'rate-limit'] as const;

/** One value of {@link PIPELINE_STAGES}. */
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * The Fastify hook a handler runs in: `onRequest` (before the body is read) or `preValidation` (after the body is parsed,
 * still before guards and handlers).
 *
 * Why: nearly every decision needs only the address and the path. The few that need the body (the Dhru `action` field of a
 * maintenance scope) use `preValidation`.
 */
export type PipelinePhase = 'onRequest' | 'preValidation';

/**
 * What a stage does with a request: return to let it pass, throw an `AppError` to refuse it.
 *
 * Why: a refusal is an error like any other (problem+json, the surface's own envelope for Dhru, metrics, access log), so the
 * handler throws and the registry answers through the exception filter.
 */
export type PipelineHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

const PHASES: readonly PipelinePhase[] = ['onRequest', 'preValidation'];

/**
 * Collects the hook of each pipeline stage and installs them on Fastify in the order of {@link PIPELINE_STAGES}.
 *
 * Why: decision 018 fixes the order of the checks that run before authentication, and each check lives in a different
 * place (identity owns the IP rules, platform owns maintenance, the rate-limit infrastructure owns the limiter). Modules
 * register their handler in `onModuleInit`; `configureApp` installs one hook per phase after CORS, the request id, cookies
 * and the security headers, so a refusal still carries the CORS and security headers. A stage with no handler (a test
 * app without Redis) is skipped.
 *
 * Side effects: `install` adds two hooks to the Fastify instance; a refusal sends the problem+json reply and stops the
 * request.
 *
 * @see docs/decisions/018-auth-sessions-csrf.md
 */
@Injectable()
export class RequestPipeline implements OnApplicationBootstrap {
  private readonly logger = new Logger(RequestPipeline.name);
  private readonly handlers = new Map<string, PipelineHandler>();
  private installed = false;

  constructor(private readonly filter: ProblemExceptionFilter) {}

  /**
   * Registers the handler of a stage.
   *
   * @param stage the stage the handler implements
   * @param handler runs for each request; throws an `AppError` to refuse
   * @param phase the Fastify hook to run in (default `onRequest`)
   * @throws {Error} when the stage already has a handler in that phase (two modules claiming one stage is a programming
   *   error)
   */
  register(stage: PipelineStage, handler: PipelineHandler, phase: PipelinePhase = 'onRequest'): void {
    const key = `${phase}:${stage}`;
    if (this.handlers.has(key)) throw new Error(`Pipeline stage "${stage}" already has a ${phase} handler`);
    this.handlers.set(key, handler);
  }

  /**
   * Lists the stages that have a handler in a phase, in the order they run.
   *
   * @param phase the Fastify hook
   * @returns the stage names
   */
  stagesWithHandlers(phase: PipelinePhase = 'onRequest'): PipelineStage[] {
    return PIPELINE_STAGES.filter((stage) => this.handlers.has(`${phase}:${stage}`));
  }

  /**
   * Adds the pipeline hooks to Fastify: for each phase one hook that runs the stages in order.
   *
   * Why: call it once, after CORS, the request id, cookies and helmet are registered (`configureApp`). Handlers may be
   * registered before or after; they are looked up per request.
   *
   * @param fastify the underlying Fastify instance
   * @throws {Error} when called twice
   */
  install(fastify: FastifyInstance): void {
    if (this.installed) throw new Error('The request pipeline is already installed');
    this.installed = true;
    for (const phase of PHASES) {
      fastify.addHook(phase, async (request, reply) => {
        for (const stage of PIPELINE_STAGES) {
          const handler = this.handlers.get(`${phase}:${stage}`);
          if (!handler) continue;
          try {
            await handler(request, reply);
          } catch (error) {
            this.filter.handle(error, request, reply);
            // Returning the reply tells Fastify the answer is on its way, so the chain stops here.
            return reply;
          }
          if (reply.sent) return reply;
        }
        return undefined;
      });
    }
  }

  /** Warns about a stage nobody registered once every module has started (an app without Redis or Postgres has none). */
  onApplicationBootstrap(): void {
    const missing = PIPELINE_STAGES.filter((stage) => !this.handlers.has(`onRequest:${stage}`));
    if (missing.length > 0) {
      this.logger.warn(`Request pipeline stages without a handler (requests skip them): ${missing.join(', ')}`);
    }
  }
}

// Shared HTTP bootstrap of the API (decision 016, 018): the Fastify adapter options and the plugins/hooks every
// environment needs. main.ts and the integration tests call the same two functions, so tests see the real pipeline.
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from 'nestjs-pino';
import { ProblemExceptionFilter } from './common/errors';
import { registerMultipartBodies } from './common/multipart';
import { RequestPipeline } from './common/pipeline';
import { registerRawBodyCapture } from './common/raw-body';
import { REQUEST_ID_HEADER, resolveRequestId, runWithRequestId } from './common/request-id';
import type { AppConfig, TrustProxy } from './config';
import { registerAccessLog } from './infra/logging';
import { MetricsService, registerHttpMetrics } from './infra/metrics';
import { OpenApiService } from './modules/platform';

/**
 * Methods a cross-origin console may use (ALIGNMENT § 6).
 *
 * Why: ALIGNMENT § 6 lists exactly these methods; a console on another origin may use no others.
 */
export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/**
 * Request headers a preflight may ask for (ALIGNMENT § 6).
 *
 * Why: ALIGNMENT § 6: the console sends only these, so a preflight asking for anything else is refused.
 */
export const CORS_ALLOWED_HEADERS = ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'Accept'] as const;
/**
 * Response headers the console may read (ALIGNMENT § 6).
 *
 * Why: browsers hide other response headers from scripts; the console reads these (pager total, request id, CSRF token,
 * retry delay, download name).
 */
export const CORS_EXPOSED_HEADERS = [
  'x-total-count',
  'x-request-id',
  'x-csrf-token',
  'retry-after',
  'content-disposition',
] as const;
/**
 * How long a browser may cache a preflight answer.
 *
 * Why: ALIGNMENT § 6 asks for 600, so the console does not preflight every call.
 */
export const CORS_MAX_AGE_SECONDS = 600;

type FastifyTrustProxy = boolean | string[] | ((address: string, hop: number) => boolean);

type FrameworkErrorHandler = (error: Error, request: FastifyRequest, reply: FastifyReply) => void;
/** Per adapter: where `configureApp` plugs the exception filter into Fastify's router-level error hook. */
const frameworkErrorSlots = new WeakMap<FastifyAdapter, { handle?: FrameworkErrorHandler }>();

/**
 * Converts the configured proxy trust to what Fastify accepts.
 *
 * Why: Fastify 5.12 ignores a numeric hop count on purpose (it cannot check who the nearest peer is), so a hop count is
 * turned into the equivalent function. Use a hop count only when the app port is reachable solely through the
 * proxy chain; otherwise list the proxies' addresses.
 *
 * @param trust `false`, a hop count or a list of IP/CIDR entries
 * @returns the Fastify `trustProxy` option
 */
export function toFastifyTrustProxy(trust: TrustProxy): FastifyTrustProxy {
  if (trust === false) return false;
  if (typeof trust === 'number') return (_address, hop) => hop < trust;
  return [...trust];
}

/**
 * Creates the Fastify adapter with the options that must be set at construction.
 *
 * Why: trusted proxies decide the client IP (IP rules, rate limits), the body limit protects memory (decision 018) and
 * the request id function gives every request the id used in headers, errors and logs (decision 012).
 *
 * @param config the process configuration
 * @returns the adapter to pass to `NestFactory.create`
 */
export function createAppAdapter(config: AppConfig): FastifyAdapter {
  const slot: { handle?: FrameworkErrorHandler } = {};
  const adapter = new FastifyAdapter({
    trustProxy: toFastifyTrustProxy(config.http.trustProxy),
    bodyLimit: config.http.bodyLimitBytes,
    genReqId: resolveRequestId,
    // Fastify answers a malformed URL itself, before Nest sees the request; send it through the same filter. Router-level
    // errors skip the request hooks (no CORS headers, access log or duration sample); browsers never send such URLs.
    frameworkErrors: (error: Error, request: FastifyRequest, reply: FastifyReply) => {
      if (slot.handle) slot.handle(error, request, reply);
      else void reply.send(error);
    },
  });
  frameworkErrorSlots.set(adapter, slot);
  return adapter;
}

/**
 * Binds the request id to the async context and echoes it on every reply, errors and preflights included.
 *
 * Why: decision 012: the id is shown by the console on errors and joins API, worker and supplier logs.
 *
 * @param fastify the underlying Fastify instance
 */
export function registerRequestIdHooks(fastify: FastifyInstance): void {
  // The context starts in the first hook this file adds, so parsing, guards, handlers and filters all run inside it.
  fastify.addHook('onRequest', (request, _reply, done) => {
    runWithRequestId(request.id, done);
  });
  // onSend sees every reply Fastify sends: handler results, filter answers, 404s and the CORS preflight.
  fastify.addHook('onSend', (request, reply, payload, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done(null, payload);
  });
}

/**
 * Applies the HTTP pipeline pieces shared by the API and the tests: logger, request id, CORS, cookies, security
 * headers, access log, request metrics, the raw-body tap of the webhook surface and the multipart parser of the upload routes. Shutdown hooks and listening stay in
 * `main.ts`.
 *
 * Why: ALIGNMENT § 6 and decision 018 fix the order: CORS preflight is answered first (so a refused request still
 * carries readable CORS headers), then the request id; then the request pipeline (IP rules, maintenance, per-IP rate
 * limit), installed last so that its refusals carry the CORS and security headers too; authentication, CSRF and
 * permissions are Nest guards and run after it.
 *
 * @param app the Nest application, created but not initialised yet
 * @param config the process configuration
 * @throws {Error} when the OpenAPI documents cannot be built from the contracts (a programming error: the app must
 *   not start)
 */
export async function configureApp(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const logger = app.get(Logger);
  app.useLogger(logger);
  const fastify = app.getHttpAdapter().getInstance();
  const slot = frameworkErrorSlots.get(app.getHttpAdapter() as unknown as FastifyAdapter);
  if (slot) {
    const filter = app.get(ProblemExceptionFilter);
    slot.handle = (error, request, reply) => filter.handle(error, request, reply);
  }

  // Nest 12 runs the CORS hook before everything else (middleware included): a preflight never meets IP rules or auth.
  app.enableCors({
    origin: [...config.http.corsOrigins],
    credentials: true,
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: CORS_MAX_AGE_SECONDS,
    // An OPTIONS request without Origin is not a browser preflight; answer it like any other instead of with
    // @fastify/cors' plain-text 400 (decision 028: every error is problem+json).
    strictPreflight: false,
  });
  registerRequestIdHooks(fastify);
  await app.register(fastifyCookie);
  // JSON-only API: deny everything by default. Only the documentation pages (GET /docs, GET /reference) send their own,
  // wider policy, set by their controllers (src/modules/platform/docs).
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"], frameAncestors: ["'none'"] },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });
  registerHttpMetrics(fastify, app.get(MetricsService));
  registerAccessLog(fastify, logger);
  // Gateway signatures cover the exact bytes of the body, so the webhook surface keeps them (the guard reads them).
  registerRawBodyCapture(fastify);
  // Uploads and multipart Dhru calls (B157, decision 026): parsed before the guards on the three routes that take them.
  registerMultipartBodies(fastify);
  // After CORS, the request id, cookies and helmet (they are onRequest hooks too, and Fastify runs hooks in the order they were
  // added): a refusal then carries the CORS and security headers. The modules register their stage in onModuleInit.
  app.get(RequestPipeline).install(fastify);
  // The OpenAPI documents come from the contracts of every controller registered so far, so build them last.
  app.get(OpenApiService).publish(app);
}

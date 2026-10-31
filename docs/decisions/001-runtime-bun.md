# 001: Runtime: Bun for the API and the worker

Status: accepted, 2026-10-31 (Phase 0 spike).

**Context.** The stack fixes Bun as the runtime for NestJS + Fastify. BullMQ, ioredis, the Drizzle drivers, argon2
native code, the AWS SDK, Swagger/Scalar, Bull Board and prom-client are mostly tested on Node, and NestJS needs
legacy decorators with emitted metadata.

**Spike.** `bun run spike` (`spike/bun-compat/`, retired in P2.4b: see the last bullet) ran every piece as real Bun
1.4.4 processes against the compose stack. 27/27 checks passed: Nest 12.3 + Fastify 5.12; constructor DI without `@Inject` (Bun emits
`design:paramtypes`); Drizzle 0.45 + pg 8.23 (transaction, `SELECT … FOR UPDATE`, `numeric` returned as a string);
drizzle-kit generate/migrate (`bunx --bun`); ioredis 6 on both Redis roles; BullMQ 6.5 producer, worker and job
scheduler; AWS SDK v3 put/get/presign on MinIO; argon2 and @node-rs/argon2; @nestjs/swagger 12 emitting OpenAPI
3.1 with zod-generated schemas; Scalar (`withFastify: true`); Bull Board on Fastify; prom-client default metrics;
`bun test` with `@nestjs/testing` and Fastify `inject`. SIGTERM to the worker while a job runs: the job finishes,
then the worker, queue, pool and Redis close in that order. A duplicate enqueue with the same deterministic
`jobId` returns the existing job, which runs once (the basis of idempotent jobs).

**Decision.** Both processes run on Bun from the TypeScript sources (`bun src/main.ts`, `bun src/worker.ts`), with
no build step. No piece needs a Node fallback today.

**Consequences.**
- tsconfig keeps `experimentalDecorators`, `emitDecoratorMetadata` and `useDefineForClassFields: false` (Bun reads
  them; without them Nest DI breaks). Never `import type` an injected class.
- Nest's shutdown hooks re-raise the signal after cleanup, so a clean stop exits with 143 (SIGTERM).
- Close order: BullMQ workers in `onModuleDestroy`, connections in `onApplicationShutdown`.
- The spike (`spike/bun-compat/`, `bun run spike`) was retired in P2.4b together with its `postgres` and `argon2`
  dependencies; the integration tests now prove what it proved, under Bun: Nest + Fastify, constructor DI without `@Inject`
  and `fastify.inject` (every integration test), Drizzle + pg transactions and `numeric` as a string (`db-*.test.ts`),
  ioredis on both Redis roles (`redis.test.ts`), BullMQ producers, workers, schedulers, job-id de-duplication and a Redis
  that is down at startup or restarts (`queues.test.ts`, `queue-redis-restart.test.ts`), SIGTERM with an active job
  (`worker-process.test.ts`), the outbox relay (`outbox.test.ts`), the AWS SDK on MinIO (`storage.test.ts`), Swagger and
  Scalar (`openapi.test.ts`, `docs.test.ts`), prom-client (`metrics.test.ts`) and `bun test` with `@nestjs/testing`.
  Not covered yet: Bull Board on Fastify, which the System health feature (stage 9) mounts at `/admin/queues` with its own
  test. When upgrading Bun, Nest, BullMQ, ioredis or Drizzle, `bun run check` is the compatibility check.

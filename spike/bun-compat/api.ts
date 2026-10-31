// Bun compatibility spike: the API process (Nest 12 + Fastify) with Swagger 3.1, Scalar, Bull Board and /metrics.
// Each check in GET /spike/checks exercises one dependency from inside a Nest request under Bun.
import 'reflect-metadata';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiTags, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter as BullBoardFastifyAdapter } from '@bull-board/fastify';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import argon2 from 'argon2';
import * as rsArgon2 from '@node-rs/argon2';
import client from 'prom-client';
import { eq, sql } from 'drizzle-orm';
import { cfg, DbService, InfraModule, JobsService, mark, RedisService, StorageService } from './infra';
import { CreateJobBody, CreateJobResponse, Route } from './contract';
import { spikeAccounts } from './schema';

type Check = { ok: boolean; detail?: unknown };

@ApiTags('spike')
@Controller('spike')
class SpikeController {
  // No @Inject tokens: proves emitDecoratorMetadata works under Bun's transpiler.
  constructor(
    private readonly dbs: DbService,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
  ) {}

  @Get('checks')
  @Route({ summary: 'Run every dependency check', responses: { 200: { description: 'Check results' } } })
  async checks(): Promise<Record<string, Check>> {
    const out: Record<string, Check> = {};
    const run = async (name: string, fn: () => Promise<unknown>) => {
      try {
        out[name] = { ok: true, detail: await fn() };
      } catch (e) {
        out[name] = { ok: false, detail: String(e) };
      }
    };
    await run('di', async () => Boolean(this.dbs && this.redis && this.jobs && this.storage) || Promise.reject('missing'));
    await run('pg_select', async () => (await this.dbs.db.execute(sql`select 1 as one`)).rows[0]);
    await run('pg_for_update_numeric', async () => {
      // Transaction + row lock + numeric arithmetic in SQL; pg must return numeric as a string (no float).
      const [acc] = await this.dbs.db.insert(spikeAccounts).values({ balance: '100.1000' }).returning();
      const after = await this.dbs.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(spikeAccounts).where(eq(spikeAccounts.id, acc!.id)).for('update');
        const [upd] = await tx
          .update(spikeAccounts)
          .set({ balance: sql`${spikeAccounts.balance} - ${'0.1000'}::numeric` })
          .where(eq(spikeAccounts.id, locked!.id))
          .returning();
        return upd!.balance;
      });
      if (typeof after !== 'string' || after !== '100.0000') throw new Error(`got ${typeof after} ${after}`);
      return after;
    });
    await run('redis_cache', async () => {
      await this.redis.cache.set('gsm:spike:cache:k', 'v', 'PX', 5000);
      const policy = await this.redis.cache.config('GET', 'maxmemory-policy');
      return { value: await this.redis.cache.get('gsm:spike:cache:k'), policy };
    });
    await run('redis_queue_policy', async () => this.redis.queueProducer.config('GET', 'maxmemory-policy'));
    await run('s3_put_get_presign', async () => {
      const Key = `spike/${Date.now()}.txt`;
      await this.storage.s3.send(new PutObjectCommand({ Bucket: cfg.s3Bucket, Key, Body: 'hello s3', ContentType: 'text/plain' }));
      const got = await this.storage.s3.send(new GetObjectCommand({ Bucket: cfg.s3Bucket, Key }));
      const text = await got.Body!.transformToString();
      const url = await getSignedUrl(this.storage.s3, new GetObjectCommand({ Bucket: cfg.s3Bucket, Key }), { expiresIn: 60 });
      const viaUrl = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text();
      if (text !== 'hello s3' || viaUrl !== 'hello s3') throw new Error(`mismatch ${text} / ${viaUrl}`);
      return 'ok';
    });
    await run('argon2_native', async () => {
      const h = await argon2.hash('pw', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
      return { prefix: h.slice(0, 10), verify: await argon2.verify(h, 'pw') };
    });
    await run('argon2_noders', async () => {
      // Default algorithm is argon2id (its `Algorithm` enum is an ambient const enum, unusable with isolatedModules).
      const h = await rsArgon2.hash('pw', { memoryCost: 19456, timeCost: 2 });
      if (!h.startsWith('$argon2id$')) throw new Error(`not argon2id: ${h.slice(0, 12)}`);
      // Cross-library verify: hashes are PHC strings, so either library can check the other's output.
      return { prefix: h.slice(0, 10), verify: await rsArgon2.verify(h, 'pw'), cross: await argon2.verify(h, 'pw') };
    });
    return out;
  }

  @Post('jobs')
  @Route({
    summary: 'Enqueue a slow job (graceful shutdown test)',
    body: CreateJobBody,
    responses: {
      201: { description: 'Enqueued', schema: CreateJobResponse, example: { id: 'long-1' } },
      400: { description: 'Validation failed' },
    },
  })
  async enqueue(@Body() body: CreateJobBody) {
    const job = await this.jobs.queue.add('work', body, { jobId: body.jobId, removeOnComplete: { age: 3600 } });
    return { id: job.id };
  }
}

@Module({ imports: [InfraModule], controllers: [SpikeController] })
class ApiModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(ApiModule, new FastifyAdapter(), {
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('GSM spike').setVersion('0.0.0').setOpenAPIVersion('3.1.0').build(),
  );
  const fastify = app.getHttpAdapter().getInstance();
  fastify.get('/openapi.json', async () => document);
  app.use('/reference', apiReference({ content: document, withFastify: true }));

  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  fastify.get('/metrics', async (_req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  const board = new BullBoardFastifyAdapter();
  createBullBoard({ queues: [new BullMQAdapter(app.get(JobsService).queue)], serverAdapter: board });
  board.setBasePath('/admin/queues');
  await app.register(board.registerPlugin() as never, { prefix: '/admin/queues' });

  await app.listen(cfg.port, '127.0.0.1');
  mark(`api ready ${process.versions.bun ?? 'node'}`);
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
await bootstrap();

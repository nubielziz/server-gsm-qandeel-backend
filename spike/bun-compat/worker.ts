// Bun compatibility spike: the worker process (Nest application context + BullMQ Worker + job scheduler).
// Proves graceful shutdown: on SIGTERM the active job finishes before connections close.
import 'reflect-metadata';
import { Injectable, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { cfg, DbService, InfraModule, JobsService, mark } from './infra';
import { spikeJobs } from './schema';

@Injectable()
class SpikeWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private worker?: Worker;
  constructor(
    private readonly dbs: DbService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    // Worker connections never give up on a command (BullMQ requirement) and keep reconnecting.
    const connection = new Redis(cfg.redisQueueUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'spike',
      async (job) => {
        if (job.name === 'tick') return mark('tick');
        mark(`job start ${job.id}`);
        await Bun.sleep(Number(job.data.ms ?? 3000));
        // Idempotent: the unique job_id makes a replay a no-op.
        await this.dbs.db.insert(spikeJobs).values({ jobId: String(job.id) }).onConflictDoNothing();
        mark(`job done ${job.id}`);
        return { ok: true };
      },
      { connection, concurrency: 2 },
    );
    this.worker.on('error', (e) => console.error('worker error', e.message));
    // Idempotent on every boot: upserting the same scheduler id never duplicates it.
    await this.jobs.queue.upsertJobScheduler('spike-tick', { every: 1000 }, { name: 'tick', opts: { removeOnComplete: true } });
    mark('worker ready');
  }

  // onModuleDestroy runs before onApplicationShutdown, so the worker drains before the pool/redis close.
  async onModuleDestroy() {
    mark('worker closing');
    await this.jobs.queue.removeJobScheduler('spike-tick');
    await this.worker?.close();
    mark('worker closed');
  }
}

@Module({ imports: [InfraModule], providers: [SpikeWorker] })
class WorkerModule {}

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
ctx.enableShutdownHooks(['SIGTERM', 'SIGINT']);

// Bun compatibility spike (Phase 0): shared infrastructure providers used by both the API and the worker.
// Proves Drizzle + pg, ioredis (two Redis roles), BullMQ, S3 SDK and argon2 load and work under Bun.
import 'reflect-metadata';
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { S3Client } from '@aws-sdk/client-s3';
import * as schema from './schema';

/** Spike settings; every value can be overridden by env so the spike runs against any local stack. */
export const cfg = {
  port: Number(process.env.SPIKE_PORT ?? 3999),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://gsm:gsm@localhost:5432/gsm_test',
  redisQueueUrl: process.env.REDIS_QUEUE_URL ?? 'redis://localhost:6379/15',
  redisCacheUrl: process.env.REDIS_CACHE_URL ?? 'redis://localhost:6380/15',
  s3Endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  s3Bucket: process.env.S3_BUCKET ?? 'gsm-files-test',
};

/** Prints a marker line the spike runner looks for (shutdown order, readiness). */
export const mark = (m: string) => console.log(`[MARK] ${m}`);

/** Postgres pool + Drizzle. Closed in onApplicationShutdown, after workers stopped in onModuleDestroy. */
@Injectable()
export class DbService implements OnApplicationShutdown {
  readonly pool = new Pool({ connectionString: cfg.databaseUrl, max: 5 });
  readonly db = drizzle(this.pool, { schema });
  async onApplicationShutdown() {
    await this.pool.end();
    mark('db pool closed');
  }
}

/** The two Redis roles: queue (noeviction) and cache (LRU). One shared client per role. */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly cache = new Redis(cfg.redisCacheUrl, { maxRetriesPerRequest: 2 });
  // Producers fail fast when Redis is down instead of buffering commands in memory.
  readonly queueProducer = new Redis(cfg.redisQueueUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 2 });
  constructor() {
    for (const c of [this.cache, this.queueProducer]) c.on('error', (e) => console.error('redis error', e.message));
  }
  async onApplicationShutdown() {
    await Promise.all([this.cache.quit(), this.queueProducer.quit()]);
    mark('redis closed');
  }
}

/** BullMQ producer for the spike queue. */
@Injectable()
export class JobsService implements OnApplicationShutdown {
  readonly queue: Queue;
  constructor(redis: RedisService) {
    this.queue = new Queue('spike', { connection: redis.queueProducer });
    this.queue.on('error', (e) => console.error('queue error', e.message));
  }
  async onApplicationShutdown() {
    await this.queue.close();
    mark('queue closed');
  }
}

/** S3 client pointed at MinIO (path-style addressing). */
@Injectable()
export class StorageService {
  readonly s3 = new S3Client({
    endpoint: cfg.s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'gsm-minio', secretAccessKey: 'gsm-minio-secret' },
  });
}

/** Infrastructure module shared by the API and the worker (same codebase, two processes). */
@Module({ providers: [DbService, RedisService, JobsService, StorageService], exports: [DbService, RedisService, JobsService, StorageService] })
export class InfraModule {}

// A worker process for the shutdown test: the real WorkerModule plus one slow processor on the `imports` queue and a probe
// that prints when the workers close and when the connections close. Run as `bun test/support/slow-worker.ts`.
// It is the code of src/worker.ts with test providers added; markers go to stdout as "[MARK] <text>".
import 'reflect-metadata';
import { Injectable, Module, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Job } from 'bullmq';
import { loadConfigOrExit } from '../../src/config';
import { type JobProcessor, QueueProcessor } from '../../src/infra/queues';
import { WorkerModule } from '../../src/worker.module';

const mark = (text: string): void => {
  process.stdout.write(`[MARK] ${text}\n`);
};

/** Takes `ms` milliseconds to finish, so the test can send SIGTERM while it runs. */
@Injectable()
@QueueProcessor('imports')
class SlowProcessor implements JobProcessor<{ ms: number }, string> {
  async process(job: Job<{ ms: number }, string, string>): Promise<string> {
    mark(`job start ${job.id}`);
    // Real wait (decision 031): this runs in a child process, and the test sends SIGTERM while the job is in the middle of it.
    await Bun.sleep(job.data.ms);
    mark(`job done ${job.id}`);
    return 'done';
  }
}

/** Prints the two shutdown phases of Nest: onModuleDestroy (workers drain) and onApplicationShutdown (connections close). */
@Injectable()
class ShutdownProbe implements OnModuleDestroy, OnApplicationShutdown {
  onModuleDestroy(): void {
    mark('shutdown: modules are being destroyed');
  }
  onApplicationShutdown(signal?: string): void {
    mark(`shutdown: connections close now (${signal ?? 'no signal'})`);
  }
}

@Module({ imports: [WorkerModule], providers: [SlowProcessor, ShutdownProbe] })
class SlowWorkerModule {}

loadConfigOrExit();
const app = await NestFactory.createApplicationContext(SlowWorkerModule, { abortOnError: false });
app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
mark('worker ready');

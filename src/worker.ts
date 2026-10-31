// Worker process entry point (decision 016): a Nest application context (no HTTP app) with its own /metrics listener.
// Run with `bun src/worker.ts`; stops cleanly on SIGTERM/SIGINT (workers drain first, connections close last).
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadConfigOrExit, summarizeConfig } from './config';
import { WorkerModule } from './worker.module';

const config = loadConfigOrExit();

const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true, abortOnError: false });
app.useLogger(app.get(Logger));
// BullMQ workers close in onModuleDestroy, connections in onApplicationShutdown (decision 001).
app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
app.get(Logger).log({ msg: 'Worker started', config: summarizeConfig(config) }, 'Bootstrap');

// API process entry point (decision 016): loads and validates the config, builds the Fastify app, listens.
// Run with `bun src/main.ts`; the worker is a separate process (src/worker.ts).
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp, createAppAdapter } from './app.bootstrap';
import { loadConfigOrExit, summarizeConfig } from './config';

// A bad setting stops the process here, with the full list, before anything else starts (decision 013).
const config = loadConfigOrExit();

// abortOnError: false makes a startup failure a normal rejected promise (exit code 1) instead of a core dump.
const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAppAdapter(config), {
  bufferLogs: true,
  abortOnError: false,
});
await configureApp(app, config);
// On SIGTERM/SIGINT Nest closes the HTTP server first, then providers (decision 001).
app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
await app.listen(config.http.port, config.http.host);
app.get(Logger).log({ msg: 'API listening', config: summarizeConfig(config) }, 'Bootstrap');

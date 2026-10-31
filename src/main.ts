// API process entry point. Phase 0 placeholder: boots Nest on Fastify under Bun; Phase 2 adds config, logging,
// the request pipeline, OpenAPI/Scalar and the domain modules (docs/ARCHITECTURE.md).
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
// Nest closes modules on SIGTERM/SIGINT (decision 001: workers first, connections last).
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0');

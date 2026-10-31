// Bun compatibility spike: proves @nestjs/testing + Fastify inject work under `bun test` (the test runner candidate).
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

@Injectable()
class PingService {
  ping(): { pong: boolean | string } {
    return { pong: true };
  }
}

@Controller()
class PingController {
  constructor(private readonly svc: PingService) {}
  @Get('ping')
  ping() {
    return this.svc.ping();
  }
}

async function boot(override?: PingService) {
  let builder = Test.createTestingModule({ controllers: [PingController], providers: [PingService] });
  if (override) builder = builder.overrideProvider(PingService).useValue(override);
  const app = (await builder.compile()).createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('nest testing under bun test', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await boot();
  });
  afterAll(async () => {
    await app.close();
  });

  it('injects constructor deps and answers through light-my-request', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });

  it('overrides a provider', async () => {
    const mocked = await boot({ ping: () => ({ pong: 'mock' }) });
    const res = await mocked.inject({ method: 'GET', url: '/ping' });
    expect(res.json()).toEqual({ pong: 'mock' });
    await mocked.close();
  });
});

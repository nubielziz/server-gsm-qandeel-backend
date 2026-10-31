// Child-process script for test/integration/openapi-generator.test.ts: runs createOfflineApp (scripts/lib) on a module
// whose only provider builds an ioredis client inside its factory, and prints the recorded attempts as JSON.
// It runs as a child because the connection guard patches net.Socket.prototype.connect for the rest of the process.
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { createOfflineApp } from '../../scripts/lib/create-offline-app';
import { parseEnv } from '../../src/config';

// `--lazy` builds the client with `lazyConnect` (it connects only when told to); without it ioredis connects by itself.
const lazyConnect = process.argv.includes('--lazy');

@Module({
  providers: [
    {
      provide: 'REDIS_PROBE',
      useFactory: () => {
        const redis = new Redis('redis://127.0.0.1:6380', { lazyConnect, maxRetriesPerRequest: 0 });
        redis.on('error', () => undefined);
        return redis;
      },
    },
  ],
})
class ProbeModule {}

const { attempts } = await createOfflineApp(ProbeModule, parseEnv({ NODE_ENV: 'test' }), () => undefined);
console.log(JSON.stringify(attempts));
process.exit(0);

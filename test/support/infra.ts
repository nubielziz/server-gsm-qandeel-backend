// Harness for the infrastructure integration tests (Redis, cache, rate limits, storage, outbound HTTP): a small Nest module
// with the real infra modules on the test instances (Redis database 1, bucket gsm-files-test), a capture logger, and helpers.
import { type DynamicModule, Global, type LoggerService, Module, type ModuleMetadata, type Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import net from 'node:net';
import { CLOCK, type Clock, SystemClock, TIMERS, type Timers } from '../../src/common/clock';
import { ClockModule } from '../../src/common/clock.module';
import { APP_CONFIG, type AppConfig, parseEnv } from '../../src/config';
import { CacheModule } from '../../src/infra/cache';
import { CryptoModule } from '../../src/infra/crypto';
import { OutboundHttpModule } from '../../src/infra/http';
import { MetricsModule } from '../../src/infra/metrics';
import { RateLimitModule } from '../../src/infra/rate-limit';
import { RedisModule } from '../../src/infra/redis';
import { StorageModule } from '../../src/infra/storage';
import { testInstanceEnv } from './env';

@Global()
@Module({})
class TestConfigModule {
  static with(config: AppConfig): DynamicModule {
    return {
      module: TestConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

/** A logger that keeps every line (message and context) so tests can assert on what was logged. */
export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private keep(level: string, message: unknown, params: unknown[]): void {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    this.lines.push(
      `${level} ${text} ${params.map((param) => (typeof param === 'string' ? param : JSON.stringify(param))).join(' ')}`.trim(),
    );
  }
  log(message: unknown, ...params: unknown[]): void {
    this.keep('log', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.keep('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.keep('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.keep('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.keep('verbose', message, params);
  }
}

/** What {@link createInfra} returns. */
export interface InfraHarness {
  readonly moduleRef: TestingModule;
  readonly config: AppConfig;
  /** The clock the modules run on: the one passed in the options, or the system clock. */
  readonly clock: Clock;
  readonly logger: CapturingLogger;
  get<T>(token: Type<T> | symbol | string): T;
  close(): Promise<void>;
}

/** Options of {@link createInfra}. */
export interface InfraOptions {
  /** Environment on top of `NODE_ENV=test` (for example an unreachable `REDIS_CACHE_URL_TEST`). */
  readonly env?: Record<string, string>;
  /** The clock the modules read (decision 031): pass a `TestClock` to control time; default the system clock. */
  readonly clock?: Clock;
  /** The timers retries and deadlines are scheduled with (decision 031); pass `ManualTimers` to fire them by hand. */
  readonly timers?: Timers;
  /** Infra modules to load; default all of them. */
  readonly modules?: Array<Type<unknown>>;
  /** Run `onModuleInit` (connect the clients); default true. `false` leaves the modules just constructed. */
  readonly init?: boolean;
  /** Providers added to the testing module, for example `@QueueProcessor` classes of a test. */
  readonly providers?: ModuleMetadata['providers'];
  /** Providers of the loaded modules to replace with a value, as `[token, value]` pairs (settings of a module under test). */
  readonly overrides?: ReadonlyArray<readonly [token: Type<unknown> | symbol | string, value: unknown]>;
}

const ALL_MODULES: Array<Type<unknown>> = [
  MetricsModule,
  RedisModule,
  CacheModule,
  RateLimitModule,
  CryptoModule,
  StorageModule,
  OutboundHttpModule,
];

/**
 * Builds the infra modules on the test instances.
 *
 * @param options environment, modules and whether to initialise
 * @returns the harness; call `close()` in `afterAll` so every connection is closed
 */
export async function createInfra(options: InfraOptions = {}): Promise<InfraHarness> {
  const config = parseEnv({ NODE_ENV: 'test', ...testInstanceEnv(), ...options.env });
  const logger = new CapturingLogger();
  const builder = Test.createTestingModule({
    imports: [TestConfigModule.with(config), ClockModule, ...(options.modules ?? ALL_MODULES)],
    providers: options.providers ?? [],
  }).setLogger(logger);
  const clock = options.clock ?? new SystemClock();
  builder.overrideProvider(CLOCK).useValue(clock);
  if (options.timers) builder.overrideProvider(TIMERS).useValue(options.timers);
  for (const [token, value] of options.overrides ?? []) builder.overrideProvider(token).useValue(value);
  const moduleRef = await builder.compile();
  if (options.init ?? true) await moduleRef.init();
  return {
    moduleRef,
    config,
    clock,
    logger,
    get: <T>(token: Type<T> | symbol | string) => moduleRef.get<T>(token, { strict: false }),
    close: () => moduleRef.close(),
  };
}

/** A TCP port nothing listens on (found by binding port 0 and closing again). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** A TCP forwarder that can be stopped and started again on the same port: stands in for a Redis that restarts. */
export interface Forwarder {
  readonly port: number;
  /** Starts listening and forwarding (also after a `stop()`). */
  start(): Promise<void>;
  /** Stops listening and cuts every open connection. */
  stop(): Promise<void>;
}

/**
 * Makes a forwarder from a free local port to a real server.
 *
 * @param target host and port of the real server (for example the test Redis)
 * @returns the forwarder; it is stopped, call `start()`
 */
export async function createForwarder(target: { host: string; port: number }): Promise<Forwarder> {
  const port = await freePort();
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  return {
    port,
    start: () =>
      new Promise<void>((resolve) => {
        server = net.createServer((client) => {
          const upstream = net.connect(target);
          sockets.add(client).add(upstream);
          client.pipe(upstream).pipe(client);
          for (const socket of [client, upstream]) {
            socket.on('error', () => socket.destroy());
            socket.on('close', () => sockets.delete(socket));
          }
        });
        server.listen(port, '127.0.0.1', resolve);
      }),
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const closing = server;
      server = undefined;
      if (closing) await new Promise((resolve) => closing.close(resolve));
    },
  };
}

/** A Redis URL that refuses connections (nothing listens on the port). */
export async function deadRedisUrl(database = 1): Promise<string> {
  return `redis://127.0.0.1:${await freePort()}/${database}`;
}

/**
 * Polls until `probe` returns something other than `undefined`, or fails after the timeout.
 *
 * Why: the one place where tests wait for something outside the process (a queue job, a socket, a background write, a
 * Redis connection coming back). It waits for a condition, never for a time: the loop ends when the condition holds, and the
 * deadline only turns a hang into a failure. The deadline runs on the monotonic clock, so a stepped system clock (WSL) cannot
 * shorten or stretch it. A test that needs time to pass moves a `TestClock` instead (decision 031).
 *
 * @param probe returns the awaited value, or `undefined` while the condition does not hold yet
 * @param timeoutMs how long to keep trying before failing
 * @returns the first value `probe` returned
 * @throws {Error} when the condition does not hold within the timeout
 */
export async function eventually<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await Bun.sleep(20); // real wait: poll interval of a condition owned by something outside the process
  }
}

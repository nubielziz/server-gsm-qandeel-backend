// Load test of the live event streams (decision 037, plan docs/briefs/27-realtime-notifications.md § 8). Not part of `check`: the
// lead runs it once before the merge and records the table in src/infra/realtime/README.md. It builds a listening test app (the test
// database and Redis of `.env.test`), signs in N customers, and a child process opens one stream each; then it measures memory, the
// CPU of an idle minute, the delivery of one in-app campaign to all, the drops, the open descriptors and the reconnect after a restart.
//
// Usage: NODE_ENV=test bun test/load/realtime-connections.ts [--count 2000] [--idle 60]
//        (the child mode, --child, is started by the parent itself)
import { readdirSync } from 'node:fs';
import { CampaignFanOut } from '../../src/modules/platform';
import { MetricsService } from '../../src/infra/metrics';
import { PublicIpLimitModule } from '../../src/infra/rate-limit';
import { RedisService } from '../../src/infra/redis';
import { SessionCookies, SessionService } from '../../src/modules/identity';
import { schema as s } from '../../src/infra/db';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { createDraft, sendNow } from '../support/campaigns';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { freePort } from '../support/infra';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { clearStreamLimits } from '../support/stream';

/** What the parent tells the child. */
type ToChild =
  | { readonly type: 'open'; readonly url: string; readonly cookies: readonly string[] }
  | { readonly type: 'mark'; readonly at: number }
  | { readonly type: 'restart'; readonly at: number }
  | { readonly type: 'stop' };

/** What the child reports. */
type ToParent =
  | { readonly type: 'opened'; readonly count: number; readonly ms: number }
  | { readonly type: 'delivered'; readonly latencies: readonly number[] }
  | { readonly type: 'back'; readonly count: number; readonly ms: number };

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? undefined : Number(process.argv[index + 1]);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Sums every line of a metric family in Prometheus text (all label values). */
function metricSum(text: string, name: string): number {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

// ---------------------------------------------------------------------------------------------------------------- child --

/** One stream of the child: opens, parses events, and reconnects by itself like an `EventSource`. */
class ChildStream {
  lastId: string | undefined;
  retryMs = 3000;
  readyAt = 0;
  delivered = 0;
  private stopped = false;
  private controller: AbortController | undefined;

  constructor(
    private readonly url: string,
    private readonly cookie: string,
    private readonly onEvent: (stream: ChildStream, event: string) => void,
  ) {}

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const res = await fetch(this.url, {
          signal: this.controller.signal,
          headers: {
            cookie: this.cookie,
            accept: 'text/event-stream',
            'sec-fetch-site': 'same-origin',
            ...(this.lastId ? { 'last-event-id': this.lastId } : {}),
          },
        });
        if (res.status !== 200 || !res.body) {
          await res.body?.cancel();
          await Bun.sleep(5000);
          continue;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
            const block = text.slice(0, end);
            text = text.slice(end + 2);
            let event = 'message';
            for (const line of block.split('\n')) {
              if (line.startsWith('id: ')) this.lastId = line.slice(4);
              else if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('retry: ')) this.retryMs = Number(line.slice(7));
            }
            this.onEvent(this, event);
          }
        }
      } catch {
        // A refused connection during the restart, or the stop: wait and try again (or leave).
      }
      if (!this.stopped) await Bun.sleep(this.retryMs);
    }
  }
}

function child(): void {
  const streams: ChildStream[] = [];
  const send = (message: ToParent) => process.send?.(message);
  let opening: { started: number; ready: Set<ChildStream> } | undefined;
  let marked: { at: number; latencies: number[] } | undefined;
  let restart: { at: number; back: Set<ChildStream> } | undefined;

  const onEvent = (stream: ChildStream, event: string) => {
    if (event === 'ready') {
      if (opening && !opening.ready.has(stream)) {
        opening.ready.add(stream);
        if (opening.ready.size === streams.length) {
          send({ type: 'opened', count: streams.length, ms: performance.now() - opening.started });
          opening = undefined;
        }
      }
      if (restart && !restart.back.has(stream)) {
        restart.back.add(stream);
        if (restart.back.size === streams.length) {
          send({ type: 'back', count: streams.length, ms: Date.now() - restart.at });
          restart = undefined;
        }
      }
    }
    if (event === 'notification.created' && marked) {
      stream.delivered += 1;
      marked.latencies.push(Date.now() - marked.at);
      if (marked.latencies.length === streams.length) {
        send({ type: 'delivered', latencies: marked.latencies });
        marked = undefined;
      }
    }
  };

  process.on('message', (message: ToChild) => {
    switch (message.type) {
      case 'open':
        opening = { started: performance.now(), ready: new Set() };
        for (const cookie of message.cookies) {
          const stream = new ChildStream(message.url, cookie, onEvent);
          streams.push(stream);
          stream.start();
        }
        break;
      case 'mark':
        marked = { at: message.at, latencies: [] };
        break;
      case 'restart':
        restart = { at: message.at, back: new Set() };
        break;
      case 'stop':
        for (const stream of streams) stream.stop();
        process.exit(0);
    }
  });
}

// --------------------------------------------------------------------------------------------------------------- parent --

async function parent(): Promise<void> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error(
      'Run it as NODE_ENV=test bun test/load/realtime-connections.ts (the test database and Redis of .env.test)',
    );
  }
  const count = argument('count', 2000);
  const idleSeconds = argument('idle', 60);
  const prefix = testBullPrefix();
  const port = await freePort();
  const env = {
    BULL_PREFIX: prefix,
    LOG_LEVEL: 'warn',
    REALTIME_MAX_PER_IP: String(Math.max(5000, count)),
    REALTIME_MAX_CONNECTIONS: String(Math.max(5000, count)),
  };
  // The per-IP limit of the store (300 a minute) would refuse one address opening thousands of streams.
  const build = async () => {
    const app = await createTestApp({ env, withoutModules: [PublicIpLimitModule] });
    await app.app.listen(port, '127.0.0.1');
    return app;
  };

  const { db } = await testDb();
  await resetDb();
  let t: TestApp = await build();
  await clearStreamLimits(t);
  console.log(`Signing in ${count} customers...`);
  const ids = (
    await db
      .insert(s.customers)
      .values(
        Array.from({ length: count }, (_, n) => ({
          email: `load-${n}@load.example`,
          name: `Load ${n}`,
          hasAccount: true,
          status: 'active' as const,
        })),
      )
      .returning({ id: s.customers.id })
  ).map((row) => row.id);
  const cookies: string[] = [];
  const sessions = t.app.get(SessionService);
  const cookieName = t.app.get(SessionCookies).sessionCookieName('customer');
  // A few at a time: each sign-in holds a pooled transaction while it reads the session settings on the pool.
  for (let at = 0; at < ids.length; at += 4) {
    const batch = await Promise.all(
      ids.slice(at, at + 4).map((id) =>
        sessions.create({
          subjectType: 'customer',
          subjectId: id,
          stage: 'active',
          ip: '127.0.0.1',
          userAgent: 'load',
        }),
      ),
    );
    for (const issued of batch) cookies.push(`${cookieName}=${issued.token}`);
  }

  Bun.gc(true);
  const rssBefore = process.memoryUsage().rss;
  const fdsBefore = readdirSync('/proc/self/fd').length;
  const messages: ToParent[] = [];
  const waitFor = async <K extends ToParent['type']>(type: K, timeoutMs: number) => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const found = messages.findIndex((message) => message.type === type);
      if (found >= 0) return messages.splice(found, 1)[0] as Extract<ToParent, { type: K }>;
      if (performance.now() > deadline) throw new Error(`The child did not report "${type}" within ${timeoutMs} ms`);
      await Bun.sleep(50); // real wait: polling a report of another process
    }
  };
  const worker = Bun.spawn(['bun', import.meta.path, '--child'], {
    env: { ...process.env, BUN_CONFIG_MAX_HTTP_REQUESTS: '4096' },
    stdout: 'inherit',
    stderr: 'inherit',
    ipc: (message: ToParent) => void messages.push(message),
  });

  try {
    worker.send({
      type: 'open',
      url: `http://127.0.0.1:${port}/store/v1/me/stream`,
      cookies,
    } satisfies ToChild);
    const opened = await waitFor('opened', 180_000);
    console.log(`${opened.count} streams open in ${(opened.ms / 1000).toFixed(1)} s`);
    Bun.gc(true);
    const rssOpen = process.memoryUsage().rss;
    const fdsOpen = readdirSync('/proc/self/fd').length;

    console.log(`Idle for ${idleSeconds} s...`);
    const cpuBefore = process.cpuUsage();
    const idleStart = performance.now();
    await Bun.sleep(idleSeconds * 1000); // real wait: the idle minute is what is measured
    const cpu = process.cpuUsage(cpuBefore);
    const idleCpu = ((cpu.user + cpu.system) / 1000 / (performance.now() - idleStart)) * 100;

    console.log('Sending one in-app campaign to all...');
    const admin = await adminWith(t, ['*']);
    const draft = await createDraft(admin, { channels: ['in_app'], audience: { customers: { hasAccount: true } } });
    const sent = await sendNow(admin, draft.id);
    if (sent.status !== 202) throw new Error(`send answered ${sent.status}`);
    worker.send({ type: 'mark', at: Date.now() } satisfies ToChild);
    for (let run = 0; run < 100; run++) {
      const result = await t.app.get(CampaignFanOut).run(draft.id);
      if (result.outcome !== 'continued') break;
    }
    const delivered = await waitFor('delivered', 120_000);
    const latencies = [...delivered.latencies].sort((a, b) => a - b);
    const scrape = await t.app.get(MetricsService).render();
    const drops = metricSum(scrape, 'realtime_drops_total');

    console.log('Restarting the API...');
    worker.send({ type: 'restart', at: Date.now() } satisfies ToChild);
    await t.close();
    t = await build();
    const back = await waitFor('back', 180_000);

    const perConnection = (rssOpen - rssBefore) / count;
    console.log(`
| Measure | Value | Target |
|---|---|---|
| Streams | ${count} | 2000 |
| API RSS before / with the streams | ${mb(rssBefore)} MB / ${mb(rssOpen)} MB | |
| Memory per stream | ${(perConnection / 1024).toFixed(1)} KB | at most 50 KB (100 MB in all) |
| CPU of the idle ${idleSeconds} s | ${idleCpu.toFixed(2)} % of one core | under 5 % |
| Campaign delivery p50 / p95 / p99 / max | ${percentile(latencies, 50)} / ${percentile(latencies, 95)} / ${percentile(latencies, 99)} / ${latencies.at(-1)} ms | p95 under 1 s |
| realtime_drops_total | ${drops} | 0 |
| Open descriptors before / with the streams | ${fdsBefore} / ${fdsOpen} | |
| All streams back after a restart | ${(back.ms / 1000).toFixed(1)} s | under 90 s |
`);
  } finally {
    worker.send({ type: 'stop' } satisfies ToChild);
    await worker.exited;
    await deleteBullKeys(t.app.get(RedisService).queue, prefix);
    await t.close();
    await resetDb();
    await closeTestDb();
  }
}

if (process.argv.includes('--child')) child();
else await parent();

// Bun compatibility spike runner (Phase 0). Usage: `bun run spike` with `docker compose up -d` running.
// Drives drizzle-kit, the API and the worker as real Bun processes and prints one PASS/FAIL line per check.
import { $ } from 'bun';
import { drizzle as drizzlePgJs } from 'drizzle-orm/postgres-js';
import { drizzle as drizzleBunSql } from 'drizzle-orm/bun-sql';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { SQL } from 'bun';
import { cfg } from './infra';

const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: unknown = '') =>
  results.push({ check, ok, detail: (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 220) });
const base = `http://127.0.0.1:${cfg.port}`;
const psql = (q: string) => $`docker compose exec -T postgres psql -U gsm -d gsm_test -Atc ${q}`.nothrow().quiet();

/** Starts a Bun process and collects its output lines so the runner can wait for markers. */
function start(file: string) {
  const proc = Bun.spawn(['bun', file], { stdout: 'pipe', stderr: 'pipe', env: process.env });
  const lines: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) for (const l of dec.decode(chunk).split('\n')) if (l.trim()) lines.push(prefix + l);
  };
  void pump(proc.stdout, '');
  void pump(proc.stderr, 'ERR ');
  const waitFor = async (text: string, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (lines.some((l) => l.includes(text))) return true;
      await Bun.sleep(100);
    }
    return false;
  };
  return { proc, lines, waitFor };
}

const markOrder = (lines: string[], marks: string[]) => {
  const idx = marks.map((m) => lines.findIndex((l) => l.includes(`[MARK] ${m}`)));
  return idx.every((i) => i >= 0) && idx.every((i, k) => k === 0 || i > idx[k - 1]!);
};

// 0. Clean slate: spike schemas and the spike's Redis DB 15 on both roles (old completed jobs would dedupe new ones).
await psql('DROP SCHEMA IF EXISTS spike CASCADE; DROP SCHEMA IF EXISTS spike_meta CASCADE;');
for (const svc of ['redis-queue', 'redis-cache']) await $`docker compose exec -T ${svc} redis-cli -n 15 FLUSHDB`.nothrow().quiet();
await $`rm -rf spike/bun-compat/drizzle`.quiet();

// 1. drizzle-kit under Bun.
const gen = await $`bunx --bun drizzle-kit generate --config spike/bun-compat/drizzle.config.ts`.nothrow().quiet();
record('drizzle-kit generate (bun)', gen.exitCode === 0, gen.exitCode === 0 ? 'ok' : gen.stderr.toString());
const mig = await $`bunx --bun drizzle-kit migrate --config spike/bun-compat/drizzle.config.ts`.nothrow().quiet();
record('drizzle-kit migrate (bun)', mig.exitCode === 0, mig.exitCode === 0 ? 'ok' : mig.stderr.toString() + mig.stdout.toString());

// 2. Alternative Postgres drivers (inform the driver decision; pg is exercised inside the API).
try {
  const client = postgres(cfg.databaseUrl, { max: 1 });
  const rows = await drizzlePgJs(client).execute(sql`select 1.10::numeric(18,4) as n`);
  record('driver postgres.js v4 + drizzle', true, rows);
  await client.end();
} catch (e) {
  record('driver postgres.js v4 + drizzle', false, String(e));
}
try {
  const client = new SQL(cfg.databaseUrl);
  const rows = await drizzleBunSql(client).execute(sql`select 1.10::numeric(18,4) as n`);
  record('driver bun:sql + drizzle', true, rows);
  await client.close();
} catch (e) {
  record('driver bun:sql + drizzle', false, String(e));
}

// 3. API process.
const api = start('spike/bun-compat/api.ts');
const apiReady = await api.waitFor('[MARK] api ready', 30_000);
record('nest+fastify boots under bun', apiReady, apiReady ? api.lines.find((l) => l.includes('api ready')) : api.lines.slice(-8).join(' | '));
if (apiReady) {
  const checks = (await (await fetch(`${base}/spike/checks`)).json()) as Record<string, { ok: boolean; detail: unknown }>;
  for (const [name, c] of Object.entries(checks)) record(`api: ${name}`, c.ok, c.detail);

  const doc = (await (await fetch(`${base}/openapi.json`)).json()) as any;
  const body = doc?.paths?.['/spike/jobs']?.post?.requestBody?.content?.['application/json']?.schema;
  record('swagger: openapi 3.1 + zod body schema', doc?.openapi === '3.1.0' && Boolean(body?.properties?.jobId), { openapi: doc?.openapi, body });

  const ref = await fetch(`${base}/reference`);
  const refHtml = await ref.text();
  record('scalar /reference (withFastify)', ref.status === 200 && /scalar/i.test(refHtml), `${ref.status} ${ref.headers.get('content-type')} ${refHtml.length}b`);

  const board = await fetch(`${base}/admin/queues`);
  record('bull-board fastify /admin/queues', board.status === 200 && (await board.text()).includes('<'), `${board.status}`);

  const metrics = await fetch(`${base}/metrics`);
  const mText = await metrics.text();
  record('prom-client default metrics', metrics.status === 200 && mText.includes('process_cpu_user_seconds_total'), `${metrics.status} ${mText.split('\n').length} lines`);

  const bad = await fetch(`${base}/spike/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'x' }) });
  const badBody = (await bad.json()) as any;
  record('zod validation -> 400 with field errors', bad.status === 400 && badBody?.errors?.[0]?.field === 'jobId', badBody);

  const ok = await fetch(`${base}/spike/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'long-1', ms: 4000 }) });
  record('enqueue job (BullMQ producer)', ok.status === 201, await ok.json());
  // Same deterministic jobId again: BullMQ must return the existing job, and the worker must run it only once.
  const dup = await fetch(`${base}/spike/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'long-1', ms: 4000 }) });
  record('duplicate jobId returns the same job', dup.status === 201 && ((await dup.json()) as any)?.id === 'long-1', dup.status);

  // 4. Worker: graceful shutdown while the long job is active.
  const worker = start('spike/bun-compat/worker.ts');
  const wReady = await worker.waitFor('[MARK] worker ready', 30_000);
  record('worker (nest app context + bullmq) boots', wReady, wReady ? 'ok' : worker.lines.slice(-8).join(' | '));
  const jobStarted = await worker.waitFor('[MARK] job start long-1', 15_000);
  const ticked = await worker.waitFor('[MARK] tick', 5_000);
  record('job scheduler (upsertJobScheduler every 1s)', ticked, ticked ? 'tick seen' : 'no tick');
  if (jobStarted) {
    await Bun.sleep(500);
    worker.proc.kill('SIGTERM');
    const code = await Promise.race([worker.proc.exited, Bun.sleep(20_000).then(() => 'timeout' as const)]);
    const ordered = markOrder(worker.lines, ['worker closing', 'job done long-1', 'worker closed', 'db pool closed']);
    record('worker SIGTERM: active job finishes, then connections close', ordered && code !== 'timeout', {
      exit: code,
      signal: worker.proc.signalCode,
      tail: worker.lines.filter((l) => l.includes('[MARK]') && !l.includes('tick')).slice(-6),
    });
    const row = await psql(`select count(*) from spike.jobs where job_id = 'long-1'`);
    record('job wrote its row before exit', row.stdout.toString().trim() === '1', row.stdout.toString().trim());
    const runs = worker.lines.filter((l) => l.includes('[MARK] job start long-1')).length;
    record('deduplicated job ran exactly once', runs === 1, `${runs} run(s)`);
  } else {
    record('worker SIGTERM: active job finishes, then connections close', false, worker.lines.slice(-8).join(' | '));
    worker.proc.kill('SIGKILL');
  }

  // 5. API graceful shutdown through Nest shutdown hooks.
  api.proc.kill('SIGTERM');
  const apiCode = await Promise.race([api.proc.exited, Bun.sleep(15_000).then(() => 'timeout' as const)]);
  const apiClosed = ['queue closed', 'redis closed', 'db pool closed'].every((m) => api.lines.some((l) => l.includes(`[MARK] ${m}`)));
  record('api SIGTERM: shutdown hooks close queue, redis, pool', apiClosed && apiCode !== 'timeout', { exit: apiCode, signal: api.proc.signalCode });
} else {
  api.proc.kill('SIGKILL');
}

// 6. bun test + @nestjs/testing.
const t = await $`bun test spike/bun-compat/nest.test.ts`.nothrow().quiet();
const tOut = t.stderr.toString() + t.stdout.toString();
record('bun test + @nestjs/testing + inject', t.exitCode === 0, tOut.split('\n').filter((l) => /pass|fail/i.test(l)).slice(-3).join(' '));

// Report.
const width = Math.max(...results.map((r) => r.check.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check.padEnd(width)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed on bun ${Bun.version}`);
await psql('DROP SCHEMA IF EXISTS spike CASCADE; DROP SCHEMA IF EXISTS spike_meta CASCADE;');
process.exit(failed ? 1 : 0);

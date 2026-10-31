// Prints the time one argon2id hash takes for candidate parameters (decision 007: aim for 50-150 ms on the target host).
// Usage: `bun run bench:argon2` on the machine that will run the API; pass `m,t,p` triples to try your own, for example
// `bun run bench:argon2 65536,3,1 47104,1,1`. Then set ARGON2_MEMORY_KIB, ARGON2_TIME_COST and ARGON2_PARALLELISM.
import { hash } from '@node-rs/argon2';

interface Candidate {
  readonly memoryKib: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/** The OWASP baseline and a few stronger settings around it. */
const DEFAULTS: readonly Candidate[] = [
  { memoryKib: 19_456, timeCost: 2, parallelism: 1 },
  { memoryKib: 47_104, timeCost: 1, parallelism: 1 },
  { memoryKib: 32_768, timeCost: 2, parallelism: 1 },
  { memoryKib: 65_536, timeCost: 2, parallelism: 1 },
  { memoryKib: 65_536, timeCost: 3, parallelism: 1 },
  { memoryKib: 65_536, timeCost: 3, parallelism: 2 },
  { memoryKib: 131_072, timeCost: 3, parallelism: 2 },
];
const RUNS = 7;
const TARGET_MIN_MS = 50;
const TARGET_MAX_MS = 150;

function parseCandidates(args: readonly string[]): readonly Candidate[] {
  if (args.length === 0) return DEFAULTS;
  return args.map((arg) => {
    const [memoryKib, timeCost, parallelism] = arg.split(',').map(Number);
    if (!memoryKib || !timeCost || !parallelism) throw new Error(`"${arg}" is not "memoryKib,timeCost,parallelism"`);
    return { memoryKib, timeCost, parallelism };
  });
}

async function median(candidate: Candidate): Promise<number> {
  const options = { memoryCost: candidate.memoryKib, timeCost: candidate.timeCost, parallelism: candidate.parallelism };
  await hash('warm-up password', options);
  const times: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    await hash(`bench password ${run}`, options);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}

console.log(`argon2id on Bun ${Bun.version}: median of ${RUNS} hashes, target ${TARGET_MIN_MS}-${TARGET_MAX_MS} ms\n`);
console.log('ARGON2_MEMORY_KIB  ARGON2_TIME_COST  ARGON2_PARALLELISM  median ms  verdict');
for (const candidate of parseCandidates(process.argv.slice(2))) {
  const ms = await median(candidate);
  const verdict = ms < TARGET_MIN_MS ? 'faster than needed' : ms > TARGET_MAX_MS ? 'too slow' : 'in range';
  console.log(
    `${String(candidate.memoryKib).padEnd(18)} ${String(candidate.timeCost).padEnd(17)} ${String(candidate.parallelism).padEnd(20)} ${ms.toFixed(1).padStart(9)}  ${verdict}`,
  );
}

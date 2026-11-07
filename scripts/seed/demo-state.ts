// Reads the frontend's demo state (the data its dev mock layer serves) so the seed mirrors what the console shows.
// Ports `loadDemoState`, `demoNumericId`, `toMoney` and `toIso` of the frontend's src/mocks/seed/index.ts (read-only input).
import { resolve } from 'node:path';

const DAY_MS = 86_400_000;
// A number this close to the capture time is a timestamp; the demo's other numbers (money, counts) are nowhere near.
const TIMESTAMP_WINDOW_MS = 3 * 365.25 * DAY_MS;

/** The demo state `S`: keys such as `admins`, `ipRules`, `access`. Shapes are the demo's, not the API's. */
export type DemoState = Record<string, unknown>;

/** The decoded demo state plus the clock shift that was applied to its timestamps. */
export interface DemoSeed {
  /** Every table of the demo, with timestamps already moved forward (epoch milliseconds). */
  readonly state: DemoState;
  /** Milliseconds added to each timestamp: the time since the demo was captured. */
  readonly shift: number;
  /** The "now" the demo was rebased to (the `now` option, default the real time): demo values given in days ago count back from it. */
  readonly now: number;
}

/**
 * Where the frontend repo lives (read-only input): `FRONTEND_DIR`, default `../frontend-admin` next to this repo.
 *
 * Why: the same variable the contract scripts use (`scripts/lib/manifest.mjs`); it is tooling, not application config.
 *
 * @returns the absolute path of the frontend checkout
 */
export function frontendDir(): string {
  return resolve(import.meta.dir, '../..', process.env.FRONTEND_DIR ?? '../frontend-admin');
}

/** Path of the demo state file inside the frontend repo. */
export const demoStatePath = (dir: string = frontendDir()) => resolve(dir, 'src/mocks/seed/demo-state.json');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies the JSON tree, rebuilds Sets and Maps and adds `shift` to every timestamp-like number.
 *
 * Why: the same rule as the frontend mocks, so a seeded row and the console's mock row show the same moment.
 *
 * @param value a node of the captured state
 * @param shift milliseconds to add to timestamps
 * @param capturedAt epoch milliseconds when the demo was captured
 * @returns the decoded node
 */
export function decodeDemoValue(value: unknown, shift: number, capturedAt: number): unknown {
  if (typeof value === 'number') {
    return Math.abs(value - capturedAt) <= TIMESTAMP_WINDOW_MS ? value + shift : value;
  }
  if (Array.isArray(value)) return value.map((item) => decodeDemoValue(item, shift, capturedAt));
  if (isPlainObject(value)) {
    if (Array.isArray(value.__set)) return new Set(decodeDemoValue(value.__set, shift, capturedAt) as unknown[]);
    if (Array.isArray(value.__map))
      return new Map(decodeDemoValue(value.__map, shift, capturedAt) as [unknown, unknown][]);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeDemoValue(item, shift, capturedAt)]),
    );
  }
  return value;
}

/**
 * Loads the demo state and moves its timestamps forward so the data looks fresh.
 *
 * @param options the frontend directory and the current time (both default to the real ones)
 * @returns the decoded state and the shift used
 * @throws {Error} when the file is missing (clone the frontend next to this repo or set `FRONTEND_DIR`)
 */
export async function loadDemoState(options: { dir?: string; now?: number } = {}): Promise<DemoSeed> {
  const file = Bun.file(demoStatePath(options.dir));
  if (!(await file.exists())) {
    throw new Error(
      `Demo state not found at ${file.name}. Put the frontend repo next to this one or set FRONTEND_DIR.`,
    );
  }
  const { capturedAt, state } = (await file.json()) as { capturedAt: number; state: unknown };
  const now = options.now ?? Date.now();
  const shift = now - capturedAt;
  return { state: decodeDemoValue(state, shift, capturedAt) as DemoState, shift, now };
}

/**
 * A table of the demo state as typed rows (`demoRows<DemoAdmin>(demo, 'admins')`).
 *
 * @param demo the loaded demo
 * @param key the demo table name
 * @returns the rows, or an empty list when the key is missing
 */
export function demoRows<T>(demo: DemoSeed, key: string): T[] {
  const rows = demo.state[key];
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * The numeric id behind a demo id: `'ad1'` is 1, `'m6'` is 6, `'ORD-48100'` is 48100.
 *
 * Why: the frontend mocks give rows these ids, so a console pointed at the real API sees the same ids it knew.
 *
 * @param id the demo id
 * @returns the trailing number
 * @throws {Error} when the id ends in no digits
 */
export function demoNumericId(id: string): number {
  const match = /(\d+)$/.exec(id);
  if (!match) throw new Error(`Demo id "${id}" does not end in a number.`);
  return Number(match[1]);
}

/** A number as a 4-decimal money string: 12.49 is '12.4900'. */
export function toMoney(amount: number): string {
  const text = amount.toFixed(4);
  return text === '-0.0000' ? '0.0000' : text;
}

/** An epoch in milliseconds as a `Date`; `null` and `undefined` stay `null`. */
export function toDate(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

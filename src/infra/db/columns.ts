// Column building blocks shared by every module's db/schema.ts (decisions 010, 011, 027): ids, foreign keys, money,
// rates, timestamps, JSON and enum CHECK lists. Module schemas import this file directly, never the db barrel.
import { sql, type SQL } from 'drizzle-orm';
import { bigint, integer, jsonb, numeric, text, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Primary key: `bigint generated always as identity`, read as a JS number.
 *
 * Why: decisions 010 and 027: ids are sequential numbers on the wire (`Id = number`); `generated always` stops code from
 * inventing ids (the seed uses `overridingSystemValue()` on purpose).
 *
 * @returns the column builder for `id`
 */
export const pk = () => bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();

/**
 * A plain id-like column with no foreign key: a polymorphic reference (`subject_id`, `actor_id`) or an id kept apart.
 *
 * Why: the map marks polymorphic links as `poly`; the database cannot enforce them, so the type is all they get.
 *
 * @returns the column builder (chain `.notNull()` when required)
 */
export const bigId = () => bigint({ mode: 'number' });

/**
 * A foreign key to another table's id (or to another column when `target` returns one).
 *
 * Why: decision 027: every `*_id` / `*_by` link is a `bigint` foreign key, `ON DELETE RESTRICT` unless the map implies
 * that the child dies with its parent (then pass `'cascade'`).
 *
 * @param target lazy reference, written `(): AnyPgColumn => table.id` so cyclic schemas still type-check
 * @param onDelete what happens to the child when the parent row is deleted
 * @returns the column builder (chain `.notNull()` when the link is required)
 */
export const fk = (target: () => AnyPgColumn, onDelete: 'restrict' | 'cascade' = 'restrict') =>
  bigint({ mode: 'number' }).references(target, { onDelete });

/**
 * Money: `numeric(18,4)`, read as a decimal string.
 *
 * Why: decision 011: money is never a float; the wire sends 4 fraction digits.
 *
 * @returns the column builder
 */
export const money = () => numeric({ precision: 18, scale: 4 });

/**
 * Exchange and credit rates: `numeric(18,8)`.
 *
 * Why: decision 011: FX rates need more fraction digits than money.
 *
 * @returns the column builder
 */
export const fxRate = () => numeric({ precision: 18, scale: 8 });

/**
 * Percentages and tax rates: `numeric(9,4)` (for example `15.0000`).
 *
 * Why: decision 011.
 *
 * @returns the column builder
 */
export const percent = () => numeric({ precision: 9, scale: 4 });

/**
 * A point in time: `timestamptz(3)`, read as a `Date`.
 *
 * Why: decision 027 uses `timestamptz`; milliseconds match JavaScript dates and the wire format, so a value read back
 * compares equal to the stored one (optimistic checks, cursors).
 *
 * @returns the column builder
 */
export const timestampTz = () => timestamp({ withTimezone: true, mode: 'date', precision: 3 });

/**
 * `created_at timestamptz not null default now()`.
 *
 * Why: decision 027: every table has it.
 *
 * @returns the column builder
 */
export const createdAt = () => timestampTz().notNull().defaultNow();

/**
 * `updated_at timestamptz not null default now()`, refreshed by Drizzle on every `update()`.
 *
 * Why: decision 027: mutable tables carry it (append-only tables do not).
 *
 * @returns the column builder
 */
export const updatedAt = () =>
  timestampTz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * `jsonb not null default '{}'`, typed as an object.
 *
 * Why: decision 027.
 *
 * @returns the column builder
 */
export const jsonObject = () => jsonb().$type<Record<string, unknown>>().notNull().default({});

/**
 * `jsonb not null default '[]'`, typed as a list (timelines, tiers, signals).
 *
 * Why: decision 027 defaults jsonb to `{}`; columns that hold a list override it with `[]`.
 *
 * @returns the column builder
 */
export const jsonList = () => jsonb().$type<unknown[]>().notNull().default([]);

/**
 * `text[] not null default '{}'`.
 *
 * Why: decision 027 (`text[]` columns such as permissions, scopes, events).
 *
 * @returns the column builder
 */
export const textList = () => text().array().notNull().default([]);

/**
 * `bigint[] not null default '{}'`, read as numbers (file ids, group ids).
 *
 * Why: decision 027 (`*_ids` columns); the database cannot enforce array elements as foreign keys.
 *
 * @returns the column builder
 */
export const bigintList = () => bigint({ mode: 'number' }).array().notNull().default([]);

/**
 * `integer[] not null default '{}'`.
 *
 * Why: decision 027 (`int[]` columns such as `services.qty_options`).
 *
 * @returns the column builder
 */
export const intList = () => integer().array().notNull().default([]);

/**
 * `lower(column)` for case-insensitive unique indexes (emails, usernames, codes).
 *
 * Why: the map wants lower-cased uniqueness without forcing the stored text to a case.
 *
 * @param column the text column
 * @returns the SQL expression to index
 */
export const lower = (column: AnyPgColumn): SQL => sql`lower(${column})`;

/**
 * `column IN ('a', 'b', ...)` for the CHECK constraint of an enumeration column.
 *
 * Why: decision 027: enumerations are `text` + CHECK, generated from the same `as const` array as the TypeScript type.
 *
 * @param column the enumeration column
 * @param values the allowed values; they are written into DDL, so they must not contain a quote
 * @returns the CHECK expression
 * @throws {Error} when a value contains a single quote
 */
export function inList(column: AnyPgColumn, values: readonly string[]): SQL {
  for (const value of values) {
    if (value.includes("'")) throw new Error(`Enumeration value ${JSON.stringify(value)} must not contain a quote`);
  }
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`;
}

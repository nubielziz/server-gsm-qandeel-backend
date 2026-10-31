// zod -> JSON Schema 2020-12 (the dialect of OpenAPI 3.1, decision 008), cleaned for @nestjs/swagger documents.
// Strips `$schema` and the very long ISO `pattern` that zod adds next to `format: date-time` / `date`.
import { z } from 'zod';

/** A JSON Schema object as plain data. */
export type JsonSchema = Record<string, unknown>;

function clean(node: unknown, isRoot: boolean): unknown {
  if (Array.isArray(node)) return node.map((item) => clean(item, false));
  if (node === null || typeof node !== 'object') return node;
  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const hasIsoFormat = source.format === 'date-time' || source.format === 'date';
  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema' && isRoot) continue;
    // The pattern repeats what `format` already says and fills the docs with a 600-character regular expression.
    if (key === 'pattern' && hasIsoFormat) continue;
    result[key] = clean(value, false);
  }
  return result;
}

/**
 * Converts a zod schema to a JSON Schema for OpenAPI 3.1.
 *
 * Why: one zod schema feeds validation, types and documentation (decision 008). `io: 'input'` describes what a
 * client sends (before transforms such as path ids), `io: 'output'` what the API returns.
 *
 * @param schema the zod schema
 * @param io which side of the schema to describe
 * @returns the JSON Schema without `$schema` and without redundant ISO patterns
 */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' });
  return clean(raw, true) as JsonSchema;
}

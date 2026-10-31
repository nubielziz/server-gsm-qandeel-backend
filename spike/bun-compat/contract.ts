// Bun compatibility spike: one zod contract feeds validation, TypeScript types and OpenAPI (no nestjs-zod).
// Proves z.toJSONSchema output is accepted by @nestjs/swagger and rendered by Scalar.
import {
  applyDecorators,
  BadRequestException,
  type ArgumentMetadata,
  type PipeTransform,
  UsePipes,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';

/** A route contract: request parts and responses, each a zod schema. */
export interface RouteContract {
  summary: string;
  body?: z.ZodType;
  query?: z.ZodType;
  responses: Record<number, { description: string; schema?: z.ZodType; example?: unknown }>;
}

/** zod -> JSON Schema 2020-12 (the dialect OpenAPI 3.1 uses). */
const toSchema = (s: z.ZodType, io: 'input' | 'output') =>
  z.toJSONSchema(s, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Record<string, unknown>;

/** Validates body/query against the contract; a failure becomes a 400 with field errors. */
class ContractPipe implements PipeTransform {
  constructor(private readonly contract: RouteContract) {}
  transform(value: unknown, meta: ArgumentMetadata) {
    const schema = meta.type === 'body' ? this.contract.body : meta.type === 'query' ? this.contract.query : undefined;
    if (!schema) return value;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), code: i.code, message: i.message })),
    });
  }
}

/** One decorator per route: OpenAPI metadata + validation, both derived from the same contract. */
export function Route(contract: RouteContract) {
  const decorators = [ApiOperation({ summary: contract.summary }), UsePipes(new ContractPipe(contract))];
  if (contract.body) decorators.push(ApiBody({ schema: toSchema(contract.body, 'input') as never }));
  for (const [status, r] of Object.entries(contract.responses)) {
    decorators.push(
      ApiResponse({
        status: Number(status),
        description: r.description,
        ...(r.schema ? { schema: toSchema(r.schema, 'output') as never } : {}),
        ...(r.example ? { example: r.example } : {}),
      }),
    );
  }
  return applyDecorators(...decorators);
}

export const CreateJobBody = z.object({
  jobId: z.string().min(3).max(64).describe('Deterministic job id (dedupes retries)'),
  ms: z.number().int().min(0).max(10_000).default(3000),
});
export type CreateJobBody = z.infer<typeof CreateJobBody>;
export const CreateJobResponse = z.object({ id: z.string() });

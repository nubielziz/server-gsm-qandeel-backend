// Route contracts of the TAC catalog (map domain B, stage 14, routes /admin/tac-catalog): the brand and model behind the first
// 8 digits of an IMEI. Shapes match the console's `TacEntry` (docs/contract/endpoints/catalog.md, resolutions catalog-7 and -8).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam } from '../../../common/contract';

/** A TAC entry on the wire. */
export const TacEntrySchema = z.object({
  id: zId,
  tac: z.string().describe('The first 8 digits of an IMEI.'),
  brand: z.string(),
  model: z.string().describe('The model code, such as A2633.'),
  marketingName: z.string().describe('`""` when none.'),
  releaseYear: z.number().int().describe('0 when the year is unknown (the console shows it as a dash).'),
  source: z.string().describe('Where the entry came from: `manual` for the console, `import` for a bulk load.'),
});

const TacField = z
  .string()
  .trim()
  .regex(/^\d{8}$/, 'Enter exactly 8 digits.');
const BrandField = z.string().trim().min(1, 'Enter the brand.').max(80, 'Use at most 80 characters.');
const ModelField = z.string().trim().min(1, 'Enter the model code.').max(80, 'Use at most 80 characters.');
const MarketingNameField = z.string().trim().max(120, 'Use at most 120 characters.');

const sample = {
  id: 1,
  tac: '35389011',
  brand: 'Apple',
  model: 'A2633',
  marketingName: 'iPhone 13',
  releaseYear: 2021,
  source: 'import',
} as const;

/** `GET /admin/tac-catalog`. */
export const listTacEntries = defineRoute({
  key: 'GET /admin/tac-catalog',
  summary: 'TAC catalog',
  description:
    'Brand and model for each IMEI prefix. `q` finds a prefix (typed digits), a brand, a model code or a marketing name; the ' +
    '`brand` filter is exact. Sort by `tac` (default), `brand`, `model` or `releaseYear` (an unknown year counts as 0).',
  tags: ['tac-catalog'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:read',
  query: listQuery({
    sorts: ['tac', 'brand', 'model', 'releaseYear'],
    defaultSort: { field: 'tac', order: 'asc' },
    filters: { brand: { type: 'string', ops: ['eq'] } },
    search: ['tac', 'brand', 'model', 'marketingName'],
  }),
  success: { status: 200, schema: TacEntrySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [sample] },
});

/** `GET /admin/tac-catalog/:id`. */
export const getTacEntry = defineRoute({
  key: 'GET /admin/tac-catalog/:id',
  summary: 'One TAC entry',
  tags: ['tac-catalog'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: TacEntrySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: sample },
});

/** `POST /admin/tac-catalog`. */
export const createTacEntry = defineRoute({
  key: 'POST /admin/tac-catalog',
  summary: 'Add a TAC entry',
  description:
    'Adds a TAC (exactly 8 digits) with its brand and model code; `marketingName` and `releaseYear` (a 4-digit year from 1990 to ' +
    'next year) are optional. The source is `manual`. `409 TAC_TAKEN` (on `tac`) when the prefix is already in the catalog. Audited.',
  tags: ['tac-catalog'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:create',
  body: z.object({
    tac: TacField,
    brand: BrandField,
    model: ModelField,
    marketingName: MarketingNameField.optional(),
    releaseYear: z.number().int().optional(),
  }),
  success: { status: 201, schema: TacEntrySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'TAC_TAKEN'],
  examples: {
    request: { tac: '35389011', brand: 'Apple', model: 'A2633', marketingName: 'iPhone 13', releaseYear: 2021 },
    response: { ...sample, source: 'manual' },
  },
});

/** `PATCH /admin/tac-catalog/:id`. */
export const updateTacEntry = defineRoute({
  key: 'PATCH /admin/tac-catalog/:id',
  summary: 'Correct a TAC entry',
  description:
    'Changes the fields sent. The `tac` itself is editable only while no IMEI check uses the old one (`422` on `tac` otherwise: ' +
    'add a new entry for the new TAC instead); a TAC another entry has is `409 TAC_TAKEN`. `brand` and `model` cannot be emptied, ' +
    'and a year cannot be cleared. Audited with the old and new values.',
  tags: ['tac-catalog'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    tac: TacField.optional(),
    brand: BrandField.optional(),
    model: ModelField.optional(),
    marketingName: MarketingNameField.optional(),
    releaseYear: z.number().int().optional(),
  }),
  success: { status: 200, schema: TacEntrySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'TAC_TAKEN'],
  examples: { request: { marketingName: 'iPhone 13 (128 GB)' }, response: sample },
});

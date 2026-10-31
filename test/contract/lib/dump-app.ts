// Child process of the contract tests: boots the real API once and writes what it serves and promises (route
// contracts as JSON Schema, events, Fastify's route table) to the file named by argv[2].
// Why a child: bun runs every test file in one process, and other tests register fixture contracts (`/t/...`) in the
// process-wide registry; a fresh process sees exactly the contracts the application defines (decision 009).
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import {
  contractRegistry,
  eventRegistry,
  isListQuerySchema,
  parseRouteKey,
  toJsonSchema,
} from '../../../src/common/contract';
import { DOCUMENTATION_ROUTES } from '../../../src/modules/platform';
import { createTestApp } from '../../support/app';
import type { AppSnapshot, RouteSnapshot } from './snapshot';

const out = process.argv[2];
if (!out) throw new Error('usage: bun dump-app.ts <output file>');

const served = new Set<string>();
const t = await createTestApp({
  onRoute: (route) => {
    for (const method of [route.method].flat()) {
      // Fastify adds HEAD for every GET and the CORS plugin answers OPTIONS: neither is a route of ours.
      if (method !== 'HEAD' && method !== 'OPTIONS') served.add(`${method} ${route.url}`);
    }
  },
});

const contracts: RouteSnapshot[] = contractRegistry.all().map((contract) => ({
  key: contract.key,
  method: contract.method,
  path: contract.path,
  pathParams: parseRouteKey(contract.key).paramNames,
  surface: contract.surface,
  access: contract.access,
  permission: contract.permission,
  errors: [...contract.errors],
  success: {
    status: contract.success.status,
    alsoStatuses: [...contract.success.alsoStatuses],
    contentType: contract.success.contentType,
    list: contract.success.list,
    schema: contract.success.schema ? toJsonSchema(contract.success.schema, 'output') : undefined,
  },
  params: contract.params ? toJsonSchema(contract.params, 'input') : undefined,
  // The list dialect is checked through the list contract itself, not as a JSON Schema.
  query: contract.query && !isListQuerySchema(contract.query) ? toJsonSchema(contract.query, 'input') : undefined,
  queryIsList: contract.success.list,
  body: contract.body ? toJsonSchema(contract.body, 'input') : undefined,
}));

const snapshot: AppSnapshot = {
  contracts,
  events: eventRegistry.all().map((event) => ({
    key: event.key,
    name: event.name,
    payload: toJsonSchema(event.payload, 'output'),
  })),
  served: [...served].sort(),
  documentationRoutes: [...DOCUMENTATION_ROUTES],
};
writeFileSync(out, JSON.stringify(snapshot));
await t.close();
process.exit(0);

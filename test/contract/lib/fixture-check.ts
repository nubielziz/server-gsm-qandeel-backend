// Checks a harvested fixture against the response schema of a built route (docs/contract/TESTS.md § 2, "Fixtures").
import type Ajv2020 from 'ajv/dist/2020';
import type { Finding } from './compare-route';
import type { Fixture } from './inputs';
import type { RouteSnapshot } from './snapshot';

/**
 * Writes an ajv instance path the way the comparator writes paths.
 *
 * Why: allowlist entries and failure lines name `data[].status`, not `/0/status`.
 *
 * @param instancePath an ajv `instancePath` (`/0/status`, `/checks/postgres`)
 * @param list true when the schema was a list of rows, so the root is `data`
 * @returns the dotted path with `[]` for array items
 */
export function fixturePath(instancePath: string, list: boolean): string {
  const parts = instancePath
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const joined = parts
    .map((part, index) => (/^\d+$/.test(part) ? '[]' : index === 0 ? part : `.${part}`))
    .join('')
    .replaceAll('.[]', '[]');
  return list ? `data${joined}` : joined;
}

/**
 * Validates the fixture of a route against the route's response schema.
 *
 * Why: the fixture is what the console's mock layer answers, so a schema that rejects it would break the console; a list
 * fixture must also carry `x-total-count` (ALIGNMENT § 2).
 *
 * @param contract the built route
 * @param fixture the route's harvested fixture, or undefined when none was harvested (nothing to check)
 * @param ajv a validator from `createValidator()`
 * @returns one `fixture` finding per problem; empty when the fixture fits
 */
export function fixtureFindings(contract: RouteSnapshot, fixture: Fixture | undefined, ajv: Ajv2020): Finding[] {
  if (!fixture || !contract.success.schema) return [];
  const found: Finding[] = [];
  const add = (path: string, message: string) =>
    found.push({ route: contract.key, part: 'fixture', path, rule: 'fixture', severity: 'error', message });
  if (fixture.status < 200 || fixture.status > 299) {
    add('status', `the fixture was harvested with status ${fixture.status}; re-run the harvest`);
    return found;
  }
  const list = contract.success.list;
  const validate = ajv.compile(list ? { type: 'array', items: contract.success.schema } : contract.success.schema);
  if (!validate(fixture.body)) {
    for (const error of validate.errors ?? []) {
      found.push({
        route: contract.key,
        part: 'fixture',
        path: fixturePath(error.instancePath, list),
        rule: 'fixture',
        severity: 'error',
        message: `fixture ${error.message ?? 'is not valid'}`,
      });
    }
  }
  if (list && !/^\d+$/.test(fixture.headers['x-total-count'] ?? '')) {
    add('x-total-count', 'a list fixture needs the x-total-count header');
  }
  return found;
}

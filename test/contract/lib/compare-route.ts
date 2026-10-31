// Compares one frontend function with one route contract (response, request, success status): the unit of
// shape-parity.test.ts. It only maps the snapshot and the extraction onto the comparator's inputs.
import type { Difference } from './compare';
import { compareRequest, compareResponse } from './compare-http';
import type { FrontendEndpoint } from './inputs';
import type { RouteSnapshot } from './snapshot';

/** Which part of the exchange a difference belongs to; allowlist entries name it (default `response`). */
export type Part = 'response' | 'request' | 'status' | 'fixture';

/** A difference found on one route. */
export interface Finding extends Difference {
  readonly route: string;
  readonly part: Part;
}

/**
 * Compares the frontend function of a route with the route's contract.
 *
 * Why: decision 009: the shapes the console reads and sends, and the success status it is promised, must match what
 * the backend declares.
 *
 * @param endpoint the frontend function from `frontend-endpoints.json`
 * @param contract the route as the application defines it
 * @param expectedStatus the success status the frontend contract documents (extraction `successStatus`)
 * @returns every difference, errors and infos
 */
export function compareRoute(endpoint: FrontendEndpoint, contract: RouteSnapshot, expectedStatus: number): Finding[] {
  const route = contract.key;
  const response = compareResponse(
    { returns: endpoint.returns, returnsText: endpoint.returnsText },
    {
      status: contract.success.status,
      schema: contract.success.schema,
      contentType: contract.success.contentType,
      list: contract.success.list,
    },
    expectedStatus,
  );
  const request = compareRequest(endpoint.params, {
    pathParams: contract.pathParams,
    params: contract.params,
    query: contract.query,
    queryIsList: contract.queryIsList,
    body: contract.body,
  });
  return [
    ...response.map((diff): Finding => ({ ...diff, route, part: diff.rule === 'status' ? 'status' : 'response' })),
    ...request.map((diff): Finding => ({ ...diff, route, part: 'request' })),
  ];
}

/**
 * Writes a finding as one line.
 *
 * @param finding a finding
 * @returns `GET /admin/orders [response] data[].status: backend value ... (enum)`
 */
export function describeFinding(finding: Finding): string {
  const where = finding.path === '' ? '(root)' : finding.path;
  return `${finding.route} [${finding.part}] ${where}: ${finding.message} (${finding.rule})`;
}

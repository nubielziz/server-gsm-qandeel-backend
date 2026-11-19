// Unit tests of the Typesense client against a fake server (feature 29, plan section 3.4 and step 0): every import line parsed, a 200
// with failed lines, a failed sub-search in a 200, malformed bodies, the status mapping, timeouts, and the options it passes.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type HttpResult, httpRequest } from '@src/infra/http/http-request';
import type { OutboundRequestOptions } from '@src/infra/http';
import { SearchNotReady, SearchRejected, SearchUnavailable } from '@src/infra/search/search-errors';
import { TypesenseClient } from '@src/infra/search/typesense-client';
import { expectRejection } from '../../../support/rejection';

type Handler = (request: Request) => Response | Promise<Response>;
let handler: Handler = () => new Response('{}');
let server: ReturnType<typeof Bun.serve>;
const calls: OutboundRequestOptions[] = [];

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
});
afterAll(async () => {
  await server.stop(true);
});

function client(): TypesenseClient {
  const transport = {
    request: (options: OutboundRequestOptions): Promise<HttpResult> => {
      calls.push(options);
      return httpRequest(options);
    },
  };
  return new TypesenseClient(transport, {
    url: `http://127.0.0.1:${server.port}`,
    apiKey: 'secret-key',
    searchTimeoutMs: 300,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TypesenseClient', () => {
  it('sends the key as a header only, on the private network, with an explicit timeout', async () => {
    let key = '';
    let url = '';
    handler = (request) => {
      key = request.headers.get('x-typesense-api-key') ?? '';
      url = request.url;
      return json({ found: 0, hits: [] });
    };
    calls.length = 0;
    await client().search('p_services_v1', { q: 'frp', query_by: 'title' });
    expect<string>(key).toBe('secret-key');
    expect(new URL(url).searchParams.get('q')).toBe('frp');
    expect(new URL(url).search).not.toContain('secret-key');
    expect(calls[0]).toMatchObject({ allowPrivateNetwork: true, timeoutMs: 300, target: 'search' });
  });

  it('parses every import line and maps a refused line to its document by position', async () => {
    let body = '';
    handler = async (request) => {
      body = await request.text();
      return new Response(
        '{"success":true}\n{"code":400,"error":"Field `in_stock` must be a bool.","success":false}\n{"success":true}\n',
      );
    };
    const outcome = await client().importJsonl('p_services_v1', [{ id: '1' }, { id: '2' }, { id: '3' }], 'upsert');
    expect(outcome).toEqual({
      ok: false,
      imported: 2,
      failed: [{ id: '2', error: 'Field `in_stock` must be a bool.' }],
    });
    expect(body.split('\n')).toHaveLength(3);
    expect(calls.at(-1)).toMatchObject({ timeoutMs: 120_000 });
  });

  it('treats an import answer with a different line count, or a line refused for disk, as unavailable', async () => {
    handler = () => new Response('{"success":true}\n');
    await expectRejection(client().importJsonl('c', [{ id: '1' }, { id: '2' }], 'upsert'), SearchUnavailable);
    handler = () =>
      new Response(
        '{"code":422,"error":"Rejecting write: running out of resource type: OUT_OF_DISK","success":false}\n',
      );
    const error = await client()
      .importJsonl('c', [{ id: '1' }], 'upsert')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchUnavailable);
    expect((error as SearchUnavailable).kind).toBe('resources');
  });

  it('fails the whole multi-search when one entry failed in a 200, or when an entry is malformed', async () => {
    handler = () =>
      json({
        results: [
          { found: 1, hits: [{ document: { id: '3' } }] },
          { code: 404, error: 'Collection not found' },
        ],
      });
    await expectRejection(
      client().multiSearch([
        { collection: 'a', q: 'x' },
        { collection: 'b', q: 'x' },
      ]),
      SearchNotReady,
    );
    handler = () => json({ results: [{ code: 404, error: 'Could not find a field named `nope` in the schema.' }] });
    await expectRejection(client().multiSearch([{ collection: 'a', q: 'x' }]), SearchRejected);
    handler = () => json({ results: [{ found: 'many', hits: [] }] });
    await expectRejection(client().multiSearch([{ collection: 'a', q: 'x' }]), SearchUnavailable);
    handler = () => json({ results: [] });
    await expectRejection(client().multiSearch([{ collection: 'a', q: 'x' }]), SearchUnavailable);
    handler = () => json({ results: [{ found: 2, hits: [{ document: { id: '1' } }, { document: { id: '2' } }] }] });
    const [result] = await client().multiSearch([{ collection: 'a', q: 'x' }]);
    expect(result?.hits.map((hit) => hit.document.id)).toEqual(['1', '2']);
  });

  it('maps the statuses: 503 server, 401 auth, a 422 disk refusal resources, 404 not ready, other 4xx rejected', async () => {
    const kindOf = async (response: () => Response) => {
      handler = response;
      return client()
        .createCollection({ name: 'c', fields: [] })
        .catch((error: unknown) => error);
    };
    expect(((await kindOf(() => json({ message: 'Not Ready or Lagging' }, 503))) as SearchUnavailable).kind).toBe(
      'server',
    );
    const auth = (await kindOf(() => json({ message: 'Forbidden' }, 401))) as SearchUnavailable;
    expect(auth.kind).toBe('auth');
    expect(auth.message).not.toContain('secret-key');
    expect(
      (
        (await kindOf(() =>
          json({ message: 'Rejecting write: running out of resource type: OUT_OF_DISK' }, 422),
        )) as SearchUnavailable
      ).kind,
    ).toBe('resources');
    expect(await kindOf(() => json({ message: 'Collection not found' }, 404))).toBeInstanceOf(SearchNotReady);
    const rejected = await kindOf(() => json({ message: 'A collection with name `c` already exists.' }, 409));
    expect(rejected).toBeInstanceOf(SearchRejected);
    expect((rejected as SearchRejected).status).toBe(409);
  });

  it('treats a body that is not JSON as unavailable, and a timeout or a closed port as unavailable', async () => {
    handler = () => new Response('<html>proxy error</html>');
    await expectRejection(client().health(), SearchUnavailable);
    handler = async () => {
      await Bun.sleep(600); // real wait: the fake server answers after the client's 300 ms timeout
      return json({ found: 0, hits: [] });
    };
    const timeout = (await client()
      .search('c', { q: 'x' })
      .catch((error: unknown) => error)) as SearchUnavailable;
    expect(timeout.kind).toBe('timeout');
    const closed = new TypesenseClient(
      { request: (options) => httpRequest(options) },
      {
        url: 'http://127.0.0.1:1',
        apiKey: 'k',
        searchTimeoutMs: 300,
      },
    );
    expect(((await closed.health().catch((error: unknown) => error)) as SearchUnavailable).kind).toBe('network');
  });

  it('reads the resource error of /health, an alias that does not exist, and exports with a large size limit', async () => {
    handler = () => json({ ok: true, resource_error: 'OUT_OF_DISK' });
    expect(await client().health()).toEqual({ ok: true, resourceError: 'OUT_OF_DISK' });
    handler = () => json({ message: 'Not Found' }, 404);
    expect(await client().getAlias('p_services_v1')).toBeNull();
    handler = () => new Response('{"id":"1","hash":"a"}\n{"id":"2","hash":"b"}\n');
    calls.length = 0;
    expect(await client().exportFields('p_services_v1', ['id', 'hash'])).toEqual([
      { id: '1', hash: 'a' },
      { id: '2', hash: 'b' },
    ]);
    expect(calls[0]).toMatchObject({ maxResponseBytes: 64 * 1024 * 1024, timeoutMs: 60_000 });
  });

  it('deletes by id in batches of 250 and refuses an id a filter cannot carry', async () => {
    const filters: string[] = [];
    handler = (request) => {
      filters.push(new URL(request.url).searchParams.get('filter_by') ?? '');
      return json({ num_deleted: 1 });
    };
    const ids = Array.from({ length: 600 }, (_, i) => String(i + 1));
    expect(await client().deleteByIds('c', ids)).toBe(3);
    expect(filters).toHaveLength(3);
    expect(filters[0]).toStartWith('id:[1,2,');
    await expectRejection(client().deleteByIds('c', ['1]||x']), SearchRejected);
  });
});

// The fake Dhru supplier against the supplier call contracts (feature 6b, decision 026): every answer it gives passes the answer schema of its
// call, a refusal passes the error shape, and what the driver sends passes the parameters schema. No database: the driver talks to the fake over HTTP.
import { afterAll, describe, expect, it } from 'bun:test';
import { supplierCallRegistry } from '../../src/common/contract';
import {
  type DriverContext,
  type DriverHttp,
  DhruDriver,
} from '../../src/modules/suppliers/application/supplier-driver';
import {
  getOrderCall,
  placeOrderCall,
  serviceListCall,
  accountInfoCall,
} from '../../src/modules/suppliers/contracts/supplier-calls.contracts';
import {
  DHRU_ACTIONS,
  type DhruAction,
  dhruEndpoint,
  dhruRequestBody,
} from '../../src/modules/suppliers/domain/dhru-protocol';
import { FakeDhruSupplier } from '../support/suppliers';

const fake = new FakeDhruSupplier();
afterAll(() => fake.stop());

/** A stand-in for OutboundHttp that posts to the fake with fetch: the driver sees a real HTTP answer. */
const http: DriverHttp = {
  async request(options) {
    const started = performance.now();
    const response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: new TextEncoder().encode(text),
      durationMs: performance.now() - started,
      text: () => text,
      json: <T>() => JSON.parse(text) as T,
    };
  },
};
const context = (overrides: Partial<DriverContext> = {}): DriverContext => ({
  baseUrl: fake.url,
  username: fake.username,
  apiKey: fake.apiKey,
  timeoutMs: 2000,
  policy: {},
  ...overrides,
});
const driver = new DhruDriver(http);

/** Posts one raw Dhru call to the fake and returns the JSON body. */
async function raw(action: DhruAction, parameters?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(dhruEndpoint(fake.url), {
    method: 'POST',
    body: dhruRequestBody({
      username: fake.username,
      apiKey: fake.apiKey,
      action,
      ...(parameters ? { parameters } : {}),
    }),
  });
  return await response.json();
}

describe('the fake supplier answers every call in the shape of its contract', () => {
  it('accountinfo, imeiservicelist, placeimeiorder and getimeiorder pass the answer schema of the call', async () => {
    fake.reset();
    const place = await raw(DHRU_ACTIONS.placeOrder, { ID: '4411', QNT: 1 });
    const reference = ((place as { SUCCESS: Array<{ REFERENCEID: string }> }).SUCCESS[0] ?? { REFERENCEID: '' })
      .REFERENCEID;
    expect(placeOrderCall.answer.safeParse(place).success).toBe(true);
    expect(accountInfoCall.answer.safeParse(await raw(DHRU_ACTIONS.accountInfo)).success).toBe(true);
    expect(serviceListCall.answer.safeParse(await raw(DHRU_ACTIONS.serviceList)).success).toBe(true);
    expect(getOrderCall.answer.safeParse(await raw(DHRU_ACTIONS.getOrder, { ID: reference })).success).toBe(true);
  });

  it('refuses with the error shape of the contract: a wrong credential, a scripted refusal, an unknown order', async () => {
    fake.reset();
    const bad = await (
      await fetch(dhruEndpoint(fake.url), {
        method: 'POST',
        body: dhruRequestBody({ username: fake.username, apiKey: 'wrong', action: DHRU_ACTIONS.accountInfo }),
      })
    ).json();
    expect(bad).toMatchObject({ ERROR: [{ MESSAGE: 'Authentication Failed' }] });
    expect(accountInfoCall.answer.safeParse(bad).success).toBe(true);
    expect(accountInfoCall.success.safeParse(bad).success).toBe(false);

    fake.place({ refuse: 'Not enough credits' });
    const refused = await raw(DHRU_ACTIONS.placeOrder, { ID: '4411', QNT: 1 });
    expect(placeOrderCall.answer.safeParse(refused).success).toBe(true);
    expect(placeOrderCall.error.safeParse((refused as { ERROR: unknown[] }).ERROR[0]).success).toBe(true);

    const unknown = await raw(DHRU_ACTIONS.getOrder, { ID: 'nope' });
    expect(getOrderCall.answer.safeParse(unknown).success).toBe(true);
  });

  it('keeps every status the fake can report readable: running 0 and 1, rejected 3, completed 4', async () => {
    fake.reset();
    const placed = await driver.placeOrder(context(), {
      remoteServiceId: '4411',
      input: null,
      quantity: 1,
      customFields: {},
    });
    if (!placed.ok) throw new Error(placed.message);
    const expected = { 0: 'running', 1: 'running', 3: 'rejected', 4: 'completed' } as const;
    for (const [status, state] of Object.entries(expected)) {
      fake.finish(placed.value.reference, Number(status) as 0 | 1 | 3 | 4, status === '4' ? 'Unlocked' : '');
      const call = await driver.getOrder(context(), placed.value.reference);
      expect(call, status).toMatchObject({ ok: true, value: { state } });
    }
  });
});

describe('what the driver sends passes the parameter schemas of the contracts', () => {
  it('placeimeiorder: the service, the IMEI, the quantity and the custom fields (decoded as the fake decodes them)', async () => {
    fake.reset();
    const call = await driver.placeOrder(context(), {
      remoteServiceId: '4412',
      input: '352905112490861',
      quantity: 3,
      customFields: { AccountUser: 'ali' },
    });
    expect(call.ok).toBe(true);
    const [sent] = fake.callsOf(DHRU_ACTIONS.placeOrder);
    expect(sent?.parameters).toEqual({
      ID: '4412',
      IMEI: '352905112490861',
      QNT: 3,
      CUSTOMFIELD: { AccountUser: 'ali' },
    });
    expect(placeOrderCall.params.safeParse(sent?.parameters).success).toBe(true);
  });

  it('placeimeiorder without an input or custom fields leaves both out, and getimeiorder sends the reference as ID', async () => {
    fake.reset();
    const placed = await driver.placeOrder(context(), {
      remoteServiceId: '4411',
      input: null,
      quantity: 1,
      customFields: {},
    });
    if (!placed.ok) throw new Error(placed.message);
    await driver.getOrder(context(), placed.value.reference);
    const [place] = fake.callsOf(DHRU_ACTIONS.placeOrder);
    const [get] = fake.callsOf(DHRU_ACTIONS.getOrder);
    expect(place?.parameters).toEqual({ ID: '4411', QNT: 1 });
    expect(placeOrderCall.params.safeParse(place?.parameters).success).toBe(true);
    expect(get?.parameters).toEqual({ ID: placed.value.reference });
    expect(getOrderCall.params.safeParse(get?.parameters).success).toBe(true);
  });

  it('accountinfo and imeiservicelist send no parameters, as their contracts say', async () => {
    fake.reset();
    await driver.accountInfo(context());
    await driver.serviceList(context());
    expect(fake.callsOf(DHRU_ACTIONS.accountInfo)[0]?.parameters).toEqual({});
    expect(fake.callsOf(DHRU_ACTIONS.serviceList)[0]?.parameters).toEqual({});
    expect(accountInfoCall.params).toBeUndefined();
    expect(serviceListCall.params).toBeUndefined();
  });

  it('sends only actions that have a contract, and never a bulk action', async () => {
    fake.reset();
    await driver.accountInfo(context());
    await driver.serviceList(context());
    const placed = await driver.placeOrder(context(), {
      remoteServiceId: '4411',
      input: null,
      quantity: 1,
      customFields: {},
    });
    if (placed.ok) await driver.getOrder(context(), placed.value.reference);
    expect(fake.calls.length).toBe(4);
    for (const call of fake.calls) {
      const contract = supplierCallRegistry.forAction(call.action);
      expect(contract, call.action).toBeDefined();
      expect(contract?.action).toBe(call.action);
      expect(contract?.sendsBulk).toBe(false);
    }
  });
});

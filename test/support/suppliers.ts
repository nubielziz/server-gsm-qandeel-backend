// Helpers for the suppliers tests (feature 6): a fake Dhru Fusion supplier served by a local Bun server (it speaks the protocol of
// decision 026 and records every call), the test policy that lets the supplier client reach it over plain http, and rows for a supplier
// that points at it, with its services and links.
import { Global, Module } from '@nestjs/common';
import { type Database, schema as s } from '../../src/infra/db';
import { EncryptionService } from '../../src/infra/crypto';
import { SUPPLIER_TARGET_POLICY, type SupplierTargetPolicy } from '../../src/modules/suppliers';

/** One call the fake supplier received. */
export interface FakeCall {
  readonly action: string;
  readonly username: string;
  readonly apiKey: string;
  /** The decoded `parameters` (with `CUSTOMFIELD` decoded too). */
  readonly parameters: Record<string, unknown>;
}

/** How the fake answers the next `placeimeiorder`. */
export type PlaceScript =
  | 'accept'
  /** The supplier runs the order and never answers: the caller times out although the order exists at the supplier. */
  | 'accept-then-hang'
  | { readonly refuse: string }
  | { readonly http: number }
  | 'garbage';

/** One order the fake supplier holds. */
export interface FakeOrder {
  readonly reference: string;
  readonly parameters: Record<string, unknown>;
  status: 0 | 1 | 3 | 4;
  code: string;
}

/** One service the fake lists. */
export interface FakeService {
  readonly id: string;
  readonly group: string;
  readonly type: string;
  readonly name: string;
  credit: string;
  readonly time: string;
}

const DEFAULT_SERVICES: FakeService[] = [
  { id: '4411', group: 'Carrier unlock', type: 'IMEI', name: 'AT&T USA Premier', credit: '13.5000', time: '1-2 hours' },
  { id: '4412', group: 'Server tools', type: 'SERVER', name: 'Chimera 1 month', credit: '19.8000', time: 'Instant' },
  { id: '4413', group: 'Credits', type: 'Credits', name: 'Octoplus Credits x25', credit: '2.5000', time: '2 hours' },
];

/**
 * A local HTTP server that plays a Dhru supplier: it checks the credentials, answers the four actions of decision 026 from its own
 * state and records every call. Orders are accepted with a counting REFERENCEID and keep the STATUS the test gives them.
 */
export class FakeDhruSupplier {
  readonly calls: FakeCall[] = [];
  readonly orders = new Map<string, FakeOrder>();
  services: FakeService[] = DEFAULT_SERVICES.map((service) => ({ ...service }));
  credit = '1240.50';
  currency = 'USD';
  mail = 'ops@fake-supplier.example';
  /** Make every call answer this HTTP status (a supplier that is down), until set back to `0`. */
  forceHttp = 0;
  private readonly script: PlaceScript[] = [];
  private readonly server: ReturnType<typeof Bun.serve>;
  private nextReference = 88_100;

  constructor(
    readonly username = 'gsm-supply',
    readonly apiKey = 'fake-supplier-key-001',
  ) {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => this.handle(request),
      // A hanging call must outlive the caller's timeout without the server closing it first.
      idleTimeout: 30,
    });
  }

  /** The base URL a supplier row stores. */
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Queues the behaviour of the next `placeimeiorder` calls, in order (`accept` when the queue is empty). */
  place(...scripts: PlaceScript[]): void {
    this.script.push(...scripts);
  }

  /** The calls of one action. */
  callsOf(action: string): FakeCall[] {
    return this.calls.filter((call) => call.action === action);
  }

  /** Gives an order the status the supplier will report (4 completed with a CODE, 3 rejected with a reason, 1 running). */
  finish(reference: string, status: 0 | 1 | 3 | 4, code = ''): void {
    const order = this.orders.get(reference);
    if (!order) throw new Error(`The fake supplier has no order ${reference}.`);
    order.status = status;
    order.code = code;
  }

  /** The reference of the nth order the supplier accepted (1 based). */
  referenceOf(position: number): string {
    return [...this.orders.keys()][position - 1]!;
  }

  /** Forgets calls, orders and scripts. */
  reset(): void {
    this.calls.length = 0;
    this.orders.clear();
    this.script.length = 0;
    this.services = DEFAULT_SERVICES.map((service) => ({ ...service }));
    this.credit = '1240.50';
    this.forceHttp = 0;
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    await this.server.stop(true);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify({ ...(body as object), apiversion: '6.1' }), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  private async handle(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const action = form.get('action') ?? '';
    const parameters = this.decode(form.get('parameters'));
    this.calls.push({
      action,
      username: form.get('username') ?? '',
      apiKey: form.get('apiaccesskey') ?? '',
      parameters,
    });
    if (this.forceHttp > 0) return new Response('down', { status: this.forceHttp });
    if (form.get('username') !== this.username || form.get('apiaccesskey') !== this.apiKey) {
      return this.json({ ERROR: [{ MESSAGE: 'Authentication Failed' }] });
    }
    switch (action) {
      case 'accountinfo':
        return this.json({
          SUCCESS: [
            {
              message: 'Your Accout Info',
              AccoutInfo: { credit: this.credit, mail: this.mail, currency: this.currency },
            },
          ],
        });
      case 'imeiservicelist':
        return this.json({ SUCCESS: [{ MESSAGE: 'IMEI Service List', LIST: this.list() }] });
      case 'placeimeiorder':
        return this.place_(parameters);
      case 'getimeiorder': {
        const order = this.orders.get(String(parameters.ID));
        if (!order) return this.json({ ERROR: [{ MESSAGE: 'Order not found' }] });
        return this.json({ SUCCESS: [{ STATUS: order.status, CODE: order.code }] });
      }
      default:
        return this.json({ ERROR: [{ MESSAGE: 'Invalid Action' }] });
    }
  }

  private place_(parameters: Record<string, unknown>): Response | Promise<Response> {
    const next = this.script.shift() ?? 'accept';
    if (typeof next === 'object' && 'refuse' in next) return this.json({ ERROR: [{ MESSAGE: next.refuse }] });
    if (typeof next === 'object' && 'http' in next) return new Response('bad gateway', { status: next.http });
    if (next === 'garbage') return new Response('<html>maintenance</html>', { status: 200 });
    const reference = String(this.nextReference++);
    this.orders.set(reference, { reference, parameters, status: 1, code: '' });
    if (next === 'accept-then-hang') return new Promise<Response>(() => undefined);
    return this.json({ SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: reference }] });
  }

  private list(): Record<string, unknown> {
    const groups: Record<string, { GROUPNAME: string; GROUPTYPE: string; SERVICES: Record<string, unknown> }> = {};
    for (const service of this.services) {
      const group = (groups[service.group] ??= { GROUPNAME: service.group, GROUPTYPE: service.type, SERVICES: {} });
      group.SERVICES[service.id] = {
        SERVICEID: service.id,
        SERVICETYPE: service.type,
        SERVICENAME: service.name,
        CREDIT: service.credit,
        TIME: service.time,
        'Requires.Network': 'None',
      };
    }
    return groups;
  }

  private decode(text: string | null): Record<string, unknown> {
    if (!text) return {};
    const parameters = JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as Record<string, unknown>;
    if (typeof parameters.CUSTOMFIELD === 'string') {
      parameters.CUSTOMFIELD = JSON.parse(Buffer.from(parameters.CUSTOMFIELD, 'base64').toString('utf8'));
    }
    return parameters;
  }
}

/** The policy the tests give the supplier client: private addresses and plain http allowed (the fake runs on 127.0.0.1). */
export const testSupplierPolicy: SupplierTargetPolicy = { allowPrivateNetwork: true, httpsOnly: false };

/** Provides the test policy to the app. Import it with `createTestApp({ imports: [SupplierTestModule] })`. */
@Global()
@Module({
  providers: [{ provide: SUPPLIER_TARGET_POLICY, useValue: testSupplierPolicy }],
  exports: [SUPPLIER_TARGET_POLICY],
})
export class SupplierTestModule {}

/**
 * Inserts a supplier that points at the fake, with the fake's key stored encrypted the way the service stores it.
 *
 * @param db the test database
 * @param encryption the app's encryption service
 * @param fake the fake supplier
 * @param overrides columns to change
 * @returns the supplier id
 */
export async function insertFakeSupplier(
  db: Database,
  encryption: EncryptionService,
  fake: FakeDhruSupplier,
  overrides: Partial<typeof s.suppliers.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(s.suppliers)
    .values({
      name: `Fake Dhru ${crypto.randomUUID().slice(0, 6)}`,
      driver: 'dhru',
      baseUrl: fake.url,
      username: fake.username,
      apiKeyEnc: encryption.encrypt(fake.apiKey, 'suppliers.api_key_enc'),
      apiKeyHint: fake.apiKey.slice(0, 5),
      paramFormat: 'dhru_xml',
      timeoutMs: 1500,
      ...overrides,
    })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

/**
 * Inserts a synced supplier service and links a service to it.
 *
 * @param db the test database
 * @param serviceId the service
 * @param supplierId the supplier
 * @param options the remote id and price, the priority, the link's switch and field map
 * @returns the supplier service id and the link id
 */
export async function linkService(
  db: Database,
  serviceId: number,
  supplierId: number,
  options: {
    remoteId?: string;
    credit?: string;
    priority?: number;
    name?: string;
    isActive?: boolean;
    isAvailable?: boolean;
    fieldMap?: Record<string, string>;
    customFields?: unknown[];
    type?: string;
    group?: string;
    time?: string;
  } = {},
): Promise<{ supplierServiceId: number; linkId: number }> {
  const [remote] = await db
    .insert(s.supplierServices)
    .values({
      supplierId,
      remoteId: options.remoteId ?? '4411',
      remoteGroup: options.group ?? 'Carrier unlock',
      type: options.type ?? 'IMEI',
      name: options.name ?? 'Remote service',
      credit: options.credit ?? '13.5000',
      time: options.time ?? '1-2 hours',
      isAvailable: options.isAvailable ?? true,
      customFields: options.customFields ?? [],
    })
    .returning({ id: s.supplierServices.id });
  const [link] = await db
    .insert(s.serviceSupplierLinks)
    .values({
      serviceId,
      supplierServiceId: remote!.id,
      priority: options.priority ?? 1,
      isActive: options.isActive ?? true,
      fieldMap: options.fieldMap ?? {},
    })
    .returning({ id: s.serviceSupplierLinks.id });
  return { supplierServiceId: remote!.id, linkId: link!.id };
}

/** The log rows of a supplier, oldest first. */
export async function logsOf(db: Database, supplierId: number) {
  const { eq } = await import('drizzle-orm');
  return db
    .select()
    .from(s.supplierApiLogs)
    .where(eq(s.supplierApiLogs.supplierId, supplierId))
    .orderBy(s.supplierApiLogs.id);
}

let routeCounter = 0;

/**
 * Builds an automatic IMEI service (price 17.28, cost 13.50) whose only link goes to a new supplier that points at the fake.
 *
 * @param db the test database
 * @param encryption the app's encryption service
 * @param fake the fake supplier
 * @param categoryId the category of the new service
 * @param options the link's credit (13.50 by default) and supplier columns to change
 * @returns the supplier, the service and the supplier service
 */
export async function automaticRoute(
  db: Database,
  encryption: EncryptionService,
  fake: FakeDhruSupplier,
  categoryId: number,
  options: { credit?: string; supplier?: Partial<typeof s.suppliers.$inferInsert> } = {},
): Promise<{ supplierId: number; serviceId: number; supplierServiceId: number }> {
  routeCounter += 1;
  const supplierId = await insertFakeSupplier(db, encryption, fake, options.supplier);
  const [service] = await db
    .insert(s.services)
    .values({
      categoryId,
      type: 'imei',
      name: `Automatic route ${routeCounter}`,
      fulfillment: 'auto',
      code: `AUTO-${routeCounter}-${crypto.randomUUID().slice(0, 6)}`,
      slaMinutes: 60,
      cost: '13.5000',
      effectiveCost: '13.5000',
      basePrice: '17.2800',
      minProfit: '0.8100',
    })
    .returning({ id: s.services.id });
  const link = await linkService(db, service!.id, supplierId, { credit: options.credit ?? '13.5000' });
  return { supplierId, serviceId: service!.id, supplierServiceId: link.supplierServiceId };
}

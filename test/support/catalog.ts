// Helpers for the catalog tests (feature 4a): categories, services and supplier links inserted straight into the test database.
import { type Database, schema as s } from '../../src/infra/db';

/** Inserts a service category and returns its id. */
export async function insertCategory(
  db: Database,
  values: Partial<typeof s.serviceCategories.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(s.serviceCategories)
    .values({ name: `Category ${crypto.randomUUID()}`, type: 'imei', ...values })
    .returning({ id: s.serviceCategories.id });
  return row!.id;
}

let serviceCounter = 0;

/** Inserts a service (live, auto, fixed price) and returns its id; every column can be overridden. */
export async function insertService(
  db: Database,
  categoryId: number,
  values: Partial<typeof s.services.$inferInsert> = {},
): Promise<number> {
  serviceCounter += 1;
  const [row] = await db
    .insert(s.services)
    .values({
      categoryId,
      type: 'imei',
      name: `Service ${serviceCounter}`,
      fulfillment: 'auto',
      basePrice: '10.0000',
      code: `SVC-${serviceCounter}-${crypto.randomUUID().slice(0, 6)}`,
      slaMinutes: 60,
      ...values,
    })
    .returning({ id: s.services.id });
  return row!.id;
}

/** Inserts a supplier with one synced service and links the given service to it; returns the link id. */
export async function insertSupplierLink(
  db: Database,
  serviceId: number,
  options: { supplier?: string; credit?: string; creditRate?: string; priority?: number; isActive?: boolean } = {},
): Promise<{ linkId: number; supplierId: number; supplierServiceId: number }> {
  const [supplier] = await db
    .insert(s.suppliers)
    .values({
      name: options.supplier ?? `Supplier ${crypto.randomUUID().slice(0, 6)}`,
      driver: 'dhru',
      baseUrl: 'https://supplier.example.com',
      paramFormat: 'dhru_xml',
      creditRate: options.creditRate ?? '1',
    })
    .returning({ id: s.suppliers.id });
  const [remote] = await db
    .insert(s.supplierServices)
    .values({
      supplierId: supplier!.id,
      remoteId: crypto.randomUUID(),
      type: 'IMEI',
      name: 'Remote service',
      credit: options.credit ?? '1',
    })
    .returning({ id: s.supplierServices.id });
  const [link] = await db
    .insert(s.serviceSupplierLinks)
    .values({
      serviceId,
      supplierServiceId: remote!.id,
      priority: options.priority ?? 1,
      isActive: options.isActive ?? true,
    })
    .returning({ id: s.serviceSupplierLinks.id });
  return { linkId: link!.id, supplierId: supplier!.id, supplierServiceId: remote!.id };
}

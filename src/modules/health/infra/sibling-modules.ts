// Late-bound access to the pure rules and SQL fragments that other modules export: the orders' past-SLA predicate, the suppliers' health
// rules, the catalog's floor rule, the customers' funnel and money's stale-rate rule.
//
// Why late: decision 032. Identity, suppliers and money import this module's `JobRunsService` through its index, and orders, suppliers and
// catalog import each other and identity. A static import of those indexes from the health module would pull them into that cycle at the
// wrong moment (`Cannot access 'OrderSupplierMoves' before initialization`). A dynamic `import()` runs when a request or a job needs the
// function, long after every module is initialised; the loader caches the module, so the cost is one lookup.

/**
 * The orders module's public API, loaded when first needed.
 *
 * @returns the module namespace (cached by the loader after the first call)
 */
export const orders = (): Promise<typeof import('../../orders')> => import('../../orders');
/**
 * The suppliers module's public API, loaded when first needed.
 *
 * @returns the module namespace (cached by the loader after the first call)
 */
export const suppliers = (): Promise<typeof import('../../suppliers')> => import('../../suppliers');
/**
 * The catalog module's public API, loaded when first needed.
 *
 * @returns the module namespace (cached by the loader after the first call)
 */
export const catalog = (): Promise<typeof import('../../catalog')> => import('../../catalog');
/**
 * The customers module's public API, loaded when first needed.
 *
 * @returns the module namespace (cached by the loader after the first call)
 */
export const customers = (): Promise<typeof import('../../customers')> => import('../../customers');
/**
 * The money module's public API, loaded when first needed.
 *
 * @returns the module namespace (cached by the loader after the first call)
 */
export const money = (): Promise<typeof import('../../money')> => import('../../money');

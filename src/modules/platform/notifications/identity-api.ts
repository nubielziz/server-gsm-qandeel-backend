// Late-bound access to the identity module's request-principal helpers (decision 032 amendment): identity imports this module, so a static
// import would close a cycle.

/**
 * The identity module's public API, loaded when first needed.
 *
 * Why: decision 054: the notification log shows a payload's values only to holders of `notifications:*`, which needs identity's
 * `principalOf` and `grants` at request time; a dynamic `import()` runs long after every module is initialised, and the loader caches it.
 *
 * @returns the module namespace (cached by the loader after the first call)
 */
export const identityApi = (): Promise<typeof import('../../identity')> => import('../../identity');

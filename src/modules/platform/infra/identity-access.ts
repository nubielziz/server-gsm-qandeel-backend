// Late-bound access to the identity module's request-principal helpers (decision 032, "late reads"): identity imports this module, so a
// static import of identity from here would close an import cycle while the modules load.

/**
 * The identity module's public API, loaded when first needed.
 *
 * @returns the module namespace (cached by the loader after the first call)
 */
export const identity = (): Promise<typeof import('../../identity')> => import('../../identity');

// The code of a service made by the server (decision 074): a prefix by service type and the service's own id. Pure.
import type { ServiceType } from '../db/schema';

/**
 * The prefix of the code the server makes for a service of each type.
 *
 * Why: decision 074: staff no longer type the Code of a new service; the server makes `<PREFIX>-<id>`, so the type reads from the
 * code at a glance. The importer's own codes (`IMP-<supplier service id>`) are a different family and stay as they are.
 */
export const SERVICE_CODE_PREFIX: Readonly<Record<ServiceType, string>> = {
  imei: 'IMEI',
  server: 'SRV',
  remote: 'RMT',
  file: 'FILE',
};

/**
 * The code the server makes for a new service.
 *
 * Why: decision 074; `POST /admin/services` without a `code`. The id is the service's own, so two services made at the same
 * moment never make the same code.
 *
 * @param type the service type
 * @param id the id of the new service (taken from the id sequence before the row is written)
 * @returns `<PREFIX>-<id>`, for example `IMEI-1042`
 */
export function madeServiceCode(type: ServiceType, id: number): string {
  return `${SERVICE_CODE_PREFIX[type]}-${id}`;
}

/**
 * The code to try after `base` is taken: `base` itself, then `base-2`, `base-3`, ...
 *
 * Why: a code someone typed by hand may already hold the made code (or an `IMP-` code of a supplier import); both the import and
 * the made code then take the next free suffix instead of failing.
 *
 * @param base the code wanted
 * @param attempt which try this is, counted from 1 (a number below 1 counts as 1)
 * @returns `base` on the first try, `<base>-<attempt>` after it
 */
export function codeAttempt(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

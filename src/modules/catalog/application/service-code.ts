// The first free service code from a base: shared by the supplier import (`IMP-<id>`) and the made code of a new service (decision 074).
import type { DbExecutor } from '../../../infra/db';
import { codeAttempt } from '../domain/service-code';
import { findServiceByCode } from '../infra/service.repository';

/**
 * Finds the first code from `base` that no live service holds.
 *
 * Why: codes are unique ignoring case among live services (`services_code_uq`); a base that a service already holds (typed by hand
 * earlier, or made by an import) gets `-2`, `-3`, ... instead of failing the import or the create.
 *
 * @param tx the caller's transaction
 * @param base the code wanted
 * @returns `base`, `base-2`, `base-3`, ...: the first one no live service holds (case-insensitive)
 */
export async function firstFreeServiceCode(tx: DbExecutor, base: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const code = codeAttempt(base, attempt);
    if (!(await findServiceByCode(tx, code))) return code;
  }
}

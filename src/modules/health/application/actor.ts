// Who a write is done by, as a timeline line or a log names them (health module, feature 12b).
import { getRequestContext } from '../../../common/request-context';

/**
 * The staff member behind the current request, as `{ id, name }`.
 *
 * Why: an incident's timeline names the staff member on every line; the name is a snapshot, so a rename never rewrites history. The session
 * guard puts the name on the request context; without one (a job) the line falls back to the id.
 *
 * @param staffId the staff member's id from the principal
 * @returns the id and the name
 */
export function actorOf(staffId: number): { id: number; name: string } {
  return { id: staffId, name: getRequestContext()?.actor?.name || `Staff #${staffId}` };
}

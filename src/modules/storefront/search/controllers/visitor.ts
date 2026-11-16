// Who is asking, as the search statistics need to know (feature 29, plan section 5.6): the client address (only to make the day's salted
// visitor hash, never stored), the User-Agent (to leave bots out) and whether the request is a prefetch.
import type { FastifyRequest } from 'fastify';
import type { ListVisitor } from '../../application/storefront-catalog.service';
import { isPrefetchRequest } from '../domain/recordable-term';

/**
 * Reads the visitor of a request.
 *
 * @param request the Fastify request
 * @returns the address, the User-Agent and the prefetch flag
 */
export function visitorOf(request: FastifyRequest): ListVisitor {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent : undefined,
    prefetch: isPrefetchRequest(request.headers),
  };
}

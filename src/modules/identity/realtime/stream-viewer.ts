// Who watches a live stream (decision 037): the principal the session guard authenticated, as the hub's viewer, and the caps the
// stream counts against. Pure.
import { AppError } from '../../../common/errors';
import type { CapKey, StreamViewer } from '../../../infra/realtime';
import type { Principal } from '../security/principal';

/** The caps of a stream, from the configuration. */
export interface StreamLimits {
  readonly maxPerSession: number;
  readonly maxPerIp: number;
}

/**
 * The viewer of a stream opened by a signed-in staff member, merchant or customer.
 *
 * Why: the hub and the sources render every event for this viewer only: its kind and id are the audience key `u:<kind>:<id>`
 * (the inbox recipient), its session id lets a sign-out close the stream, and a staff member's permissions travel with it
 * (feature 28 adds the support key for `support:read`). The name is the account's display name the session holds.
 *
 * @param principal the authenticated caller of the stream route
 * @returns the viewer
 * @throws {AppError} `UNAUTHORIZED` for a principal that is not a session of staff, a merchant or a customer
 */
export function streamViewerOf(principal: Principal | undefined): StreamViewer {
  if (!principal) throw new AppError('UNAUTHORIZED');
  const common = { ip: principal.ip } as const;
  switch (principal.kind) {
    case 'staff':
      return {
        ...common,
        kind: 'staff',
        id: principal.staffId,
        sessionId: principal.session.id,
        name: principal.session.subject.name ?? '',
        permissions: [...principal.permissions],
      };
    case 'merchant':
      return {
        ...common,
        kind: 'client',
        id: principal.clientId,
        sessionId: principal.session.id,
        name: principal.session.subject.name ?? '',
        permissions: [],
      };
    case 'customer':
      return {
        ...common,
        kind: 'customer',
        id: principal.customerId,
        sessionId: principal.session.id,
        name: principal.session.subject.name ?? '',
        permissions: [],
      };
    case 'api-key':
    case 'capability':
    case 'webhook':
      throw new AppError('UNAUTHORIZED');
  }
}

/**
 * The caps of a session stream: per session first (also the key of the `stream-connect` limiter), then per address.
 *
 * Why: decision 037: at most 3 streams per session (one per browser through Web Locks; the fourth tab polls) and 30 per address;
 * the newest one over a cap is refused.
 *
 * @param viewer the viewer (it has a session)
 * @param limits `REALTIME_MAX_PER_SESSION` and `REALTIME_MAX_PER_IP`
 * @returns `session:<id>` and `ip:<address>`
 */
export function streamCapsOf(viewer: StreamViewer, limits: StreamLimits): CapKey[] {
  return [
    { key: `session:${viewer.sessionId ?? 0}`, max: limits.maxPerSession },
    { key: `ip:${viewer.ip}`, max: limits.maxPerIp },
  ];
}

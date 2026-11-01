// Sample routes for the security tests (decision 018): one contract per access kind and behaviour, so the guards are tested
// through real HTTP. Keys live under /t/sec to stay unique. Handlers answer what the guard made of the request.
import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { type AccessKind, type ResultOf, Route, defineRoute } from '../../src/common/contract';
import { AppError } from '../../src/common/errors';
import { DbService } from '../../src/infra/db';
import {
  CurrentPrincipal,
  CurrentStaff,
  type Principal,
  SessionCookies,
  SessionService,
  type StaffPrincipal,
} from '../../src/modules/identity';
import { AuditService } from '../../src/modules/platform';

const Seen = z.object({
  ok: z.boolean(),
  kind: z.string().nullable(),
  id: z.number().nullable(),
  stage: z.string().nullable(),
});
const Okay = z.object({ ok: z.boolean() });

/** A staff route that any active session may call. */
export const staffRead = defineRoute({
  key: 'GET /admin/t/sec/session',
  summary: 'Who am I (staff session)',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-session',
  success: { status: 200, schema: Seen },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED'],
});

/** A staff route whose handler asks for the staff principal itself. */
export const staffWho = defineRoute({
  key: 'GET /admin/t/sec/who',
  summary: 'The staff principal as a handler gets it',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-session',
  success: {
    status: 200,
    schema: z.object({ staffId: z.number(), roleId: z.number(), permissions: z.array(z.string()) }),
  },
  errors: ['UNAUTHORIZED'],
});

/** A merchant route whose handler wrongly asks for a staff principal. */
export const merchantAsksForStaff = defineRoute({
  key: 'GET /client/t/sec/as-staff',
  summary: 'A handler that asks for a staff principal on a merchant route',
  tags: ['security-test'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: Okay },
  errors: ['UNAUTHORIZED'],
});

/** A permission route (read). */
export const staffPermissionRead = defineRoute({
  key: 'GET /admin/t/sec/needs-read',
  summary: 'Needs staff:read',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:read',
  success: { status: 200, schema: Okay },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
});

/** A mutation that writes its audit row. */
export const staffWrite = defineRoute({
  key: 'POST /admin/t/sec/write',
  summary: 'A staff mutation that audits itself',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:update',
  success: { status: 201, schema: Okay },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED'],
});

/** A mutation with a body: proves that the guards run before the validation. */
export const validatedWrite = defineRoute({
  key: 'POST /admin/t/sec/validated',
  summary: 'A staff mutation with a validated body',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:update',
  body: z.object({ name: z.string().min(2) }),
  success: { status: 201, schema: Okay },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
});

/** A mutation whose permission is the literal `risk:*`. */
export const riskRules = defineRoute({
  key: 'PUT /admin/t/sec/risk-rules',
  summary: 'Needs the literal risk:* permission',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:*',
  success: { status: 200, schema: Okay },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED'],
});

/** A staff mutation that forgets its audit row. */
export const staffForgetsAudit = defineRoute({
  key: 'POST /admin/t/sec/forgets-audit',
  summary: 'A staff mutation that writes no audit row',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-session',
  success: { status: 200, schema: Okay },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED'],
});

/** A staff mutation that opts out of the audit duty. */
export const staffNoAudit = defineRoute({
  key: 'POST /admin/t/sec/no-audit',
  summary: 'A staff mutation exempt from the audit',
  description: 'Test route: it writes no audit row on purpose, like a sign-in step.',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-session',
  audit: false,
  success: { status: 200, schema: Okay },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED'],
});

/** A staff mutation that fails after the guards. */
export const staffFails = defineRoute({
  key: 'POST /admin/t/sec/fails',
  summary: 'A staff mutation that answers a business error',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-session',
  success: { status: 200, schema: Okay },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED', 'CONFLICT'],
});

/** A sign-in step that accepts only the pending TOTP stages. */
export const staffStep = defineRoute({
  key: 'POST /admin/t/sec/step',
  summary: 'A sign-in step (pending TOTP stages)',
  description: 'Test route: a sign-in step writes no audit row.',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-session',
  sessionStages: ['pending_totp', 'pending_totp_setup'],
  audit: false,
  success: { status: 200, schema: Seen },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED'],
});

/** A route every stage may call, like logout. */
export const staffAnyStage = defineRoute({
  key: 'POST /admin/t/sec/any-stage',
  summary: 'Accepts every sign-in stage (logout)',
  description: 'Test route: logout writes no audit row.',
  tags: ['security-test'],
  surface: 'admin',
  access: 'staff-session',
  sessionStages: ['pending_password', 'pending_totp_setup', 'pending_totp', 'active'],
  audit: false,
  success: { status: 200, schema: Seen },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED'],
});

/** A public mutation on the admin surface (login-like): the Origin check applies. */
export const adminPublicWrite = defineRoute({
  key: 'POST /admin/t/sec/login',
  summary: 'A public mutation on the admin surface',
  description: 'Test route: no session to bind a CSRF token to.',
  tags: ['security-test'],
  surface: 'admin',
  access: 'public',
  csrf: false,
  audit: false,
  success: { status: 200, schema: Okay },
  errors: ['CSRF_FAILED'],
});

/** A public read on the admin surface. */
export const adminPublicRead = defineRoute({
  key: 'GET /admin/t/sec/public',
  summary: 'A public read on the admin surface',
  tags: ['security-test'],
  surface: 'admin',
  access: 'public',
  success: { status: 200, schema: Okay },
  errors: [],
});

/** What a sign-in answers: the cookies and the CSRF header (the route creates a session for staff id 1). */
export const issueCookies = defineRoute({
  key: 'POST /admin/t/sec/issue',
  summary: 'Sets the session cookies like a sign-in',
  description: 'Test route: stands in for the sign-in, which is session-less and writes no audit row.',
  tags: ['security-test'],
  surface: 'admin',
  access: 'public',
  csrf: false,
  audit: false,
  success: { status: 200, schema: Okay },
  errors: ['CSRF_FAILED'],
});

/** What a sign-out answers: both cookies cleared. */
export const clearCookies = defineRoute({
  key: 'POST /admin/t/sec/clear',
  summary: 'Clears the session cookies like a sign-out',
  description: 'Test route: stands in for the sign-out.',
  tags: ['security-test'],
  surface: 'admin',
  access: 'public',
  csrf: false,
  audit: false,
  success: { status: 204 },
  errors: ['CSRF_FAILED'],
});

/** Merchant portal routes. */
export const merchantRead = defineRoute({
  key: 'GET /client/t/sec/session',
  summary: 'Who am I (merchant session)',
  tags: ['security-test'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: Seen },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED'],
});
export const merchantWrite = defineRoute({
  key: 'POST /client/t/sec/write',
  summary: 'A merchant mutation',
  tags: ['security-test'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: Seen },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED'],
});
export const clientPublicWrite = defineRoute({
  key: 'POST /client/t/sec/register',
  summary: 'A public mutation on the merchant portal',
  tags: ['security-test'],
  surface: 'client',
  access: 'public',
  success: { status: 200, schema: Okay },
  errors: ['CSRF_FAILED'],
});

/** Storefront routes. */
export const customerRead = defineRoute({
  key: 'GET /store/v1/t/sec/session',
  summary: 'Who am I (customer session)',
  tags: ['security-test'],
  surface: 'store',
  access: 'customer-session',
  success: { status: 200, schema: Seen },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED'],
});
export const customerWrite = defineRoute({
  key: 'POST /store/v1/t/sec/write',
  summary: 'A customer mutation',
  tags: ['security-test'],
  surface: 'store',
  access: 'customer-session',
  success: { status: 200, schema: Seen },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED'],
});
export const storePublicWrite = defineRoute({
  key: 'POST /store/v1/t/sec/public',
  summary: 'A public mutation on the storefront',
  tags: ['security-test'],
  surface: 'store',
  access: 'public',
  success: { status: 200, schema: Okay },
  errors: [],
});

/** A GET route with one of the machine access kinds (P2.5c), to test that none is left open without credentials. */
function placeholderRoute<K extends AccessKind>(kind: K) {
  return defineRoute({
    key: `GET /store/v1/t/sec/kind/${kind}`,
    summary: `A route with access ${kind}`,
    tags: ['security-test'],
    surface: 'store',
    access: kind,
    // An API key route names the scope the key needs.
    ...(kind === 'api-key' ? { permission: 'orders:read' } : {}),
    success: { status: 200, schema: Okay },
    errors: ['UNAUTHORIZED'],
  });
}
export const placeholderApiKey = placeholderRoute('api-key');
export const placeholderGateway = placeholderRoute('gateway-signature');
export const placeholderUrlSecret = placeholderRoute('url-secret');
export const placeholderCheckout = placeholderRoute('checkout-token');
export const placeholderTracking = placeholderRoute('tracking-token');
export const placeholderLink = placeholderRoute('link-token');
export const placeholderTicket = placeholderRoute('ticket-token');

/** The access kinds the placeholder routes above cover, with their URL (the Dhru one is `dhruLike` in routes.ts). */
export const PLACEHOLDER_URLS: Readonly<Record<string, string>> = {
  'api-key': '/store/v1/t/sec/kind/api-key',
  'gateway-signature': '/store/v1/t/sec/kind/gateway-signature',
  'url-secret': '/store/v1/t/sec/kind/url-secret',
  'checkout-token': '/store/v1/t/sec/kind/checkout-token',
  'tracking-token': '/store/v1/t/sec/kind/tracking-token',
  'link-token': '/store/v1/t/sec/kind/link-token',
  'ticket-token': '/store/v1/t/sec/kind/ticket-token',
};

function seen(principal: Principal | undefined): z.infer<typeof Seen> {
  if (principal?.kind === 'staff') return { ok: true, kind: 'staff', id: principal.staffId, stage: principal.stage };
  if (principal?.kind === 'merchant')
    return { ok: true, kind: 'merchant', id: principal.clientId, stage: principal.stage };
  if (principal?.kind === 'customer')
    return { ok: true, kind: 'customer', id: principal.customerId, stage: principal.stage };
  return { ok: true, kind: null, id: null, stage: null };
}

/** Handlers for the sample security routes. */
@Controller()
export class SecurityTestController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookies,
  ) {}

  @Route(staffRead)
  staffRead(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof staffRead> {
    return seen(principal);
  }

  @Route(staffWho)
  staffWho(@CurrentStaff() staff: StaffPrincipal): ResultOf<typeof staffWho> {
    return { staffId: staff.staffId, roleId: staff.roleId, permissions: [...staff.permissions] };
  }

  @Route(merchantAsksForStaff)
  merchantAsksForStaff(@CurrentStaff() _staff: StaffPrincipal): ResultOf<typeof merchantAsksForStaff> {
    return { ok: true };
  }

  @Route(staffPermissionRead)
  staffPermissionRead(): ResultOf<typeof staffPermissionRead> {
    return { ok: true };
  }

  @Route(staffWrite)
  async staffWrite(): Promise<ResultOf<typeof staffWrite>> {
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        action: 'Changed a test record',
        entityType: 'staff',
        entityId: 7,
        entityLabel: 'Test record',
        before: { name: 'old', passwordHash: 'argon2id$should-not-be-stored', mustChangePassword: true },
        after: { name: 'new', passwordHash: 'argon2id$should-not-be-stored', mustChangePassword: false },
      }),
    );
    return { ok: true };
  }

  @Route(validatedWrite)
  async validatedWrite(): Promise<ResultOf<typeof validatedWrite>> {
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, { action: 'Saved a record', entityType: 'staff', entityId: 1 }),
    );
    return { ok: true };
  }

  @Route(riskRules)
  async riskRules(): Promise<ResultOf<typeof riskRules>> {
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, { action: 'Saved the risk rules', entityType: 'setting', entityLabel: 'risk.rules' }),
    );
    return { ok: true };
  }

  @Route(staffForgetsAudit)
  staffForgetsAudit(): ResultOf<typeof staffForgetsAudit> {
    return { ok: true };
  }

  @Route(staffNoAudit)
  staffNoAudit(): ResultOf<typeof staffNoAudit> {
    return { ok: true };
  }

  @Route(staffFails)
  staffFails(): never {
    throw new AppError('CONFLICT', { detail: 'The change conflicts with the current state.' });
  }

  @Route(staffStep)
  staffStep(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof staffStep> {
    return seen(principal);
  }

  @Route(staffAnyStage)
  staffAnyStage(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof staffAnyStage> {
    return seen(principal);
  }

  @Route(adminPublicWrite)
  adminPublicWrite(): ResultOf<typeof adminPublicWrite> {
    return { ok: true };
  }

  @Route(adminPublicRead)
  adminPublicRead(): ResultOf<typeof adminPublicRead> {
    return { ok: true };
  }

  @Route(issueCookies)
  async issueCookies(@Res({ passthrough: true }) reply: FastifyReply): Promise<ResultOf<typeof issueCookies>> {
    const { token, session } = await this.sessions.create({
      subjectType: 'staff',
      subjectId: 1,
      stage: 'pending_totp',
      ip: '203.0.113.9',
    });
    this.cookies.set(reply, 'staff', token, session.expiresAt);
    return { ok: true };
  }

  @Route(clearCookies)
  clearCookies(@Res({ passthrough: true }) reply: FastifyReply): void {
    this.cookies.clear(reply, 'staff');
  }

  @Route(merchantRead)
  merchantRead(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof merchantRead> {
    return seen(principal);
  }

  @Route(merchantWrite)
  merchantWrite(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof merchantWrite> {
    return seen(principal);
  }

  @Route(clientPublicWrite)
  clientPublicWrite(): ResultOf<typeof clientPublicWrite> {
    return { ok: true };
  }

  @Route(customerRead)
  customerRead(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof customerRead> {
    return seen(principal);
  }

  @Route(customerWrite)
  customerWrite(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof customerWrite> {
    return seen(principal);
  }

  @Route(storePublicWrite)
  storePublicWrite(): ResultOf<typeof storePublicWrite> {
    return { ok: true };
  }

  @Route(placeholderApiKey)
  placeholderApiKey(): { ok: boolean } {
    return { ok: true };
  }

  @Route(placeholderGateway)
  placeholderGateway(): { ok: boolean } {
    return { ok: true };
  }

  @Route(placeholderUrlSecret)
  placeholderUrlSecret(): { ok: boolean } {
    return { ok: true };
  }

  @Route(placeholderCheckout)
  placeholderCheckout(): { ok: boolean } {
    return { ok: true };
  }

  @Route(placeholderTracking)
  placeholderTracking(): { ok: boolean } {
    return { ok: true };
  }

  @Route(placeholderLink)
  placeholderLink(): { ok: boolean } {
    return { ok: true };
  }

  @Route(placeholderTicket)
  placeholderTicket(): { ok: boolean } {
    return { ok: true };
  }

  /** A route nobody gave a contract: the dispatcher must refuse it. */
  @Get('/t/sec/no-contract')
  noContract(): { ok: boolean } {
    return { ok: true };
  }
}

// CustomerIdentityRegistrar: plugs the customers module into the security stack of identity at boot: the session subject resolver
// of storefront customers and the resolver of the one-time link tokens (decision 018, 010).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import {
  CapabilityTokenResolvers,
  CustomerAuthTokens,
  type SessionSubjectResolver,
  SessionSubjects,
  type SubjectSnapshot,
  isUsableLink,
} from '../../identity';
import { sessionStateOf } from '../domain/customer-status';
import { findCustomerById } from '../infra/customer.repository';

/**
 * The customer account behind a session.
 *
 * Why: the identity module owns sessions but not customers (module ownership), so the customers module tells it what state an
 * account is in: `ok` for an active customer, `suspended` for a suspended or blocked one (403 `ACCOUNT_SUSPENDED`, every session
 * revoked), `gone` for an anonymized or missing one (401).
 */
class CustomerSubjectResolver implements SessionSubjectResolver {
  readonly subjectType = 'customer';

  constructor(private readonly db: DbService) {}

  async resolve(subjectId: number): Promise<SubjectSnapshot> {
    const customer = await findCustomerById(this.db.db, subjectId);
    if (!customer) return { state: 'gone' };
    return { state: sessionStateOf(customer.status), name: customer.name };
  }
}

/**
 * Registers the customer resolvers with the identity module's registries.
 *
 * Why: without the subject resolver every customer session is refused; without the link resolver every sign-in and password
 * link is `410 TOKEN_INVALID` (both fail closed). The link resolver only looks: it never spends the token, which the use case
 * does in its own transaction together with the work it unlocks.
 *
 * Side effects: `register` calls at boot (a duplicate registration is a boot-time error).
 */
@Injectable()
export class CustomerIdentityRegistrar implements OnModuleInit {
  constructor(
    private readonly subjects: SessionSubjects,
    private readonly capabilityTokens: CapabilityTokenResolvers,
    private readonly authTokens: CustomerAuthTokens,
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers the session subject resolver and the link-token resolver. */
  onModuleInit(): void {
    this.subjects.register(new CustomerSubjectResolver(this.db));
    this.capabilityTokens.register({
      kind: 'link-token',
      resolve: async (token) => {
        const link = await this.authTokens.find(token);
        return link !== undefined && isUsableLink(link, this.clock.nowMs()) ? { id: link.id } : null;
      },
    });
  }
}

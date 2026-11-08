// CustomerDirectory: the public service other modules use to find or make a guest customer (decision 016). The support module calls it
// when a visitor writes from the contact page (feature 17), so no other module inserts into `customers`.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { DbExecutor } from '../../../infra/db';
import { insertGuestCustomer } from '../infra/checkout.repository';
import { findCustomerByEmail } from '../infra/customer.repository';

/** A customer as other modules may know them: who they are and whether they can still be written to. */
export interface CustomerRef {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly status: string;
}

/**
 * Finds or makes the customer behind an email address.
 *
 * Why: a visitor who writes from the contact page has no account and may never have bought: the ticket needs somebody to belong to and
 * the reply email needs an address, so the visitor becomes a guest customer exactly as a guest checkout does (14a). The customers module
 * owns `customers`; the support module asks this class (decision 016). It holds no connection: the caller passes its transaction.
 *
 * Side effects: may insert a guest `customers` row. Time comes from the injected clock (decision 031).
 */
@Injectable()
export class CustomerDirectory {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * Returns the customer of an email, making a guest customer when nobody used the address yet.
   *
   * Two requests for one new address race to the unique index on `lower(email)`: the loser inserts nothing (`ON CONFLICT DO NOTHING`) and
   * reads the winner's row, so both end with the same customer.
   *
   * @param tx the caller's transaction
   * @param guest the normalised (trimmed, lower-case) email and the name the visitor typed (may be empty; an existing customer keeps theirs)
   * @returns the existing customer, or the new guest
   */
  async findOrCreateGuest(
    tx: DbExecutor,
    guest: { readonly email: string; readonly name: string },
  ): Promise<CustomerRef> {
    const existing = await findCustomerByEmail(tx, guest.email);
    if (existing) return toRef(existing);
    const now = this.clock.now();
    const created = await insertGuestCustomer(tx, {
      email: guest.email,
      name: guest.name,
      hasAccount: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    if (created) return toRef(created);
    const raced = await findCustomerByEmail(tx, guest.email);
    if (!raced) throw new Error('A guest customer was neither created nor found.');
    return toRef(raced);
  }
}

const toRef = (row: { id: number; name: string; email: string; status: string }): CustomerRef => ({
  id: row.id,
  name: row.name,
  email: row.email,
  status: row.status,
});

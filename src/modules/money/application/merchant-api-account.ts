// MerchantApiAccount: what the Dhru surface says about a merchant's account (map domain E, stage 7): the `accountinfo` action.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DhruGateway } from '../../../common/dhru';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { dhruAccountInfo } from '../contracts/dhru-account.contracts';
import { BASE_CURRENCY } from '../domain/accounts';
import { findMerchantProfile } from '../infra/foreign-directory.repository';
import { WalletService } from './wallet.service';

/**
 * Serves the account read of Dhru.
 *
 * Why: the map's `accountinfo` row: a Dhru client reads the balance it may spend without the portal. The figures are the ledger's own
 * (never cached, decision 022): the same wallet view as the portal, so the two never disagree. Dhru's `credit` is the available balance
 * (balance plus credit limit), what an order may spend now.
 *
 * Side effects: none (reads only); it binds the `accountinfo` handler to the Dhru gateway at start.
 *
 * @see docs/decisions/026-dhru-compatibility.md
 */
@Injectable()
export class MerchantApiAccount implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly wallets: WalletService,
    private readonly gateway: DhruGateway,
  ) {}

  /** Binds `accountinfo` to the Dhru gateway. */
  onModuleInit(): void {
    this.gateway.bind(dhruAccountInfo, async ({ caller }) => {
      const { credit, mail, currency } = await this.accountInfo(caller.clientId);
      return { message: 'Your Accout Info' as const, AccoutInfo: { credit, mail, currency } };
    });
  }

  /**
   * The available balance, email and currency of a merchant (Dhru `accountinfo`).
   *
   * @param clientId the merchant behind the API key
   * @returns what the merchant may spend, its email and the currency
   * @throws {AppError} `UNAUTHORIZED` when the merchant no longer exists
   */
  async accountInfo(clientId: number): Promise<{ credit: string; mail: string; currency: string }> {
    const [profile, wallet] = await Promise.all([
      findMerchantProfile(this.db.db, clientId),
      this.wallets.viewOf(this.db.db, clientId),
    ]);
    if (!profile) throw new AppError('UNAUTHORIZED');
    return { credit: wallet.available, mail: profile.email, currency: BASE_CURRENCY };
  }
}

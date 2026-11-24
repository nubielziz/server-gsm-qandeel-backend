// MerchantApiKeyService: the read-only list of the merchant's own API keys (route GET /client/api-keys, MISMATCHES B155, decision 067).
// Merchants no longer create, change or revoke keys: staff do (ApiKeyAdminService).
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { type ApiKeyWire, apiKeyToWire } from '../domain/api-key-input';
import { type ApiKeySortField, listKeysOfClient } from '../infra/api-key-manage.repository';
import type { AccountPrincipal } from '../ports/account-principal';

/** The range and sort of a list request, already parsed and checked by the contract. */
export interface ApiKeyListRequest {
  readonly offset: number;
  readonly limit: number;
  readonly sort: readonly { readonly field: ApiKeySortField; readonly order: 'asc' | 'desc' }[];
}

/**
 * Lists the API keys of the signed-in merchant.
 *
 * Why: B155 and decision 067. A key authenticates Dhru calls (P2.5c); staff make every key and change or revoke it in the console, and the
 * merchant only sees its own list (the display prefix, the allowed addresses, the last use). A key the merchant made before the decision
 * keeps working until staff revoke it. Only the keyed hash of a key and its first 8 characters are stored. Merchant routes write no audit
 * row (B121). The rank gate already keeps a retail account off this route.
 *
 * Side effects: none (it reads `api_keys`).
 *
 * @see docs/contract/MISMATCHES.md (B155)
 * @see docs/decisions/067-api-keys-made-by-staff.md
 */
@Injectable()
export class MerchantApiKeyService {
  constructor(private readonly db: DbService) {}

  /**
   * Lists the merchant's keys: live keys first, then revoked ones.
   *
   * @param principal the signed-in account (a merchant rank: the gate refuses the others)
   * @param request the range and the sort keys
   * @returns the keys in the range and the exact total
   */
  async list(principal: AccountPrincipal, request: ApiKeyListRequest): Promise<{ rows: ApiKeyWire[]; total: number }> {
    const { rows, total } = await listKeysOfClient(this.db.db, principal.accountId, request);
    return { rows: rows.map(apiKeyToWire), total };
  }
}

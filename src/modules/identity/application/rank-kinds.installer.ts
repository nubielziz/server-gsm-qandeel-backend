// Installs the rank kind lookup of the session core at boot (decision 064).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { rankKindOf } from '../ports/rank-kind';
import { RankKinds } from '../security/rank-kinds';

/**
 * Gives `RankKinds` the way to read a rank's kind: the catalog's `RankGroupReads`.
 *
 * Why: the session core must know the rank kind of an account to apply the rank gate, but the security folder never imports the catalog
 * or reads `client_groups` (decision 064). The kind-to-rights rule stays in one place: `rankKindOf` (only `b2b` is a merchant rank,
 * every other stored kind has retail rights).
 *
 * Side effects: installs the lookup once, at module init; the lookup reads `client_groups` through the catalog.
 */
@Injectable()
export class RankKindsInstaller implements OnModuleInit {
  constructor(
    private readonly ranks: RankKinds,
    private readonly groups: RankGroupReads,
    private readonly db: DbService,
  ) {}

  /** Installs the lookup. */
  onModuleInit(): void {
    this.ranks.install(async (groupId) => {
      const kind = await this.groups.kindOf(this.db.db, groupId);
      return kind === undefined ? undefined : rankKindOf(kind);
    });
  }
}

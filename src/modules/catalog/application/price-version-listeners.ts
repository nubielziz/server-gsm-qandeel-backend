// PriceVersionListeners: the leaf through which other parts of the app learn that the catalog price version moved, without the price
// version importing them (decision 032: the version is exported early and must not lead into identity).
import { Injectable, Logger } from '@nestjs/common';

/** Someone who wants to know that a resolved price may have changed. */
export interface PriceVersionListener {
  /** Called after the version moved (and after the commit that moved it); must not throw. */
  priceVersionMoved(): Promise<void>;
}

/**
 * The list of listeners of the catalog price version.
 *
 * Why: feature 7b's price change scan has to run after every price change, and every writer already calls
 * `CatalogPriceVersion.bumpAfterCommit`. The scan registers here at boot; the version tells every listener after it moved. A
 * listener that fails is logged and never fails the price change.
 */
@Injectable()
export class PriceVersionListeners {
  private readonly logger = new Logger(PriceVersionListeners.name);
  private readonly listeners: PriceVersionListener[] = [];

  /**
   * Adds a listener.
   *
   * @param listener who to tell
   */
  add(listener: PriceVersionListener): void {
    this.listeners.push(listener);
  }

  /** Tells every listener that the version moved. Never throws. */
  async notify(): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener.priceVersionMoved();
      } catch (error) {
        this.logger.warn(`A price version listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

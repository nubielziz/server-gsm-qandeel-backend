// The gateway drivers by the name stored in `payment_gateways.driver`.
import { cardDriver } from './card-driver';
import { cryptoDriver } from './crypto-driver';
import type { PaymentGatewayDriver } from './driver';

const DRIVERS: Readonly<Record<string, PaymentGatewayDriver>> = {
  card: cardDriver,
  stripe: cardDriver,
  crypto: cryptoDriver,
  usdt: cryptoDriver,
};

/**
 * Finds the driver of a gateway.
 *
 * Why: a gateway row names its driver as text (the console's free field); only the names above have code behind them. A manual
 * gateway (bank, Wise) has no driver at all: staff review its receipts.
 *
 * @param name the gateway's `driver` column
 * @returns the driver, or `undefined` when no code serves that name
 */
export function driverFor(name: string): PaymentGatewayDriver | undefined {
  return Object.hasOwn(DRIVERS, name.toLowerCase()) ? DRIVERS[name.toLowerCase()] : undefined;
}

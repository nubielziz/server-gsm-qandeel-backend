// The Dhru gateway as a global provider, so the modules that own Dhru actions bind their handlers without importing each other.
import { Global, Module } from '@nestjs/common';
import { DhruGateway } from './dhru-gateway';

/**
 * Provides the {@link DhruGateway} to every module.
 *
 * Why: decision 026: the surface is isolated behind one adapter; money, catalog and orders each own some of its actions, and a module
 * may not import another (decision 016), so the adapter is shared through a global provider like the clock and the error registry.
 */
@Global()
@Module({ providers: [DhruGateway], exports: [DhruGateway] })
export class DhruModule {}

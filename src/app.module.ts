// Root module of the API process. Phase 0 placeholder: Phase 2 wires config, logging, infrastructure and the
// domain modules from src/modules (one per map domain, see scripts/module-map.mjs).
import { Module } from '@nestjs/common';

/** Root Nest module of the API process; imports every domain module once they exist. */
@Module({ imports: [] })
export class AppModule {}

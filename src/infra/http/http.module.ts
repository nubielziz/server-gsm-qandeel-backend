// Global Nest module for outbound HTTP (decision 023): the OutboundHttp service. Shared by the API and the worker.
import { Global, Module } from '@nestjs/common';
import { OutboundHttp } from './http.service';

/**
 * Provides {@link OutboundHttp} to every module.
 *
 * Why: supplier calls, gateway calls, merchant webhook deliveries and the FX refresh all go through one helper with one
 * set of timeout, redirect and SSRF rules (decision 023). It needs the global config and metrics modules.
 */
@Global()
@Module({ providers: [OutboundHttp], exports: [OutboundHttp] })
export class OutboundHttpModule {}

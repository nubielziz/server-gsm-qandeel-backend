// The Bull Board page at `GET /admin/queues` (map: the console only links to it, M8, M199): the BullMQ queues in a read-only UI behind
// the staff gate. Bull Board is a Fastify plugin, mounted on the API's Fastify instance; the gate is a hook in the plugin's scope.
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_SESSION_STAGES } from '../../../common/contract';
import { AppError, ERROR_CATALOG } from '../../../common/errors';
import { QueuesService } from '../../../infra/queues';
import { SessionAuthenticator, grants } from '../../identity';
import { queuesBoard } from '../contracts/system-traffic.contracts';

/** Where the board is mounted. */
export const QUEUES_BOARD_PATH = '/admin/queues';

/**
 * Mounts Bull Board at `/admin/queues`.
 *
 * Why: staff with `queues:read` get the deep view of every BullMQ queue (jobs, payloads, logs) that the System health Queues tab links
 * to. The board is read-only: retrying and pausing are the audited routes `POST /admin/system/queues/:name/retry` and `/pause`, so
 * `queues:read` never changes a queue and the board needs no CSRF token. The request is authenticated by the staff session cookie
 * (the console opens it in a new tab, so there is no `Authorization` header); a missing session is `401`, a missing permission
 * `403`, both as problem+json. Methods other than GET and HEAD are `403 FORBIDDEN` (the error catalog has no 405).
 *
 * Side effects: registers Bull Board's routes under `/admin/queues` on the Fastify instance when the application starts.
 */
@Injectable()
export class QueuesBoard implements OnApplicationBootstrap {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly queues: QueuesService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Creates the board over the producers of every queue and registers the gated plugin. */
  onApplicationBootstrap(): void {
    // Referencing the contract keeps `GET /admin/queues` in the route registry (OpenAPI and the contract tests).
    void queuesBoard.key;
    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
    const serverAdapter = new FastifyAdapter();
    serverAdapter.setBasePath(QUEUES_BOARD_PATH);
    createBullBoard({
      queues: this.queues.list().map(([, queue]) => new BullMQAdapter(queue, { readOnlyMode: true })),
      serverAdapter,
      options: { uiConfig: { boardTitle: 'GSM queues' } },
    });
    void fastify.register(
      (scope, _options, done) => {
        scope.addHook('onRequest', (request, reply) => this.gate(request, reply));
        void scope.register(serverAdapter.registerPlugin());
        done();
      },
      { prefix: QUEUES_BOARD_PATH },
    );
  }

  /** Lets a staff session with `queues:read` through on a read; answers the problem otherwise (a hook that replies ends the request). */
  private async gate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new AppError('FORBIDDEN', { detail: 'The queue board is read-only.' });
      }
      // Resolved at request time, not injected: identity imports this module's job runs, so a constructor parameter of identity's class would read
      // its binding before initialisation (decision 032).
      const authenticator = this.moduleRef.get(SessionAuthenticator, { strict: false });
      const { principal } = await authenticator.authenticate('staff', request, { stages: DEFAULT_SESSION_STAGES });
      if (principal.kind !== 'staff' || !grants(principal.permissions, 'queues:read')) {
        throw new AppError('FORBIDDEN', { detail: 'You need the queues:read permission.' });
      }
    } catch (error) {
      const failure = error instanceof AppError ? error : new AppError('INTERNAL_ERROR');
      const entry = ERROR_CATALOG[failure.code];
      await reply
        .code(entry.status)
        .header('content-type', 'application/problem+json; charset=utf-8')
        .send({
          type: 'about:blank',
          title: entry.title,
          status: entry.status,
          code: failure.code,
          detail: failure.detail ?? entry.title,
        });
    }
  }
}

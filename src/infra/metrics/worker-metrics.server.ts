// The worker's own /metrics HTTP listener (decision 015): the worker has no Fastify app, so a tiny node:http server
// serves its registry on WORKER_METRICS_PORT with the same access rule as the API's GET /metrics.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../common/errors/app-error';
import { PROBLEM_CONTENT_TYPE, buildProblem } from '../../common/errors/problem';
import { generateRequestId } from '../../common/request-id';
import { APP_CONFIG, type AppConfig } from '../../config';
import { authorizeMetricsRequest, hasForwardingHeaders } from './metrics-access';
import { MetricsService } from './metrics.service';

/**
 * Serves `GET /metrics` for the worker process.
 *
 * Why: Prometheus scrapes both processes (decision 015); the worker must expose queue and job metrics without
 * running the HTTP application. Everything but `/metrics` is a problem+json 404, access is internal-network or token.
 *
 * Side effects: opens a TCP listener on `HOST:WORKER_METRICS_PORT` at bootstrap, closes it at shutdown.
 */
@Injectable()
export class WorkerMetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server: Server | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerMetricsServer.name);
  }

  /**
   * Starts listening.
   *
   * @throws {Error} when the port is taken, so the worker fails to start instead of running unobserved
   */
  async onApplicationBootstrap(): Promise<void> {
    const server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.observability.workerMetricsPort, this.config.http.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (error) => this.logger.error({ err: error }, 'Worker metrics listener error'));
    this.server = server;
    this.logger.info({ port: this.config.observability.workerMetricsPort }, 'Worker metrics listening');
  }

  /** Stops accepting connections and drops idle ones. */
  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = (request.url ?? '/').split('?')[0];
      if (path !== '/metrics' || (request.method !== 'GET' && request.method !== 'HEAD')) {
        this.problem(response, new AppError('NOT_FOUND', { detail: 'This process only serves GET /metrics.' }));
        return;
      }
      const allowed = authorizeMetricsRequest(
        {
          authorization: request.headers.authorization,
          remoteAddress: request.socket.remoteAddress,
          forwarded: hasForwardingHeaders(request.headers),
        },
        this.config.observability.metricsToken,
      );
      if (!allowed) {
        this.problem(
          response,
          new AppError('FORBIDDEN', {
            detail: 'Metrics are only available from the internal network or with the metrics token.',
          }),
        );
        return;
      }
      const text = await this.metrics.render();
      response.writeHead(200, { 'content-type': this.metrics.contentType, 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : text);
    } catch (error) {
      this.logger.error({ err: error }, 'Worker metrics request failed');
      this.problem(response, new AppError('INTERNAL_ERROR'));
    }
  }

  private problem(response: ServerResponse, error: AppError): void {
    const body = buildProblem(error, { requestId: generateRequestId(), errorsBaseUrl: this.config.http.errorsBaseUrl });
    response.writeHead(error.status, { 'content-type': PROBLEM_CONTENT_TYPE, 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }
}

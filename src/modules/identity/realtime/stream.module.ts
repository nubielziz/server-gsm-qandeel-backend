// The live event stream routes of the identity module (decision 037): GET /admin/stream, /client/stream and /store/v1/me/stream.
import { Module } from '@nestjs/common';
import { RealtimeHubModule } from '../../../infra/realtime';
import { StreamController } from './stream.controller';

/**
 * Provides the stream routes.
 *
 * Why: the routes belong to identity (it owns sessions, principals and the guard); the hub is the API's (`RealtimeHubModule`). A
 * module of its own, so a test app built without the database or Redis leaves the routes out with the security stack.
 */
@Module({
  imports: [RealtimeHubModule],
  controllers: [StreamController],
})
export class StreamRoutesModule {}

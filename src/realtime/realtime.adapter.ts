import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO on the API's own HTTP server, with the same CORS origins as REST (read at startup,
 * when the environment is loaded). Messages are small JSON: a 64 KB frame limit is plenty.
 *
 * Scaling out to several API processes: plug the Socket.IO Redis adapter in here
 * (`server.adapter(createAdapter(pub, sub))`) so rooms span processes.
 */
export class RealtimeAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: true },
      maxHttpBufferSize: 64 * 1024,
    } as ServerOptions);
  }
}

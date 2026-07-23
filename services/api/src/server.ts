import { createServer as createHttpServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createApp } from './app.js';
import { DemoStore, type PersistedDemoState } from './store.js';
import { createStatePersistenceFromEnv } from './postgres-persistence.js';

export interface PactServer {
  server: Server;
  close: () => Promise<void>;
}

export function createPactServer(store?: DemoStore): PactServer {
  const persistence = store ? null : createStatePersistenceFromEnv<PersistedDemoState>();
  const activeStore = store ?? new DemoStore(persistence ?? undefined);
  const server = createHttpServer(createApp(activeStore));
  const sockets = new WebSocketServer({ noServer: true });
  const pathPattern = /^\/api\/streams\/([^/]+)\/live$/;

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!pathPattern.test(pathname)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit('connection', webSocket, request));
  });

  sockets.on('connection', (socket, request) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const taskId = decodeURIComponent(pathPattern.exec(pathname)?.[1] ?? '');
    try {
      socket.send(JSON.stringify({ type: 'stream', taskId, status: activeStore.streamStatus(taskId) }));
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', code: 'TASK_NOT_FOUND', error: error instanceof Error ? error.message : 'Task not found' }));
      socket.close(1008, 'Task not found');
      return;
    }
    const unsubscribe = activeStore.subscribe((event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (event.type === 'stream' && event.taskId === taskId) socket.send(JSON.stringify(event));
    });
    socket.once('close', unsubscribe);
  });

  const ticker = setInterval(() => activeStore.tick(), 1000);
  ticker.unref();

  return {
    server,
    close: () => new Promise<void>((resolve, reject) => {
      const closePersistence = () => Promise.resolve(persistence?.close?.()).then(() => undefined);
      clearInterval(ticker);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      if (!server.listening) {
        closePersistence().then(resolve, reject);
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else closePersistence().then(resolve, reject);
      });
    })
  };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const runtime = createPactServer();
  runtime.server.listen(port, host, () => {
    console.log(`PACT API running at http://${host}:${port}`);
    console.log(`WebSocket endpoint: ws://${host}:${port}/api/streams/:taskId/live`);
  });
}

/**
 * HTTP（静态托管 client/dist）+ WebSocket（/ws 协议分发）。
 * 会话层：连接 ↔ (room, player) 绑定；断线标记离线保留座位（ADR-004）。
 */
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomRegistry, type Player, type Room } from './rooms.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface GameServerOptions {
  port: number;
  /** client 构建产物目录（不存在则只提供 WS） */
  clientDist?: string;
}

export interface GameServer {
  httpServer: HttpServer;
  port: number;
  close(): Promise<void>;
}

export async function createGameServer(opts: GameServerOptions): Promise<GameServer> {
  const registry = new RoomRegistry();
  const clientDist = opts.clientDist;

  const httpServer = createServer(async (req, res) => {
    if (!clientDist || req.url === '/ws') {
      res.writeHead(404).end('not found');
      return;
    }
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      let filePath = normalize(join(clientDist, urlPath === '/' ? 'index.html' : urlPath));
      if (!filePath.startsWith(normalize(clientDist))) throw new Error('traversal');
      let body: Buffer;
      try {
        body = await readFile(filePath);
      } catch {
        filePath = normalize(join(clientDist, 'index.html')); // SPA 回退
        body = await readFile(filePath);
      }
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  // 连接 ↔ (room, player) 绑定表
  const bindings = new Map<WebSocket, { room: Room; player: Player }>();

  wss.on('connection', (ws) => {
    const send = (msg: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    (ws as { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as { isAlive?: boolean }).isAlive = true;
    });
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send({ op: 'error', code: 'bad_json', message: '消息不是合法 JSON' });
        return;
      }
      try {
        dispatch(registry, bindings, ws, send, msg);
      } catch (err) {
        const { code, message } = registry.errorOf(err);
        send({ op: 'error', code, message });
      }
    });
    ws.on('close', () => {
      const binding = bindings.get(ws);
      if (binding) {
        bindings.delete(ws);
        registry.markDisconnected(binding.room, binding.player);
      }
    });
  });

  // 心跳：30s 一轮，未应答即断开（座位保留，ADR-004 §6）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const sock = ws as { isAlive?: boolean };
      if (sock.isAlive === false) {
        ws.terminate();
        continue;
      }
      sock.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  await new Promise<void>((resolve) => httpServer.listen(opts.port, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    httpServer,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        httpServer.close(() => resolve());
      }),
  };
}

function dispatch(
  registry: RoomRegistry,
  bindings: Map<WebSocket, { room: Room; player: Player }>,
  ws: WebSocket,
  send: (msg: ServerMessage) => void,
  msg: ClientMessage,
): void {
  switch (msg.op) {
    case 'ping':
      send({ op: 'pong' });
      return;
    case 'create': {
      const { room, player } = registry.createRoom(msg.name, send as (m: unknown) => void);
      bindings.set(ws, { room, player });
      send({ op: 'hello', playerId: player.id, token: player.token, seat: player.seat, roomId: room.id });
      registry.broadcastRoom(room);
      return;
    }
    case 'join': {
      const { room, player } = registry.joinRoom(msg.roomId, msg.name, send as (m: unknown) => void);
      bindings.set(ws, { room, player });
      send({ op: 'hello', playerId: player.id, token: player.token, seat: player.seat, roomId: room.id });
      registry.broadcastRoom(room);
      return;
    }
    case 'rejoin': {
      const { room, player } = registry.rejoin(msg.roomId, msg.token, send as (m: unknown) => void);
      bindings.set(ws, { room, player });
      send({ op: 'hello', playerId: player.id, token: player.token, seat: player.seat, roomId: room.id });
      registry.broadcastRoom(room);
      if (room.status !== 'lobby') registry.broadcastViews(room);
      return;
    }
    case 'start': {
      const binding = mustBind(bindings, ws);
      registry.startGame(binding.room, binding.player, {
        ...(msg.benchCharacter ? { benchCharacter: msg.benchCharacter } : {}),
        ...(msg.seed !== undefined ? { seed: msg.seed } : {}),
      });
      return;
    }
    case 'add_ai': {
      const binding = mustBind(bindings, ws);
      registry.addAI(binding.room, binding.player);
      return;
    }
    case 'remove_ai': {
      const binding = mustBind(bindings, ws);
      registry.removeAI(binding.room, binding.player, msg.seat);
      return;
    }
    case 'lock_character': {
      const binding = mustBind(bindings, ws);
      registry.lockCharacter(binding.room, binding.player, msg.character);
      return;
    }
    case 'shuffle_seats': {
      const binding = mustBind(bindings, ws);
      registry.shuffleSeats(binding.room, binding.player);
      return;
    }
    case 'cmd': {
      const binding = mustBind(bindings, ws);
      registry.handleCommand(binding.room, binding.player, msg.cmd);
      return;
    }
    default:
      send({ op: 'error', code: 'bad_op', message: '未知操作' });
  }
}

function mustBind(
  bindings: Map<WebSocket, { room: Room; player: Player }>,
  ws: WebSocket,
): { room: Room; player: Player } {
  const binding = bindings.get(ws);
  if (!binding) throw new Error('尚未加入房间');
  return binding;
}

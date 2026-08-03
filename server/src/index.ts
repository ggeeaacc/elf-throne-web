/**
 * @elf-throne/server 入口：:8787 同端口托管 client/dist 与 /ws。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './server.js';

export { createGameServer } from './server.js';
export { RoomRegistry, RoomError } from './rooms.js';
export type { ClientMessage, ServerMessage, RoomSnapshot } from './protocol.js';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env['PORT'] ?? 8787);
  const clientDist = fileURLToPath(new URL('../../client/dist', import.meta.url));
  const server = await createGameServer({
    port,
    ...(existsSync(clientDist) ? { clientDist } : {}),
  });
  console.log(`[elf-throne] server listening on http://localhost:${server.port} (ws: /ws)`);
}

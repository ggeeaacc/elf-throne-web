/**
 * 全链路集成测试：真实 WebSocket 四客户端
 * 「建房 → 加入×3 → 开局 → 初始化四人局 → 行动 → 错误拒收 → 断线重连」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGameServer, type GameServer } from './server.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

class TestClient {
  private ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  token = '';
  seat = -1;
  roomId = '';
  private lastViewSeq = 0;

  /** 等待下一份新视图（按单调 seq 消费，避免命中积压旧视图，ADR-002 §3） */
  waitNextView(timeoutMs = 5000): Promise<Extract<ServerMessage, { op: 'view' }>> {
    return this.wait(
      (m): m is Extract<ServerMessage, { op: 'view' }> => m.op === 'view' && m.seq > this.lastViewSeq,
      timeoutMs,
    ).then((v) => {
      this.lastViewSeq = v.seq;
      return v;
    });
  }

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
      this.queue.push(msg);
    };
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const client = new TestClient(ws);
      ws.onopen = () => resolve(client);
      ws.onerror = () => reject(new Error('ws connect failed'));
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  wait<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 5000): Promise<T> {
    const hit = this.queue.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wait timeout')), timeoutMs);
      this.waiters.push({
        pred: pred as (m: ServerMessage) => boolean,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

const isOp = <T extends ServerMessage['op']>(op: T) =>
  (m: ServerMessage): m is Extract<ServerMessage, { op: T }> => m.op === op;

describe('房间制联机全链路（ADR-002/004）', () => {
  let server: GameServer;
  beforeAll(async () => {
    server = await createGameServer({ port: 0 });
  });
  afterAll(async () => {
    await server.close();
  });

  it('建房→四人入座→开局→四人局状态→行动→鉴权→重连', async () => {
    // ── 建房与加入 ──
    const host = await TestClient.connect(server.port);
    host.send({ op: 'create', name: '主机' });
    const helloHost = await host.wait(isOp('hello'));
    host.token = helloHost.token;
    host.roomId = helloHost.roomId;
    expect(helloHost.seat).toBe(0);
    expect(host.roomId).toMatch(/^[A-Z2-9]{4}$/);

    const others = await Promise.all([1, 2, 3].map(() => TestClient.connect(server.port)));
    for (let i = 0; i < 3; i++) {
      const c = others[i]!;
      c.send({ op: 'join', roomId: host.roomId, name: `玩家${i + 2}` });
      const hello = await c.wait(isOp('hello'));
      c.token = hello.token;
      c.roomId = hello.roomId;
      expect(hello.seat).toBe(i + 1);
    }
    const roomMsg = await host.wait(
      (m): m is Extract<ServerMessage, { op: 'room' }> => m.op === 'room' && m.room.players.length === 4,
    );
    expect(roomMsg.room.players).toHaveLength(4);

    // ── 开局（主机，固定种子便于断言） ──
    host.send({ op: 'start', seed: 2026 });
    const views = [];
    for (const c of [host, ...others]) {
      const v = await c.waitNextView();
      views.push(v);
    }
    // 每个座位收到个性化视图：座位号正确、当前为小鱼回合
    views.forEach((v, i) => {
      expect(v.view.seat).toBe(i);
      expect(v.view.currentTurn?.character).toBe('xiaoyu');
      expect(v.view.phase.kind).toBe('action');
    });
    // 0 号座见小鱼手牌 4 张；1 号座只见小鱼手牌数不见牌面
    expect(views[0]!.view.characters['xiaoyu']?.hand).toHaveLength(4);
    expect(views[1]!.view.characters['xiaoyu']?.hand).toHaveLength(0);
    expect(views[1]!.view.characters['xiaoyu']?.handCount).toBe(4);
    // 初始位置（§四.第二步）
    expect(views[0]!.view.characters['xiaoyu']?.scene).toBe('human_city');
    expect(views[0]!.view.characters['liya']?.scene).toBe('elf_kingdom');

    // ── 鉴权：非当前回合玩家的指令被拒 ──
    others[0]!.send({ op: 'cmd', cmd: { type: 'search', character: 'liya' } });
    const err1 = await others[0]!.wait(isOp('error'));
    expect(err1.code).toBe('not_your_turn');

    // ── 当前玩家行动：小鱼搜索（1 AP 抽 2）──
    host.send({ op: 'cmd', cmd: { type: 'search', character: 'xiaoyu' } });
    const afterSearch = await host.waitNextView();
    expect(afterSearch.view.characters['xiaoyu']?.hand).toHaveLength(6);
    expect(afterSearch.view.characters['xiaoyu']?.ap).toBe(2);

    // ── 非法指令被引擎拒绝且不污染他人（control-manifest §9）──
    host.send({ op: 'cmd', cmd: { type: 'move', character: 'xiaoyu', to: 'elf_kingdom' } });
    const err2 = await host.wait(isOp('error'));
    expect(err2.code).toBe('not_adjacent');
    // 其余客户端同步消化搜索广播，避免下步命中陈旧视图
    for (const c of others) await c.waitNextView();

    // ── 结束回合 → 轮到莉雅（1 号座可行动）──
    host.send({ op: 'cmd', cmd: { type: 'end_turn', character: 'xiaoyu' } });
    const v2 = await others[0]!.waitNextView();
    expect(v2.view.currentTurn?.character).toBe('liya');

    // ── 断线重连：token 恢复座位与最新视图（ADR-004）──
    const ghost = others[2]!; // 3 号座
    const ghostToken = ghost.token;
    ghost.close();
    await new Promise((r) => setTimeout(r, 200));
    const back = await TestClient.connect(server.port);
    back.send({ op: 'rejoin', roomId: host.roomId, token: ghostToken });
    const helloBack = await back.wait(isOp('hello'));
    expect(helloBack.seat).toBe(3);
    const viewBack = await back.waitNextView();
    expect(viewBack.view.currentTurn?.character).toBe('liya');

    for (const c of [host, others[0]!, others[1]!, back]) c.close();
  }, 15000);

  it('错误房间号/令牌被拒', async () => {
    const c = await TestClient.connect(server.port);
    c.send({ op: 'join', roomId: 'ZZZZ', name: 'x' });
    const err = await c.wait(isOp('error'));
    expect(err.code).toBe('no_such_room');
    c.send({ op: 'rejoin', roomId: 'ZZZZ', token: 'bad' });
    const err2 = await c.wait(isOp('error'));
    expect(err2.code).toBe('no_such_room');
    c.close();
  });
});

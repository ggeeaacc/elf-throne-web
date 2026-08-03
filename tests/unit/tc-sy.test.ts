/**
 * TC-SY 联机同步与确定性 回归用例（docs/qa/test-cases.md）。
 * 注：TC-SY-006/007 与 server/src/room.test.ts 互补（QA 独立最小链路）；TC-SY-008 为引擎层整局回放。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCommand } from '../../engine/src/actions.js';
import { projectEvents, projectView } from '../../engine/src/view.js';
import { dealDamageToBoss } from '../../engine/src/systems/combat.js';
import {
  answer,
  cfg1,
  cfg2,
  cfg3,
  cfg4,
  clearCrises,
  createInitialState,
  evs,
  freshGame,
  mut,
  passRound,
  playPassCopy,
  putCrisis,
  sustain,
  toBattle,
  topCrisis,
} from '../helpers/regression-utils.js';
import { beginGame } from '../../engine/src/actions.js';
import { settle } from '../helpers/regression-utils.js';
import type { GameConfig, GameEvent, GameState } from '../../engine/src/types.js';

function driveToBattle(cfg: GameConfig): GameState {
  let s = freshGame(cfg);
  for (let r = 0; r < 9 && s.phase.kind !== 'final_battle' && !s.result; r++) {
    s = passRound(s);
    s = sustain(s);
  }
  return s;
}

/** 最小 WS 测试客户端工厂（谓词等待，避免命中积压广播） */
async function wsClient(port: number) {
  const { WebSocket } = await import('ws');
  type Msg = Record<string, unknown> & { op: string };
  type View = {
    currentTurn: { character: string } | null;
    phase: { kind: string };
    characters: Record<string, { handCount: number; hand: string[] }>;
    pendingDecision: { id: string; kind: string; decider: string } | null;
  };
  return async function connect(): Promise<{
    send: (m: Record<string, unknown>) => void;
    waitOp: (op: string, timeoutMs?: number) => Promise<Msg>;
    waitView: (pred: (v: View) => boolean, timeoutMs?: number) => Promise<View>;
    close: () => void;
  }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const queue: Msg[] = [];
      const waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void; timer: NodeJS.Timeout }> = [];
      const onMsg = (data: unknown) => {
        const m = JSON.parse(String(data)) as Msg;
        const i = waiters.findIndex((w) => w.pred(m));
        if (i >= 0) {
          const [w] = waiters.splice(i, 1);
          clearTimeout(w!.timer);
          w!.resolve(m);
        } else {
          queue.push(m);
        }
      };
      ws.on('message', onMsg);
      ws.on('error', reject);
      const waitFor = (pred: (m: Msg) => boolean, timeoutMs: number, label: string): Promise<Msg> => {
        const hit = queue.find(pred);
        if (hit) {
          queue.splice(queue.indexOf(hit), 1);
          return Promise.resolve(hit);
        }
        return new Promise<Msg>((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`waitFor ${label} 超时`)), timeoutMs);
          waiters.push({ pred, resolve: res, timer });
        });
      };
      ws.on('open', () =>
        resolve({
          send: (m) => ws.send(JSON.stringify(m)),
          waitOp: (op, timeoutMs = 8000) => waitFor((m) => m.op === op, timeoutMs, op),
          waitView: (pred, timeoutMs = 8000) =>
            waitFor((m) => m.op === 'view' && pred((m as { view: View }).view), timeoutMs, 'view').then((m) => (m as { view: View }).view),
          close: () => ws.close(),
        }),
      );
    });
  };
}

/**
 * 开局决策消化并返回行动相位视图：P1 翻到通用危机卡时引擎挂起 place_crisis。
 * 由决策人（本套件中主机=小鱼座位）回答落点，直到行动相位开始；
 * 返回值即行动相位视图（调用方勿再 waitView，否则会等下一份变更视图而超时）。
 */
async function settleOpening(client: {
  send: (m: Record<string, unknown>) => void;
  waitView: (pred: (v: { currentTurn: { character: string } | null; phase: { kind: string }; pendingDecision: { id: string; kind: string } | null }) => boolean, timeoutMs?: number) => Promise<{ currentTurn: { character: string } | null; phase: { kind: string }; pendingDecision: { id: string; kind: string } | null }>;
}): Promise<{ currentTurn: { character: string } | null; phase: { kind: string } }> {
  for (let i = 0; i < 8; i++) {
    const v = await client.waitView((x) => x.currentTurn !== null || x.pendingDecision !== null);
    if (v.currentTurn !== null) return v;
    client.send({ op: 'cmd', cmd: { type: 'resolve_decision', decisionId: v.pendingDecision!.id, choice: { scene: 'human_city' } } });
  }
  throw new Error('开局决策消化超过 8 轮仍未进入行动相位');
}

describe('TC-SY 联机同步与确定性', () => {
  it('TC-SY-001 回放确定性：同种子同指令流逐字节同终态【ADR-003】【§12】', () => {
    const run = () => {
      let s = freshGame();
      for (let r = 0; r < 3; r++) {
        s = passRound(s);
        s = sustain(s);
      }
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
    // 异种子不同
    const a = createInitialState(cfg4);
    const b = createInitialState({ ...cfg4, seed: 999 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('TC-SY-002 引擎零真随机：无 Math.random/Date.now【ADR-003】', () => {
    const dir = fileURLToPath(new URL('../../engine/src', import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src.includes('Math.random'), `${f} 含 Math.random`).toBe(false);
      expect(/Date\.now|new Date\(/.test(src), `${f} 含 Date.now/new Date`).toBe(false);
    }
  });

  it('TC-SY-003 视图投影：他人手牌与牌库序隐藏【§12】【ADR-002】', () => {
    const s = freshGame();
    const v1 = projectView(s, 1); // 莉雅座位
    // 自己手牌可见；他人仅计数
    expect(v1.characters['liya']?.hand.length).toBe(4);
    expect(v1.characters['xiaoyu']?.hand).toHaveLength(0);
    expect(v1.characters['xiaoyu']?.handCount).toBe(4);
    // 牌库仅计数
    expect(v1.decks.crisisCount).toBe(29 - 2); // 开局翻 2（D1 4P 翻牌量）
    expect(typeof v1.decks.bondCount).toBe('number');
    expect(typeof v1.decks.letterCount).toBe('number');
    expect('crisis' in v1.decks).toBe(false); // 无顺序信息
    // 卡注册表只含可见卡（他人手牌不在内）
    const xiaoyuHandUid = s.characters['xiaoyu']!.hand[0]!;
    expect(v1.cards[xiaoyuHandUid]).toBeUndefined();
    // 事件脱敏：他人抽牌事件牌面置空
    const events = [{ kind: 'card_drawn', character: 'xiaoyu', cardUid: 'yu-01#0', cardDefId: 'yu-01' } as const];
    const masked = projectEvents([...events], s, 1);
    expect(masked[0]!.cardUid).toBe('');
    const own = projectEvents([...events], s, 0);
    expect(own[0]!.cardUid).toBe('yu-01#0');
  });

  it('TC-SY-004 背面信息隐藏：待收书信与旁置通牒卡【§12】', () => {
    let s = freshGame();
    // 小鱼发信给莉雅
    s = applyCommand(s, { type: 'send_letter', character: 'xiaoyu', cardUid: s.characters['xiaoyu']!.hand[0]! }).state;
    const letterUid = s.characters['liya']!.pendingLetter!.cardUid;
    const vBaye = projectView(s, 3); // 巴爷座位（第三方）
    expect(vBaye.characters['liya']?.pendingLetter?.cardUid).toBeNull(); // 仅见存在性
    const vLiya = projectView(s, 1);
    expect(vLiya.characters['liya']?.pendingLetter?.cardUid).toBe(letterUid); // 接收方可见
    const vXiaoyu = projectView(s, 0);
    expect(vXiaoyu.characters['liya']?.pendingLetter?.cardUid).toBe(letterUid); // 发送方可见
    // 第三方卡注册表不含书信牌面
    expect(vBaye.cards[letterUid]).toBeUndefined();
    // 旁置通牒卡不下发（视图无此字段、卡注册表不含）
    expect('ultimatumAsideUid' in vBaye).toBe(false);
    expect(vBaye.cards[s.ultimatumAsideUid!]).toBeUndefined();
  });

  it('TC-SY-005 pendingDecision 中断-续算：通用危机卡落点协商【ADR-003】【§12】', () => {
    let s0 = createInitialState(cfg4);
    s0 = topCrisis(s0, 'crisis-01');
    let s = beginGame(s0).state; // P1 翻通用卡 → 挂起
    expect(s.pendingDecision?.kind).toBe('place_crisis');
    // 中断期间无关指令拒绝（decision_pending）
    expect(() => applyCommand(s, { type: 'search', character: 'xiaoyu' })).toThrow(/待决策/);
    // 状态未被污染（危机未落位）
    expect(Object.values(s.scenes).reduce((n, sc) => n + sc.crisisCards.length, 0)).toBe(0);
    // 续算后正确放置
    s = answer(s, { scene: 'elf_kingdom' });
    expect(s.scenes['elf_kingdom'].crisisCards.length).toBe(1);
    expect(s.phase.kind).toBe('action');
  });

  it('TC-SY-006 服务端集成：建房→4 人入座→开局→行动→错误指令拒收【ADR-002/004】', async () => {
    const { createGameServer } = await import('../../server/src/server.js');
    const server = await createGameServer({ port: 0 });
    try {
      const client = await wsClient(server.port);
      const host = await client();
      host.send({ op: 'create', name: 'QA主机' });
      const hello0 = await host.waitOp('hello');
      expect((hello0 as { seat: number }).seat).toBe(0);
      const roomId = (hello0 as { roomId: string }).roomId;
      const others = [];
      for (let i = 1; i < 4; i++) {
        const c = await client();
        c.send({ op: 'join', roomId, name: `QA${i}` });
        const hello = await c.waitOp('hello');
        expect((hello as { seat: number }).seat).toBe(i);
        others.push(c);
      }
      host.send({ op: 'start', seed: 7 });
      // 开局 P1 可能翻通用卡挂起放置决策：由主机回答并直接取回行动相位视图（勿重复 waitView）
      const v0 = await settleOpening(host);
      expect(v0.currentTurn?.character).toBe('xiaoyu');
      expect(v0.phase.kind).toBe('action');
      // 非回合指令拒收（1 号座莉雅回合未到）
      others[0]!.send({ op: 'cmd', cmd: { type: 'search', character: 'liya' } });
      const err = await others[0]!.waitOp('error');
      expect((err as { code: string }).code).toBe('not_your_turn');
      // 当前玩家合法行动：搜索后手牌数 6
      host.send({ op: 'cmd', cmd: { type: 'search', character: 'xiaoyu' } });
      const v1 = await host.waitView((v) => v.currentTurn !== null && v.characters['xiaoyu']?.handCount === 6);
      expect(v1.characters['xiaoyu']?.handCount).toBe(6);
      host.close();
      for (const c of others) c.close();
    } finally {
      await server.close();
    }
  }, 15000);

  it('TC-SY-007 断线重连：token 恢复座位与最新视图；错 token 拒绝【ADR-004】', async () => {
    const { createGameServer } = await import('../../server/src/server.js');
    const server = await createGameServer({ port: 0 });
    try {
      const client = await wsClient(server.port);
      const host = await client();
      host.send({ op: 'create', name: 'QA' });
      const hello = await host.waitOp('hello');
      const { token, roomId } = hello as { token: string; roomId: string };
      for (let i = 1; i < 4; i++) {
        const c = await client();
        c.send({ op: 'join', roomId, name: `p${i}` });
        await c.waitOp('hello');
      }
      host.send({ op: 'start', seed: 11 });
      await settleOpening(host);
      // 断线重连：token 恢复座位 0 + 最新视图
      host.close();
      const back = await client();
      back.send({ op: 'rejoin', roomId, token });
      const helloBack = await back.waitOp('hello');
      expect((helloBack as { seat: number }).seat).toBe(0);
      const viewBack = await back.waitView((v) => v.currentTurn !== null);
      expect(viewBack.currentTurn).not.toBeNull();
      // 错 token 拒绝
      const bad = await client();
      bad.send({ op: 'rejoin', roomId, token: 'bad-token' });
      const errBad = await bad.waitOp('error');
      expect(errBad.op).toBe('error');
      back.close();
      bad.close();
    } finally {
      await server.close();
    }
  }, 15000);

  it('TC-SY-008 端到端回放冒烟：1/2/3/4 人各一局打穿至决战终局、同种子逐字节一致【§2.1】【ADR-003】', () => {
    for (const cfg of [cfg4, cfg3, cfg2, cfg1]) {
      const runOnce = (): string => {
        let s = driveToBattle(cfg);
        expect(s.phase.kind).toBe('final_battle');
        // 决战：护盾 → P2 → P3 → 击杀（直接伤害驱动三阶段全经历）
        const d = structuredClone(s);
        const events: GameEvent[] = [];
        dealDamageToBoss(d, events, 99, 'xiaoyu', true); // 破盾 → P2
        expect(d.boss?.stage).toBe(2);
        dealDamageToBoss(d, events, Math.ceil(d.boss!.maxHp / 2) + 1, 'xiaoyu', true); // 压至 ≤ 半 → P3
        expect(d.boss?.stage).toBe(3);
        dealDamageToBoss(d, events, 99, 'xiaoyu', true); // 击杀
        expect(d.result?.outcome).toBe('victory');
        d.log.push(...events);
        return JSON.stringify(d);
      };
      expect(runOnce()).toBe(runOnce()); // 逐字节回放一致
    }
  });
});

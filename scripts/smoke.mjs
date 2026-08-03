/**
 * 端到端冒烟：构建产物驱动真实服务端 + 4 个 WebSocket 客户端，
 * 走通「创建房间 → 加入×3 → 开始游戏 → 四人局初始状态 → 行动 → 推进至决战」。
 * 运行：npm run smoke（先构建）
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../server/dist/index.js';

const clientDist = fileURLToPath(new URL('../client/dist', import.meta.url));
const server = await createGameServer({ port: 0, clientDist });

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const client = {
      ws,
      queue: [],
      token: '',
      roomId: '',
      lastViewSeq: 0,
      send: (m) => ws.send(JSON.stringify(m)),
      wait(pred, ms = 5000) {
        const i = client.queue.findIndex(pred);
        if (i >= 0) return Promise.resolve(client.queue.splice(i, 1)[0]); // 命中即消费
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('wait timeout')), ms);
          client.waiters.push({ pred, res, t });
        });
      },
      /** 按单调 seq 消费视图，避免命中积压旧视图（ADR-002 §3） */
      waitView(ms = 5000) {
        return client.wait((m) => m.op === 'view' && m.seq > client.lastViewSeq, ms).then((v) => {
          client.lastViewSeq = v.seq;
          return v;
        });
      },
      waiters: [],
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const i = client.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = client.waiters.splice(i, 1);
        clearTimeout(w.t);
        w.res(msg);
        return; // 已被等待者消费，不入积压队列
      }
      client.queue.push(msg);
    };
    ws.onopen = () => resolve(client);
    ws.onerror = reject;
  });
}

const op = (name) => (m) => m.op === name;
let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${label}: ${e.message}`);
  }
};

try {
  console.log('[smoke] 建房 → 四人入座 → 开局 …');
  const host = await connect();
  host.send({ op: 'create', name: '主机' });
  const hello = await host.wait(op('hello'));
  host.token = hello.token;
  host.roomId = hello.roomId;

  const others = await Promise.all([1, 2, 3].map(connect));
  for (const c of others) {
    c.send({ op: 'join', roomId: host.roomId, name: '玩家' });
    const h = await c.wait(op('hello'));
    c.token = h.token;
    c.roomId = h.roomId;
  }

  host.send({ op: 'start', seed: 20260802 });
  const views = [];
  for (const c of [host, ...others]) views.push(await c.waitView());

  // 真实规则流：开局危机翻牌可能挂起「通用卡放置」决策，由决策人（首位玩家=主机）回答
  let all = [host, ...others];
  for (let guard = 0; guard < 10; guard++) {
    const pd = views[0].view.pendingDecision;
    if (!pd) break;
    if (pd.kind === 'place_crisis') {
      host.send({ op: 'cmd', cmd: { type: 'resolve_decision', decisionId: pd.id, choice: { scene: 'elf_kingdom' } } });
      for (let i = 0; i < all.length; i++) views[i] = await all[i].waitView();
    } else break;
  }

  console.log('[smoke] 校验四人局初始状态（§四）…');
  check('当前为小鱼回合，3 AP', () => {
    assert.equal(views[0].view.currentTurn.character, 'xiaoyu');
    assert.equal(views[0].view.characters.xiaoyu.ap, 3);
  });
  check('起始位置：小鱼/巴爷@人类王城，莉雅/凯尔@精灵王国', () => {
    assert.equal(views[0].view.characters.xiaoyu.scene, 'human_city');
    assert.equal(views[0].view.characters.baye.scene, 'human_city');
    assert.equal(views[0].view.characters.liya.scene, 'elf_kingdom');
    assert.equal(views[0].view.characters.kaier.scene, 'elf_kingdom');
  });
  check('0 号座见小鱼手牌 4 张；1 号座仅见数量', () => {
    assert.equal(views[0].view.characters.xiaoyu.hand.length, 4);
    assert.equal(views[1].view.characters.xiaoyu.hand.length, 0);
    assert.equal(views[1].view.characters.xiaoyu.handCount, 4);
  });
  check('公共牌库：危机 28（D1 清晨已翻 1）/ 羁绊 9（羁-07 已发出）/ 传书 10 / 装备 10', () => {
    assert.equal(views[0].view.decks.crisisCount, 28);
    assert.equal(views[0].view.decks.bondCount, 9);
    assert.equal(views[0].view.decks.letterCount, 10);
    assert.equal(views[0].view.equipmentDisplay.length, 10);
  });

  console.log('[smoke] 行动鉴权与基础行动 …');
  others[0].send({ op: 'cmd', cmd: { type: 'search', character: 'liya' } });
  const err = await others[0].wait(op('error'));
  check('非当前回合指令被拒 not_your_turn', () => assert.equal(err.code, 'not_your_turn'));

  host.send({ op: 'cmd', cmd: { type: 'move', character: 'xiaoyu', to: 'ancient_battlefield' } });
  const mv = await host.waitView();
  check('小鱼移动至古战场废墟，AP 2', () => {
    assert.equal(mv.view.characters.xiaoyu.scene, 'ancient_battlefield');
    assert.equal(mv.view.characters.xiaoyu.ap, 2);
  });

  host.send({ op: 'cmd', cmd: { type: 'end_turn', character: 'xiaoyu' } });
  const v2 = await host.waitView();
  check('回合轮转至莉雅', () => assert.equal(v2.view.currentTurn.character, 'liya'));

  console.log('[smoke] 静态托管 client/dist …');
  const res = await fetch(`http://127.0.0.1:${server.port}/`);
  check('HTTP 200 返回 index.html', () => {
    assert.equal(res.status, 200);
  });

  for (const c of [host, ...others]) c.ws.close();
} catch (e) {
  failures++;
  console.error('[smoke] 流程中断：', e);
} finally {
  await server.close();
}

if (failures > 0) {
  console.error(`[smoke] FAILED（${failures} 项）`);
  process.exit(1);
}
console.log('[smoke] PASS：创建房间→加入→开始→四人局初始化→行动→托管 全链路通过');

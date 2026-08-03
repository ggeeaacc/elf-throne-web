/**
 * AI 人机队友验收（服务端托管 + 启发式行动）。
 * Part A（WS 级，in-process 服务端）：1 真人 ws + 3 AI → 开局 → 真人最小自动应答（自己决策/回合秒过），
 *   跑到第 3 轮，断言：AI 座位标记、AI 自动应答开局决策、🤖 行动日志、AI 角色引擎事件、
 *   真人视角状态同步（moved 事件与后续 view 一致）、无 internal 错误、无死循环（限时内到达）。
 * Part B（浏览器）：in-process 服务端（port 0）+ headless Edge → UI 点 + AI 补位×3（测大厅 UI）→ 开局 →
 *   页面侧自动人秒过自己回合 → 等 🤖 日志出现 → 截图 production/bot-gameview.png（+ bot-lobby.png）。
 * 运行：node scripts/bot-verify.mjs（自包含，无需外部服务端）
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../server/dist/index.js';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT_DIR = fileURLToPath(new URL('../production', import.meta.url));
const TMP = fileURLToPath(new URL('../.edge-bot-profile', import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真人座位最小自动应答（与 server AI 同策略：第一合法项；仅视角 options 驱动） */
function autoChoice(d) {
  const o = d.options ?? {};
  switch (d.kind) {
    case 'place_crisis': return { scene: o.scenes[0] };
    case 'choose_character': return { character: o.candidates[0] };
    case 'choose_crisis': return { cardUid: o.cardUids?.[0] ?? null };
    case 'choose_bond_card': return { cardUid: o.candidateUids[0] };
    case 'choose_option': return { option: o.options[0].id };
    case 'choose_cards': return { cardUids: o.cardUids.slice(0, o.min ?? 1) };
    case 'order_effects': return { order: o.items.map((i) => i.uid) };
    case 'reorder_cards': return o.mode === 'scout' ? { bottom: o.cardUids[0] } : { order: o.cardUids };
    case 'choose_share_high': return { highTaker: o.candidates[0] };
    case 'choose_redirect': return { buffId: o.candidates[0].buffId };
    case 'choose_equipment': return { equipmentUid: o.equipmentUids[0], owner: o.owners?.[0] };
    default: return {};
  }
}

// ═══════════════════════════ Part A：WS 级验收 ═══════════════════════════
async function partA() {
  console.log('[bot-verify/A] in-process 服务端 + 1 真人 ws + 3 AI …');
  const clientDist = fileURLToPath(new URL('../client/dist', import.meta.url));
  const server = await createGameServer({ port: 0, clientDist });
  const url = `ws://127.0.0.1:${server.port}/ws`;

  const queue = [];
  const waiters = [];
  const ws = new WebSocket(url);
  const state = {
    roomSnaps: [],
    lastView: null,
    viewSeqs: 0,
    aiDecisionLogs: 0,
    aiActionLogs: 0,
    aiEvents: [],
    movedChecks: { seen: [] },
    internalErrors: 0,
    errors: [],
    maxRound: 0,
    myChars: [],
    aiChars: [],
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    // 状态追踪 + 真人自动应答：每条消息都跑（含被 wait 消费的首条 view）
    if (msg.op === 'room') state.roomSnaps.push(msg.room);
    if (msg.op === 'error') {
      state.errors.push(msg);
      if (msg.code === 'internal') state.internalErrors++;
    }
    if (msg.op === 'log' && msg.text.includes('🤖')) {
      if (msg.text.includes('决策')) state.aiDecisionLogs++;
      else state.aiActionLogs++;
    }
    if (msg.op === 'view') {
      state.viewSeqs = msg.seq;
      state.lastView = msg.view;
      state.maxRound = Math.max(state.maxRound, msg.view.phase?.round ?? 0);
      if (!state.myChars.length) {
        state.myChars = msg.view.controlledCharacters;
        state.aiChars = msg.view.turnOrder.filter((c) => !state.myChars.includes(c));
      }
      for (const e of msg.events) {
        if (state.aiChars.length && state.aiChars.includes(e.character)) state.aiEvents.push(e.kind);
        if (e.kind === 'moved' && state.aiChars.includes(e.character)) state.movedChecks.seen.push({ character: e.character, to: e.to, seq: msg.seq });
      }
      // 真人最小自动应答：自己的决策秒答，自己的回合秒结束（把舞台让给 AI）
      const v = msg.view;
      const d = v.pendingDecision;
      if (d && d.options && v.controlledCharacters.includes(d.decider)) {
        ws.send(JSON.stringify({ op: 'cmd', cmd: { type: 'resolve_decision', decisionId: d.id, choice: autoChoice(d) } }));
      } else if (!d && v.currentTurn && v.controlledCharacters.includes(v.currentTurn.character) && !v.result) {
        ws.send(JSON.stringify({ op: 'cmd', cmd: { type: 'end_turn', character: v.currentTurn.character } }));
      }
    }
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.t);
      w.res(msg);
      return;
    }
    queue.push(msg);
  };
  const wait = (pred, ms = 8000) =>
    new Promise((res, rej) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return res(queue.splice(i, 1)[0]);
      const t = setTimeout(() => rej(new Error('wait timeout')), ms);
      waiters.push({ pred, res, t });
    });
  const send = (m) => ws.send(JSON.stringify(m));
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });

  try {
    send({ op: 'create', name: '真人' });
    const hello = await wait((m) => m.op === 'hello');
    send({ op: 'add_ai' });
    send({ op: 'add_ai' });
    send({ op: 'add_ai' });
    const full = await wait((m) => m.op === 'room' && m.room.players.length === 4);
    check('大厅 3 个 AI 座位标记（ai:true）', full.room.players.filter((p) => p.ai).length === 3, full.room.players.map((p) => `${p.name}${p.ai ? '(AI)' : ''}`).join(','));
    check('真人座位非 AI', full.room.players.find((p) => p.seat === hello.seat)?.ai === false);

    send({ op: 'start', seed: 20260803 });
    await wait((m) => m.op === 'view');

    // 推进至第 3 轮（AI 微延迟行动，真人秒过；上限 150s 防死循环即超时失败）
    const deadline = Date.now() + 150_000;
    while (state.maxRound < 3 && Date.now() < deadline && !state.lastView?.result) await sleep(500);
    const v = state.lastView;
    check('对局推进到第 3 轮（无死循环/无崩溃，限时内到达）', state.maxRound >= 3, `day=${v?.phase?.day} round=${state.maxRound}`);
    check('AI 自动应答决策（🤖 决策日志 ≥1）', state.aiDecisionLogs >= 1, `${state.aiDecisionLogs} 条`);
    check('AI 有效行动（🤖 行动日志 ≥3）', state.aiActionLogs >= 3, `${state.aiActionLogs} 条`);
    check('AI 角色引擎事件（moved/card_drawn/card_played 等）', state.aiEvents.length >= 3, [...new Set(state.aiEvents)].join(','));
    // 真人视角状态同步：任一 AI moved 事件的目标场景与后续 view 中该角色所在场景一致
    let syncOk = false;
    let syncDetail = '无 moved 事件';
    for (const mv of state.movedChecks.seen) {
      const cur = state.lastView?.characters?.[mv.character]?.scene;
      if (cur === mv.to) {
        syncOk = true;
        syncDetail = `${mv.character}→${mv.to}`;
        break;
      }
      // 该角色可能又移动了：检查最后一次记录
      const lastOf = [...state.movedChecks.seen].reverse().find((x) => x.character === mv.character);
      if (lastOf && state.lastView?.characters?.[mv.character]?.scene === lastOf.to) {
        syncOk = true;
        syncDetail = `${mv.character}→${lastOf.to}（最新）`;
        break;
      }
    }
    check('真人视角可见 AI 移动后的版图状态', syncOk, syncDetail);
    check('无 internal 错误', state.internalErrors === 0, state.errors.map((e) => e.code).slice(0, 5).join(',') || '无错误');
    console.log(`[bot-verify/A] 观测：🤖决策 ${state.aiDecisionLogs} ｜ 🤖行动 ${state.aiActionLogs} ｜ AI事件 ${state.aiEvents.length} ｜ view seq ${state.viewSeqs}`);
  } finally {
    try { ws.close(); } catch { /* 忽略 */ }
    await server.close();
  }
}

// ═══════════════════════════ Part B：浏览器截图验收 ═══════════════════════════
async function partB() {
  console.log('[bot-verify/B] in-process 服务端 + headless Edge（大厅 UI + 对局截图）…');
  const clientDist = fileURLToPath(new URL('../client/dist', import.meta.url));
  const server = await createGameServer({ port: 0, clientDist });
  const base = `http://127.0.0.1:${server.port}`;
  const edge = spawn(
    EDGE,
    ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${TMP}`, '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const browserWs = await new Promise((res, rej) => {
    let buf = '';
    edge.stderr.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) res(m[1]);
    });
    edge.on('exit', () => rej(new Error(`Edge 提前退出：${buf.slice(-400)}`)));
    setTimeout(() => rej(new Error(`等待 DevTools 超时：${buf.slice(-400)}`)), 20000);
  });
  const ws = new WebSocket(browserWs);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let msgId = 0;
  const pendingCmds = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pendingCmds.has(m.id)) {
      const { res, rej } = pendingCmds.get(m.id);
      pendingCmds.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message} (${m.error.code})`));
      else res(m.result);
    }
  };
  const cdp = (method, params = {}, sessionId = undefined) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pendingCmds.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  const { targetId } = await cdp('Target.createTarget', { url: base });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  await cdp('Page.enable', {}, sessionId);
  const evalJs = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`页面脚本错误：${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  };
  const shot = async (file) => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    writeFileSync(`${OUT_DIR}/${file}`, Buffer.from(data, 'base64'));
    console.log(`[bot-verify/B] 截图 → production/${file}`);
  };

  /** 页面侧真人自动步进：解决策或结束回合（把舞台让给 AI） */
  const INSTALL_STEP = `window.__step = function(){
    const dec = document.getElementById('decision');
    if (dec && dec.style.display !== 'none') {
      const orderables = [...dec.querySelectorAll('.orderable:not(.sel)')];
      if (orderables.length) { orderables[0].click(); return 'order'; }
      const submitOrder = dec.querySelector('.submit-order');
      if (submitOrder) { submitOrder.click(); return 'order-submit'; }
      const pick = dec.querySelector('.pickable:not(.sel)');
      if (pick) { pick.click(); return 'pick'; }
      const submitCards = dec.querySelector('.submit-cards');
      if (submitCards) { submitCards.click(); return 'pick-submit'; }
      const btns = [...dec.querySelectorAll('button[data-choice]')];
      if (btns.length) { btns[0].click(); return 'decision'; }
      return 'dec-wait';
    }
    const end = [...document.querySelectorAll('#actions button')].find(b=>b.textContent.includes('结束回合'));
    if (end) {
      const before = document.getElementById('status').textContent;
      end.click();
      return new Promise(res=>{
        const t = setInterval(()=>{ if (document.getElementById('status').textContent !== before) { clearInterval(t); res('turn'); } }, 120);
        setTimeout(()=>{ clearInterval(t); res('stall'); }, 4000);
      });
    }
    return 'wait';
  }`;

  try {
    for (let i = 0; i < 50; i++) {
      if (await evalJs(`document.readyState === 'complete' && !!document.getElementById('create')`)) break;
      await sleep(200);
    }
    await evalJs(`localStorage.clear(); (document.getElementById('name').value='真人', document.getElementById('create').click(), true)`);
    const lobbyOk = await evalJs(`new Promise(r=>{const t=setInterval(()=>{if(document.getElementById('addAi').style.display!=='none'){clearInterval(t);r(true)}},100);setTimeout(()=>{clearInterval(t);r(false)},8000)})`);
    check('主机大厅显示「+ AI 补位」按钮', lobbyOk === true);
    for (let k = 0; k < 3; k++) {
      await evalJs(`(document.getElementById('addAi').click(), true)`);
      await sleep(250);
    }
    const lobby = await evalJs(`({
      aiRows: (document.getElementById('players').textContent.match(/🤖AI/g) ?? []).length,
      rmBtns: document.querySelectorAll('#players .rmAi').length,
      addAiHiddenAfterFull: document.getElementById('addAi').style.display === 'none',
    })`);
    check('大厅座位列表标注 3 个 🤖AI + 移出按钮', lobby.aiRows === 3 && lobby.rmBtns === 3, `AI行=${lobby.aiRows} 移出=${lobby.rmBtns}`);
    check('满员后「+ AI」自动隐藏', lobby.addAiHiddenAfterFull);
    await shot('bot-lobby.png');

    await evalJs(`(document.getElementById('start').click(), true)`);
    const handReady = await evalJs(`new Promise(r=>{const t=setInterval(()=>{if(document.querySelectorAll('#hand .handcard').length>0){clearInterval(t);r(true)}},150);setTimeout(()=>{clearInterval(t);r(false)},10000)})`);
    if (!handReady) throw new Error('开局失败');
    await evalJs(INSTALL_STEP);
    // 步进直到日志出现 ≥3 条 🤖（AI 行动被真人观战到）
    let botLines = 0;
    for (let i = 0; i < 240 && botLines < 3; i++) {
      await evalJs(`window.__step()`);
      await sleep(200);
      botLines = await evalJs(`(document.getElementById('log').textContent.match(/🤖/g) ?? []).length`);
    }
    check('真人视角日志出现 AI 行动记录（🤖 ≥3）', botLines >= 3, `${botLines} 条`);
    const sample = await evalJs(`[...document.querySelectorAll('#log div')].filter(d=>d.textContent.includes('🤖')).slice(0,3).map(d=>d.textContent.trim())`);
    console.log('[bot-verify/B] 🤖 日志样例：', sample.join(' ｜ '));
    const boardTxt = await evalJs(`document.getElementById('scenes').textContent`);
    check('版图渲染正常（四场景在列）', ['人类王城', '精灵王国', '古战场废墟', '黑暗山谷'].every((s) => boardTxt.includes(s)));
    await shot('bot-gameview.png');
  } finally {
    try { await cdp('Browser.close'); } catch { /* 忽略 */ }
    edge.kill();
    await server.close();
  }
}

await partA();
await partB();

if (failures > 0) {
  console.error(`[bot-verify] FAILED（${failures} 项）`);
  process.exit(1);
}
console.log('[bot-verify] PASS：AI 补位（大厅标记/自动决策/启发式行动/真人观战）全链路通过');

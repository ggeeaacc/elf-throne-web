/**
 * 浏览器自验（客户端可用性：卡面效果文案可见性）。
 * 前提：服务端已在 :8787 运行（node server/dist/index.js）。
 * 流程：headless Edge + CDP → 创建单人房 → 开局 → 校验手牌卡块含效果全文、
 *       危机/装备浮层存在 → 自动打完一整局（智能放置通用危机、只结束回合）
 *       → 校验玫拉面板阶段规则提示 → 截图落盘 production/。
 * 运行：node scripts/verify-ui.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = process.env['BASE_URL'] ?? 'http://127.0.0.1:8787';
const OUT_DIR = fileURLToPath(new URL('../production', import.meta.url));
const TMP = fileURLToPath(new URL('../.edge-verify-profile', import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 启动 headless Edge ────────────────────────────────────────────────────────
console.log('[verify-ui] 启动 headless Edge …');
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

// ── CDP 客户端 ────────────────────────────────────────────────────────────────
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

const { targetId } = await cdp('Target.createTarget', { url: BASE });
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
  console.log(`[verify-ui] 截图 → production/${file}`);
};

/** 页面侧单步推进器：解决策（按钮/排序/多选三类）或结束回合；通用危机智能落点 */
const INSTALL_STEP = `window.__step = function(){
  const boss = document.querySelector('#bossPanel .boss');
  if (boss) return 'boss';
  if (/胜利|失败/.test(document.getElementById('status').textContent)) return 'over';
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
    if (btns.length) {
      const isPlace = dec.textContent.includes('放置到哪个场景');
      if (isPlace) {
        // 通用危机落点：宝玉侵蚀避开有角色的场景（防小鱼侵蚀暴走）；其余放危机最少场景
        const sceneNames = ['人类王城','精灵王国','古战场废墟','黑暗山谷'];
        const rows = [...document.querySelectorAll('#scenes .scene')].map(el=>({
          name: el.querySelector('b')?.textContent ?? '', n: el.querySelectorAll('.crisis').length }));
        let pool = btns;
        if (dec.textContent.includes('黑暗宝玉侵蚀')) {
          const busy = new Set();
          document.querySelectorAll('#chars .panel').forEach(p=>{
            for (const s of sceneNames) if (p.textContent.includes(s)) busy.add(s);
          });
          const free = btns.filter(b=>!busy.has(b.textContent));
          if (free.length) pool = free;
        }
        const counts = pool.map(b=> rows.find(r=>r.name===b.textContent)?.n ?? 0);
        const min = Math.min(...counts);
        const tied = pool.filter((b,i)=>counts[i]===min);
        window.__rot = (window.__rot ?? -1) + 1;
        tied[window.__rot % tied.length].click();
        return 'place';
      }
      btns[0].click();
      return 'decision';
    }
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

/** 建房 → 单人开局 → 装好推进器 → 解掉开局挂起决策 */
async function enterGame() {
  for (let i = 0; i < 50; i++) {
    if (await evalJs(`document.readyState === 'complete' && !!document.getElementById('create')`)) break;
    await sleep(200);
  }
  await evalJs(`(document.getElementById('name').value='自验', document.getElementById('create').click(), true)`);
  const lobbyOk = await evalJs(`new Promise(r=>{const t=setInterval(()=>{if(document.getElementById('startRow').style.display!=='none'){clearInterval(t);r(true)}},100);setTimeout(()=>{clearInterval(t);r(false)},8000)})`);
  if (!lobbyOk) return false;
  await evalJs(`(document.getElementById('start').click(), true)`);
  const handReady = await evalJs(`new Promise(r=>{const t=setInterval(()=>{if(document.querySelectorAll('#hand .handcard').length>0){clearInterval(t);r(true)}},150);setTimeout(()=>{clearInterval(t);r(false)},10000)})`);
  if (!handReady) return false;
  await evalJs(INSTALL_STEP);
  for (let i = 0; i < 20; i++) {
    const st = await evalJs(`window.__step()`);
    if (st === 'turn' || st === 'wait') break;
    await sleep(200);
  }
  return true;
}

try {
  let bossText = '';
  for (let attempt = 1; attempt <= 3 && !bossText; attempt++) {
    console.log(`[verify-ui] 第 ${attempt} 局：建房 → 单人开局 …`);
    if (attempt > 1) {
      await cdp('Page.reload', {}, sessionId);
      await sleep(800);
    }
    if (!(await enterGame())) {
      console.log('[verify-ui] 开局失败，重试');
      continue;
    }

    if (attempt === 1) {
      // ── 校验①：手牌每张卡头行徽标 + 效果全文常显 ──────────────────────────
      const hand = await evalJs(`[...document.querySelectorAll('#hand .handcard')].map(el=>({hd:el.querySelector('.hd')?.textContent??'',fx:el.querySelector('.fx')?.textContent??''}))`);
      check('手牌卡块数量 = 8（小鱼4+莉雅4，单人双控）', hand.length === 8, `实际 ${hand.length}`);
      check('每张手牌含类型徽标与 AP 徽标', hand.every((c) => c.hd.includes('AP')));
      check('每张手牌效果全文常显（.fx 非空）', hand.every((c) => c.fx.length >= 8), hand[0] ? `示例：${hand[0].fx.slice(0, 30)}…` : '无手牌');
      await shot('verify-ui-hand.png');

      // ── 校验②：场上危机卡浮层 ＋ 锻造展示区浮层 ────────────────────────────
      await evalJs(`new Promise(r=>{const t=setInterval(()=>{if(document.querySelectorAll('#scenes .crisis').length>0){clearInterval(t);r(true)}},150);setTimeout(()=>{clearInterval(t);r(false)},6000)})`);
      const ui = await evalJs(`({
        crisis: [...document.querySelectorAll('#scenes .crisis')].map(el=>({label:(el.childNodes[0]?.textContent??el.textContent).trim(),tip:el.querySelector('.tip')?.textContent??''})),
        equip: [...document.querySelectorAll('#equipDisplay .chip')].map(el=>({label:(el.childNodes[0]?.textContent??'').trim(),tip:el.querySelector('.tip')?.textContent??''})),
      })`);
      check('场上危机卡均带悬停浮层（危机度 当前/上限 + 效果原文）', ui.crisis.length > 0 && ui.crisis.every((c) => /危机度 \d+\/\d+（当前\/上限）/.test(c.tip)), `危机 ${ui.crisis.length} 张`);
      check('锻造展示区 10 件装备均带被动/主动原文浮层', ui.equip.length === 10 && ui.equip.every((e2) => e2.tip.includes('被动') && e2.tip.includes('主动')), `装备 ${ui.equip.length} 件`);
    }

    // ── 自动打完一局 ────────────────────────────────────────────────────────
    console.log('[verify-ui] 自动对局至最终决战 …');
    for (let i = 0; i < 600 && !bossText; i++) {
      const st = await evalJs(`window.__step()`);
      if (st === 'boss') bossText = await evalJs(`document.querySelector('#bossPanel .boss').textContent`);
      else if (st === 'over') {
        const tail = await evalJs(`document.getElementById('log').textContent.trim().split('\\n').slice(-2).join(' / ')`);
        console.log(`[verify-ui] 对局提前终局：${tail}`);
        break;
      } else if (st === 'stall' || st === 'wait' || st === 'dec-wait') await sleep(250);
    }
  }

  // ── 校验③：玫拉面板阶段规则提示 ──────────────────────────────────────────
  check('进入最终决战，玫拉面板渲染', bossText.length > 0);
  if (bossText) {
    check('P1 阶段规则提示（护盾/暗影箭）', bossText.includes('P1·黑暗护盾') && bossText.includes('暗影箭'));
    check('黑暗宝玉规则提示（侵蚀+共鸣减免）', bossText.includes('黑暗宝玉') && bossText.includes('共鸣净化'));
    await shot('verify-ui-boss.png');
  }
  const logTail = await evalJs(`document.getElementById('log').textContent.slice(-500)`);
  console.log('[verify-ui] 日志尾部：\n' + logTail.split('\n').slice(-5).join('\n'));
} finally {
  try {
    await cdp('Browser.close');
  } catch {
    /* 忽略 */
  }
  edge.kill();
}

if (failures > 0) {
  console.error(`[verify-ui] FAILED（${failures} 项）`);
  process.exit(1);
}
console.log('[verify-ui] PASS：手牌/危机/装备/首领面板 文案可见性全链路通过');

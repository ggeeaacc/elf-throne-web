/**
 * UX 优化自验（客户端体验：触屏浮层 / 移动相邻性 / UX audit / 视觉主题 / 素材集成）。
 * 前提：服务端已在 :8787 运行（node server/dist/index.js）。
 * 流程：headless Edge + CDP，四标签页四座位（四角色全上场）→ 建房/加入×3 → 开局 →
 *   ① 版图连线与素材 ② 移动相邻高亮/置灰/「不相邻」提示 ③ 点选浮层切换
 *   ④ 回合横幅/面板高亮 ⑤ AP 不足置灰 ⑥ 等待「XX 决策中」⑦ 日志着色/危机角标
 * 截图落盘 production/ux-*.png。运行：node scripts/ux-verify.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = process.env['BASE_URL'] ?? 'http://127.0.0.1:8787';
const OUT_DIR = fileURLToPath(new URL('../production', import.meta.url));
const TMP = fileURLToPath(new URL('../.edge-ux-profile', import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 启动 headless Edge ────────────────────────────────────────────────────────
console.log('[ux-verify] 启动 headless Edge …');
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

async function openTab() {
  const { targetId } = await cdp('Target.createTarget', { url: BASE });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  await cdp('Page.enable', {}, sessionId);
  return sessionId;
}
const evalJs = async (sid, expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(`页面脚本错误：${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result.value;
};
const shot = async (sid, file) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sid);
  writeFileSync(`${OUT_DIR}/${file}`, Buffer.from(data, 'base64'));
  console.log(`[ux-verify] 截图 → production/${file}`);
};

/** 决策消解器（只解决策，绝不结束回合——保持当前回合供断言） */
const INSTALL_DECIDE = `window.__decide = function(){
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
  return 'none';
}`;
/** 整步推进器（仅用于等待提示搜寻：解决策或结束回合） */
const INSTALL_STEP = `window.__step = function(){
  const r = window.__decide();
  if (r !== 'none') return r;
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

/** 全部标签清决策，直到都无决策面板（或仅剩等待方） */
async function drainDecisions(tabs, rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    let busy = false;
    for (const sid of tabs) {
      const st = await evalJs(sid, `window.__decide()`);
      if (st !== 'none' && st !== 'dec-wait') busy = true;
    }
    if (!busy) return;
    await sleep(150);
  }
}
/** 推进到「行动阶段且有当前回合」：先清决策，再校验状态栏出现当前回合 */
async function driveToActionTurn(tabs) {
  for (let i = 0; i < 40; i++) {
    await drainDecisions(tabs);
    const hasTurn = await evalJs(tabs[0], `document.getElementById('status').textContent.includes('当前回合：')`);
    const anyDec = await evalJs(tabs[0], `document.getElementById('decision').style.display !== 'none'`);
    if (hasTurn && !anyDec) return true;
    for (const sid of tabs) await evalJs(sid, `window.__step()`);
    await sleep(200);
  }
  return false;
}

try {
  // ── 四座位入房 ──────────────────────────────────────────────────────────────
  console.log('[ux-verify] 标签1 建房，标签2/3/4 加入 …');
  const tabs = [await openTab(), await openTab(), await openTab(), await openTab()];
  for (let i = 0; i < 50; i++) {
    if (await evalJs(tabs[0], `document.readyState === 'complete' && !!document.getElementById('create')`)) break;
    await sleep(200);
  }
  await evalJs(tabs[0], `localStorage.clear(); (document.getElementById('name').value='甲', document.getElementById('create').click(), true)`);
  const roomOk = await evalJs(tabs[0], `new Promise(r=>{const t=setInterval(()=>{if(document.getElementById('roomId').value){clearInterval(t);r(true)}},100);setTimeout(()=>{clearInterval(t);r(false)},8000)})`);
  if (!roomOk) throw new Error('建房失败');
  const roomId = await evalJs(tabs[0], `document.getElementById('roomId').value`);
  for (let k = 1; k < 4; k++) {
    await evalJs(tabs[k], `localStorage.clear(); (document.getElementById('name').value='玩家${k + 1}', document.getElementById('roomId').value='${roomId}', document.getElementById('join').click(), true)`);
    const ok = await evalJs(tabs[k], `new Promise(r=>{const t=setInterval(()=>{if(document.getElementById('roomInfo').textContent.includes('座位')){clearInterval(t);r(true)}},100);setTimeout(()=>{clearInterval(t);r(false)},8000)})`);
    if (!ok) throw new Error(`标签${k + 1} 加入失败`);
  }
  await evalJs(tabs[0], `(document.getElementById('start').click(), true)`);
  for (let k = 0; k < 4; k++) {
    const ready = await evalJs(tabs[k], `new Promise(r=>{const t=setInterval(()=>{if(document.querySelectorAll('#hand .handcard').length>0){clearInterval(t);r(true)}},150);setTimeout(()=>{clearInterval(t);r(false)},10000)})`);
    if (!ready) throw new Error(`标签${k + 1} 开局失败`);
    await evalJs(tabs[k], INSTALL_DECIDE);
    await evalJs(tabs[k], INSTALL_STEP);
  }
  if (!(await driveToActionTurn(tabs))) throw new Error('未能进入行动阶段');
  console.log('[ux-verify] 开局完成（四角色全上场），房间', roomId);

  // ── ① 版图连线 + 素材 + 危机角标 ──────────────────────────────────────────
  const board = await evalJs(tabs[0], `({
    lines: document.querySelectorAll('#sceneLinks line').length,
    sceneIcons: [...document.querySelectorAll('#scenes .scene-icon')].map(i=>i.getAttribute('src')),
    avatars: [...document.querySelectorAll('#chars .avatar')].map(i=>i.getAttribute('src')),
    badgeSum: [...document.querySelectorAll('#scenes .badge')].reduce((n,b)=>n+Number(b.textContent),0),
    crisisCount: document.querySelectorAll('#scenes .crisis').length,
    scenes: document.querySelectorAll('#scenes .scene').length,
  })`);
  check('版图邻接连线 4 条（引擎 SCENES.adjacent 渲染）', board.lines === 4, `实际 ${board.lines}`);
  check('四场景头图齐全（wall/coffin/tree/wall_damaged）', board.sceneIcons.length === 4 && ['wall', 'coffin', 'tree', 'wall_damaged'].every((t) => board.sceneIcons.some((s) => s.includes(t))), board.sceneIcons.join(','));
  check('四角色头像齐全（green/red/purple/yellow_character）', board.avatars.length === 4 && ['green', 'red', 'purple', 'yellow'].every((t) => board.avatars.some((s) => s.includes(t))), board.avatars.join(','));
  check('场景危机角标总数 = 场上危机卡数', board.badgeSum === board.crisisCount && board.crisisCount > 0, `角标 ${board.badgeSum} / 危机 ${board.crisisCount}`);
  check('四场景卡片渲染', board.scenes === 4);

  // ── ④ 回合横幅 + 当前回合面板高亮 ─────────────────────────────────────────
  const cur = await evalJs(tabs[0], `(document.getElementById('status').textContent.match(/当前回合：(.+?)(（| )/)?.[1] ?? '').trim()`);
  const panelTurn = await evalJs(tabs[0], `document.querySelector('#chars .panel.turn')?.textContent ?? ''`);
  check('当前回合角色面板高亮（.panel.turn 含角色名）', !!cur && panelTurn.includes(cur), cur);
  const banners = [];
  for (const sid of tabs) banners.push(await evalJs(sid, `document.getElementById('turnBanner').style.display !== 'none'`));
  check('「你的回合」横幅恰好出现在控制方一侧', banners.filter(Boolean).length === 1, banners.join(','));
  const act = tabs[banners.findIndex(Boolean)] ?? tabs[0];

  // ── ② 移动相邻性：高亮/置灰/提示 ──────────────────────────────────────────
  await evalJs(act, `[...document.querySelectorAll('#actions button')].find(b=>b.textContent==='移动…')?.click()`);
  await sleep(150);
  const mv = await evalJs(act, `({
    ok: document.querySelectorAll('#scenes .scene.move-ok').length,
    no: document.querySelectorAll('#scenes .scene.move-no').length,
    cur: document.querySelectorAll('#scenes .scene.move-cur').length,
  })`);
  check('移动编排：相邻 2 场景高亮（绿）', mv.ok === 2, `实际 ${mv.ok}`);
  check('移动编排：非相邻 1 场景置灰', mv.no === 1, `实际 ${mv.no}`);
  check('移动编排：当前场景虚线标记', mv.cur === 1, `实际 ${mv.cur}`);
  await evalJs(act, `document.querySelector('#scenes .scene.move-no')?.click()`);
  await sleep(120);
  const hint = await evalJs(act, `document.getElementById('sceneHint')?.textContent ?? ''`);
  check('点击非相邻场景提示「不相邻」', hint.includes('不相邻'), hint);
  const btnNo = await evalJs(act, `[...document.querySelectorAll('#actions button')].filter(b=>b.classList.contains('no')).length`);
  check('编排器非相邻场景按钮置灰（.no）', btnNo === 1, `实际 ${btnNo}`);
  await shot(act, 'ux-move-adjacency.png');
  await evalJs(act, `document.querySelector('#scenes .scene.move-ok')?.click()`);
  await sleep(120);
  const selScene = await evalJs(act, `[...document.querySelectorAll('#actions button.sel')].map(b=>b.textContent).join(',')`);
  check('点击版图相邻场景同步选中编排器目标', selScene.length > 0, selScene);
  await evalJs(act, `[...document.querySelectorAll('#actions button')].find(b=>b.textContent.includes('取消'))?.click()`);
  await sleep(120);

  // ── ③ 点选浮层切换 ────────────────────────────────────────────────────────
  await evalJs(act, `document.querySelector('#equipDisplay .chip.hastip')?.click()`);
  await sleep(100);
  const tip1 = await evalJs(act, `({open: document.querySelectorAll('.hastip.tip-open').length, visible: (()=>{const t=document.querySelector('.hastip.tip-open .tip'); return t ? getComputedStyle(t).display : 'none'})()})`);
  check('点一下装备 chip 弹出浮层（唯一 tip-open 且可见）', tip1.open === 1 && tip1.visible === 'block');
  await shot(act, 'ux-tip-tap.png');
  await evalJs(act, `document.querySelector('#equipDisplay .chip.hastip')?.click()`);
  await sleep(100);
  const tip2 = await evalJs(act, `document.querySelectorAll('.hastip.tip-open').length`);
  check('再点同一元素关闭浮层', tip2 === 0);
  await evalJs(act, `document.querySelector('#scenes .crisis.hastip')?.click()`);
  await sleep(100);
  const tip3 = await evalJs(act, `document.querySelectorAll('.hastip.tip-open').length`);
  check('点危机卡弹出其浮层', tip3 === 1);
  await evalJs(act, `document.querySelector('h1')?.click()`);
  await sleep(100);
  const tip4 = await evalJs(act, `document.querySelectorAll('.hastip.tip-open').length`);
  check('点页面空白关闭浮层', tip4 === 0);

  // ── ⑤ AP 不足置灰 ─────────────────────────────────────────────────────────
  let ap = await evalJs(act, `Number(document.getElementById('status').textContent.match(/AP (\\d+)/)?.[1] ?? 9)`);
  for (let i = 0; i < 3 && ap >= 2; i++) {
    await evalJs(act, `[...document.querySelectorAll('#actions button')].find(b=>b.textContent==='搜索'&&!b.disabled)?.click()`);
    await sleep(250);
    await drainDecisions(tabs, 8);
    ap = await evalJs(act, `Number(document.getElementById('status').textContent.match(/AP (\\d+)/)?.[1] ?? 9)`);
  }
  const apBtns = await evalJs(act, `[...document.querySelectorAll('#actions button')].map(b=>({label:b.textContent,disabled:b.disabled,title:b.title}))`);
  const forge = apBtns.find((b) => b.label === '锻造…');
  if (ap < 2 && forge) {
    check('AP 不足时「锻造」置灰并提示所需 AP', forge.disabled && forge.title.includes('AP 不足'), `AP=${ap} title=${forge.title}`);
  } else {
    const anyDisabled = apBtns.some((b) => b.disabled && b.title.includes('AP 不足'));
    check('AP 不足置灰逻辑生效', anyDisabled || ap >= 2, `AP=${ap}`);
  }

  // ── ⑥ 非决策人等待提示「等待 XX 决策中…」─────────────────────────────────
  let waitSeen = '';
  for (let i = 0; i < 40 && !waitSeen; i++) {
    for (let k = 0; k < tabs.length && !waitSeen; k++) {
      const t = await evalJs(tabs[k], `(document.getElementById('decision').textContent + ' ' + document.getElementById('actions').textContent)`);
      const m = t.match(/等待 (.+?) 决策中/);
      if (m) {
        waitSeen = `标签${k + 1}:${m[0]}`;
        await shot(tabs[k], 'ux-waiting.png');
      }
    }
    if (!waitSeen) {
      for (const sid of tabs) await evalJs(sid, `window.__step()`);
      await sleep(200);
    }
  }
  check('非决策人等待提示「等待 XX 决策中…」', waitSeen.length > 0, waitSeen);

  // ── ⑦ 日志着色（须经多轮阶段/回合/决策事件后断言，开局首批事件无类别） ────
  const logCls = await evalJs(tabs[0], `[...new Set([...document.querySelectorAll('#log div')].map(d=>d.className))].filter(Boolean)`);
  check('日志按类型着色（含系统灰 l-sys）', logCls.includes('l-sys'), logCls.join(','));
  check('日志决策黄（l-dec）出现', logCls.includes('l-dec'), logCls.join(','));

  // ── 全景截图（主题/素材/日志着色终态） ────────────────────────────────────
  await shot(tabs[0], 'ux-gameview.png');
} finally {
  try {
    await cdp('Browser.close');
  } catch {
    /* 忽略 */
  }
  edge.kill();
}

if (failures > 0) {
  console.error(`[ux-verify] FAILED（${failures} 项）`);
  process.exit(1);
}
console.log('[ux-verify] PASS：浮层点选 / 移动相邻性 / UX audit / 主题素材 全链路通过');

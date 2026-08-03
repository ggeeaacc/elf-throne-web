/**
 * 极简测试客户端 v2：全指令面 + 中断式决策 UI（control-manifest §10/11：无规则逻辑，意图即指令）。
 * 卡牌定义（公开信息）直接复用引擎 content 表。
 */
import {
  ACTION_CARD_BY_ID,
  CRISIS_CARD_BY_ID,
  BOND_CARD_BY_ID,
  LETTER_CARD_BY_ID,
  EQUIPMENT_CARD_BY_ID,
  SCENES,
  CHARACTERS,
} from '@elf-throne/engine';

// ── 视图镜像类型（与 server/protocol 同构，手写保持 client 零构建依赖顺序） ──

type Command = Record<string, unknown> & { type: string };

interface RoomSnapshot {
  id: string;
  status: 'lobby' | 'playing' | 'finished';
  players: Array<{ playerId: string; seat: number; name: string; connected: boolean; host: boolean; ai?: boolean; character: string | null }>;
  characterSelections: Record<number, string>;
}

type ServerMessage =
  | { op: 'hello'; playerId: string; token: string; seat: number; roomId: string }
  | { op: 'room'; room: RoomSnapshot }
  | { op: 'view'; seq: number; view: GameView; events: Array<{ kind: string }> }
  | { op: 'log'; text: string }
  | { op: 'error'; code: string; message: string }
  | { op: 'pong' };

interface GameView {
  seat: number;
  controlledCharacters: string[];
  phase: { kind: string; day: number; segment: string; round: number };
  turnOrder: string[];
  currentTurn: { character: string } | null;
  characters: Record<string, CharView>;
  scenes: Record<string, { id: string; crisisCards: string[]; crisisDamage: Record<string, number> }>;
  cards: Record<string, { uid: string; defId: string; kind: string }>;
  decks: { crisisCount: number; crisisDiscard: string[]; bondCount: number; letterCount: number };
  equipmentDisplay: string[];
  flags: Record<string, unknown>;
  boss: { hp: number; maxHp: number; shield: number; shieldMax: number; stage: number; round: number; gemPurify: number } | null;
  bonds: Array<{ pair: string[]; status: string; cardUid: string | null; activeUsedRound: number | null }>;
  buffs: Array<{ id: string; source: string; kind: string; value: number; target?: string; scene?: string; partner?: string }>;
  sceneWards: Record<string, number>;
  pendingDecision: { id: string; kind: string; decider: string; options: any } | null;
  result: { outcome: string; reason: string } | null;
}

interface CharView {
  id: string;
  scene: string;
  hp: number;
  maxHp: number;
  erosion: number;
  hand: string[];
  handCount: number;
  deckCount: number;
  discard: string[];
  equipment: string[];
  materialTokens: number;
  purifyTokens: number;
  bondTokens: number;
  charms: number;
  hasPet: boolean;
  pendingLetter: { cardUid: string | null; from: string } | null;
  ap: number;
  alive: boolean;
  airship?: { cooldownRounds: number };
}

// ── 全局态 ────────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
let ws: WebSocket | null = null;
let mySeat = -1;
let myPlayerId = '';
let lastSeq = 0;
let view: GameView | null = null;

/** 行动编排：选中卡牌/行动后的目标收集 */
interface PendingAction {
  kind: 'play_card' | 'forge' | 'send_letter' | 'scene_action' | 'bond_active' | 'equipment_active' | 'heal' | 'guard' | 'transfer_material' | null;
  cardUid?: string;
  bondUid?: string;
  equipmentUid?: string;
  action?: string;
  crisisUids: string[];
  characters: string[];
  scene?: string;
  cardUids: string[];
  usePurify: number;
  useCharm: boolean;
  usePetAttack: boolean;
  useTokens: number;
}
let pending: PendingAction = freshPending();

function freshPending(): PendingAction {
  return { kind: null, crisisUids: [], characters: [], cardUids: [], usePurify: 0, useCharm: false, usePetAttack: false, useTokens: 0 };
}

// ── 网络 ──────────────────────────────────────────────────────────────────────

function connect(): WebSocket {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => handle(JSON.parse(String(ev.data)) as ServerMessage);
  ws.onclose = () => log('— 连接断开（可用「重连」恢复座位）—', 'l-sys');
  return ws;
}

function send(msg: unknown): void {
  const sock = connect();
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
  else sock.addEventListener('open', () => sock.send(JSON.stringify(msg)), { once: true });
}

function cmd(c: Command): void {
  send({ op: 'cmd', cmd: c });
}

function handle(msg: ServerMessage): void {
  switch (msg.op) {
    case 'hello':
      mySeat = msg.seat;
      myPlayerId = msg.playerId;
      localStorage.setItem('elf-room', msg.roomId);
      localStorage.setItem('elf-token', msg.token);
      $('roomInfo').textContent = `房间 ${msg.roomId} · 座位 ${msg.seat}`;
      ($('roomId') as HTMLInputElement).value = msg.roomId;
      break;
    case 'room': {
      const r = msg.room;
      // 从玩家列表更新我的座位（随机座位后可能已变化）
      const me = r.players.find((p) => p.playerId === myPlayerId);
      if (me && me.seat !== mySeat) {
        mySeat = me.seat;
        $('roomInfo').textContent = `房间 ${r.id} · 座位 ${mySeat}`;
      }
      const iHost = r.players.some((p) => p.host && p.playerId === myPlayerId);
      const lobby = r.status === 'lobby';
      const allChars = ['xiaoyu', 'liya', 'kaier', 'baye'] as const;
      const charNames: Record<string, string> = { xiaoyu: '小鱼', liya: '莉雅', kaier: '凯尔', baye: '巴爷' };
      const selections = r.characterSelections ?? {};
      const taken = new Set(Object.values(selections));

      $('players').innerHTML = r.players
        .map(
          (p) => {
            const my = p.seat === mySeat;
            const sel = selections[p.seat] ?? null;
            const selName = sel ? charNames[sel] || sel : '未选';
            const picker = my && lobby && !p.ai
              ? '<br/><span class="dim">角色：</span>' + allChars.map(c =>
                  `<button class="pickChar${sel === c ? ' sel' : ''}${taken.has(c) && sel !== c ? ' taken' : ''}" data-char="${c}" ${taken.has(c) && sel !== c ? 'disabled' : ''}>${charNames[c]}</button>`
                ).join('')
              : '';
            return `<div>${p.host ? '👑 ' : ''}座${p.seat} ${esc(p.name)}${p.ai ? ' 🤖AI' : ''}${!p.connected && !p.ai ? '（离线）' : ''} <span class="dim">| ${selName}</span>${
              iHost && lobby && p.ai ? ` <button class="rmAi" data-seat="${p.seat}">移出</button>` : ''
            }${picker}</div>`;
          },
        )
        .join('');
      $('players').querySelectorAll('.rmAi').forEach((el) => {
        el.addEventListener('click', () => send({ op: 'remove_ai', seat: Number((el as HTMLElement).dataset.seat) }));
      });
      $('players').querySelectorAll('.pickChar').forEach((el) => {
        el.addEventListener('click', () => send({ op: 'lock_character', character: (el as HTMLElement).dataset.char as string }));
      });
      const canStart = lobby && iHost;
      $('startRow').style.display = canStart ? '' : 'none';
      $('addAi').style.display = canStart && r.players.length < 4 ? '' : 'none';
      $('shuffleSeats').style.display = canStart && r.players.length > 1 ? '' : 'none';
      // 弃角选择器仅在 3 人局时显示
      const benchEl = $('bench') as HTMLElement | null;
      if (benchEl) benchEl.style.display = r.players.length === 3 ? '' : 'none';
      break;
    }
    case 'view':
      if (msg.seq <= lastSeq) return;
      lastSeq = msg.seq;
      view = msg.view;
      $('game').style.display = '';
      for (const ev of msg.events) log(fmtEvent(ev), evClass(ev.kind));
      render();
      break;
    case 'error':
      log(`✗ ${msg.code}: ${msg.message}`, 'l-err');
      break;
    case 'log':
      log(msg.text, 'l-ai');
      break;
  }
}

// ── 名称解析 ───────────────────────────────────────────────────────────────────

const SCENE_NAMES: Record<string, string> = { human_city: '人类王城', elf_kingdom: '精灵王国', ancient_battlefield: '古战场废墟', dark_valley: '黑暗山谷' };
/** 版图 2x2 网格渲染顺序：沿邻接环（王城—山谷—精灵—废墟—王城）摆放，连线不交叉 */
const BOARD_ORDER = ['human_city', 'dark_valley', 'elf_kingdom', 'ancient_battlefield'];
/** Kenney CC0 素材映射（client/public/assets/ASSETS.md） */
const SCENE_IMG: Record<string, string> = { human_city: 'scene_city', elf_kingdom: 'scene_forest', ancient_battlefield: 'scene_ruins', dark_valley: 'scene_valley' };
const CHAR_IMG: Record<string, string> = { xiaoyu: 'xiaoyu', liya: 'liya', kaier: 'kaier', baye: 'baye' };
/** 引擎场景邻接表（拓扑唯一来源，版图连线/移动高亮共用，客户端不另存第二份） */
const SCENE_ADJ: Record<string, readonly string[]> = Object.fromEntries(Object.entries(SCENES).map(([k, d]) => [k, d.adjacent]));
/** 移动编排中的版图上点击提示（跨 render 保留，退出编排即清空） */
let sceneHint = '';
const SEG_NAMES: Record<string, string> = { dawn: '清晨', dusk: '黄昏', night: '深夜' };
const PHASE_NAMES: Record<string, string> = { crisis: '危机蔓延', action: '破晓行动', prejudice: '偏见与羁绊', recovery: '休整与倒数', final_battle: '最终决战', game_over: '终局' };

/** 行动卡类型缩写徽标（规则书 附录A 类型栏） */
const TAG_NAMES: Record<string, string> = { attack: '攻', move: '移', defense: '防', heal: '愈', resource: '资', support: '辅', special: '特' };

/** HTML 转义：卡面文案注入 innerHTML 前一律过此 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 按 defId 跨五类卡表查定义（卡面原文见规则书附录 A–E） */
function defOf(defId: string) {
  return (
    ACTION_CARD_BY_ID.get(defId) ??
    CRISIS_CARD_BY_ID.get(defId) ??
    BOND_CARD_BY_ID.get(defId) ??
    LETTER_CARD_BY_ID.get(defId) ??
    EQUIPMENT_CARD_BY_ID.get(defId)
  );
}

/** 隐藏信息安全：仅解析投影中本座可见的 uid（view.cards 已经 projectView 过滤） */
function cardDef(uid: string): { name: string; code: string; text?: string } {
  const inst = view?.cards[uid];
  if (!inst) return { name: uid, code: '' };
  const d = defOf(inst.defId);
  return d ? { name: d.name, code: d.code, text: d.text } : { name: inst.defId, code: '' };
}

/** 悬停浮层（宿主元素需挂 hastip 类） */
function tipHtml(inner: string): string {
  return `<span class="tip">${inner}</span>`;
}

/** 通用卡面浮层：卡名 + 编号 + 效果原文 */
function cardTip(uid: string): string {
  const inst = view?.cards[uid];
  const d = inst ? defOf(inst.defId) : undefined;
  if (!d) return '';
  return tipHtml(`<b>${esc(d.name)}</b> <span class="dim">${esc(d.code)}</span><br/>${esc(d.text)}`);
}

function charName(cid: string): string {
  return CHARACTERS[cid as keyof typeof CHARACTERS]?.name ?? cid;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────

function render(): void {
  if (!view) return;
  renderStatus();
  renderDecision();
  renderScenes();
  renderBoss();
  renderEquipDisplay();
  renderChars();
  renderActions();
  renderHand();
}

function renderStatus(): void {
  const v = view!;
  const phaseTxt = v.phase.kind === 'final_battle' ? `最终决战 第${v.boss?.round ?? 1}轮` : `第${v.phase.day}天·${SEG_NAMES[v.phase.segment]}（第${v.phase.round}轮）·${PHASE_NAMES[v.phase.kind]}`;
  const turn = v.currentTurn ? `当前回合：<b>${charName(v.currentTurn.character)}</b>${v.controlledCharacters.includes(v.currentTurn.character) ? '（你）' : ''} <span class="ap">AP ${v.characters[v.currentTurn.character]?.ap ?? 0}</span>` : '—';
  $('status').innerHTML = `${phaseTxt} ｜ ${turn} ｜ <span class="dim">危机牌库 ${v.decks.crisisCount} ｜ 弃牌 ${v.decks.crisisDiscard.length}</span>${
    v.result ? ` ｜ <b>${v.result.outcome === 'victory' ? '✨胜利' : '💀失败'}：${v.result.reason}</b>` : ''
  }`;
  // 「你的回合」横幅：仅当前回合角色归本座控制且对局未结束时显示
  const banner = $('turnBanner');
  if (v.currentTurn && v.controlledCharacters.includes(v.currentTurn.character) && !v.result) {
    banner.textContent = `✦ 你的回合 · ${charName(v.currentTurn.character)}（AP ${v.characters[v.currentTurn.character]?.ap ?? 0}）`;
    banner.style.display = '';
  } else {
    banner.style.display = 'none';
  }
}

function crisisChip(uid: string, selectable: boolean): string {
  const inst = view!.cards[uid];
  const def = inst ? CRISIS_CARD_BY_ID.get(inst.defId) : undefined;
  if (!def) return '';
  const scene = Object.values(view!.scenes).find((s) => s.crisisCards.includes(uid));
  const remaining = def.crisisValue - (scene?.crisisDamage[uid] ?? 0);
  const sel = pending.crisisUids.includes(uid) ? ' sel' : '';
  // 效果摘要（一行，去除句号后的废话）
  const shortText = def.text.replace(/清除此卡.*$/, '').replace(/无。/, '无效果').replace(/\n/g, ' ').trim().slice(0, 60) + (def.text.length > 60 ? '…' : '');
  const tip = tipHtml(
    `<b>${esc(def.name)}</b> <span class="dim">${esc(def.code)}</span><br/>危机度 ${remaining}/${def.crisisValue}（当前/上限）${def.dark ? ' ｜ 【暗】' : ''}<br/>${esc(def.text)}`,
  );
  return `<span class="crisis hastip${def.dark ? ' dark' : ''}${sel}" data-uid="${selectable ? uid : ''}">${def.name} <span class="dim">${remaining}/${def.crisisValue}</span>${def.dark ? '【暗】' : ''}<br/><span class="crisis-fx">${esc(shortText)}</span>${tip}</span>`;
}

function renderScenes(): void {
  const v = view!;
  const selectable = (pending.kind === 'play_card' && !(pending.cardUid && needsChar(pending.cardUid))) || pending.kind === 'bond_active';
  // 移动编排：相邻高亮（绿）/ 非相邻置灰 / 当前场景虚线标记；邻接表来自引擎 SCENES.adjacent
  const moving = pending.kind === 'scene_action';
  const curCid = v.currentTurn?.character;
  const curScene = moving && curCid ? v.characters[curCid]?.scene : undefined;
  const adj = curScene ? new Set(SCENE_ADJ[curScene] ?? []) : null;
  if (!moving) sceneHint = '';
  const order = [...BOARD_ORDER, ...Object.keys(v.scenes).filter((s) => !BOARD_ORDER.includes(s))];
  $('scenes').innerHTML =
    `<h2>版图<span id="sceneHint" class="hint">${esc(sceneHint)}</span></h2><div class="board" id="sceneBoard"><svg class="links" id="sceneLinks"></svg>` +
    order
      .map((sid) => v.scenes[sid])
      .filter((s): s is GameView['scenes'][string] => !!s)
      .map((s) => {
        const here = Object.values(v.characters).filter((c) => c.alive && c.scene === s.id).map((c) => charName(c.id)).join('、');
        const ward = (v.sceneWards[s.id] ?? 0) > 0 ? '<span class="chip">🛡守护</span>' : '';
        const badge = s.crisisCards.length > 0 ? `<span class="badge">${s.crisisCards.length}</span>` : '';
        const mv = !adj ? '' : s.id === curScene ? ' move-cur' : adj.has(s.id) ? ' move-ok' : ' move-no';
        const icon = SCENE_IMG[s.id] ? `<img class="scene-icon" src="/assets/tokens/${SCENE_IMG[s.id]}.png" alt=""/>` : '';
        return `<div class="scene scene-${s.id}${mv}" data-sid="${s.id}"><b>${icon}${SCENE_NAMES[s.id]}</b>${badge} ${ward}<span class="here">${here ? `⚑ ${here}` : ''}</span><br/>${s.crisisCards.map((u) => crisisChip(u, selectable)).join('') || '<span class="dim">无危机</span>'}</div>`;
      })
      .join('') +
    `</div>`;
  $('scenes').querySelectorAll('.crisis[data-uid]').forEach((el) => {
    el.addEventListener('click', () => toggleCrisis((el as HTMLElement).dataset.uid!));
  });
  // 移动编排中：版图点选目标场景——相邻即选中，非相邻提示「不相邻」，当前场景提示已在此
  if (adj) {
    $('scenes').querySelectorAll('.scene[data-sid]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('.crisis')) return; // 点危机卡不触发选场景
        const sid = (el as HTMLElement).dataset.sid!;
        if (sid === curScene) sceneHint = `已在「${SCENE_NAMES[sid]}」`;
        else if (adj.has(sid)) {
          pending.scene = sid;
          sceneHint = '';
        } else sceneHint = `「${SCENE_NAMES[sid]}」与当前位置不相邻`;
        render();
      });
    });
  }
  drawSceneLinks();
}

/** 版图邻接连线：按场景卡片中心连线（数据来自引擎 SCENES.adjacent，去重双向边） */
function drawSceneLinks(): void {
  const board = $('sceneBoard');
  const svg = document.getElementById('sceneLinks');
  if (!board || !svg) return;
  const w = board.clientWidth;
  const h = board.clientHeight;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const centers = new Map<string, { x: number; y: number }>();
  board.querySelectorAll<HTMLElement>('.scene[data-sid]').forEach((el) => {
    centers.set(el.dataset.sid!, { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 });
  });
  const seen = new Set<string>();
  let lines = '';
  for (const [a, adjList] of Object.entries(SCENE_ADJ)) {
    for (const b of adjList) {
      const k = [a, b].sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      const p = centers.get(a);
      const q = centers.get(b);
      if (p && q) lines += `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`;
    }
  }
  svg.innerHTML = lines;
}
window.addEventListener('resize', () => {
  if (view) drawSceneLinks();
});

function toggleCrisis(uid: string): void {
  if (!uid) return;
  const i = pending.crisisUids.indexOf(uid);
  if (i >= 0) pending.crisisUids.splice(i, 1);
  else {
    pending.crisisUids.push(uid);
    if (pending.crisisUids.length > 2) pending.crisisUids.shift();
  }
  render();
}

/** 玫拉阶段规则提示（规则书 §七 首领阶段） */
const BOSS_STAGE_HINTS: Record<number, string> = {
  1: 'P1·黑暗护盾：须先击破全部护盾层，期间玫拉本体免伤；每轮结束时玫拉以暗影箭攻击生命值最低的角色，造成1点伤害。护盾全破后进入P2，所有存活角色恢复2点生命。',
  2: 'P2·魔化玫拉：玫拉每次受击后按攻击者种族反击——人类攻击者受1点黑暗伤害（小鱼仍需放置侵蚀指示物）；精灵攻击者受1点伤害并弃置一张手牌。每轮结束时玫拉对本轮造成伤害最高的角色造成2点伤害（并列则各1点）。生命≤上限一半（向下取整）进入P3，所有存活角色恢复1点生命。',
  3: 'P3·宝玉暴走：玫拉受到的所有伤害-1（最低为1）；每轮结束时玫拉对所有角色造成2点黑暗伤害，然后恢复1点生命。',
};

function renderBoss(): void {
  const b = view!.boss;
  $('bossPanel').innerHTML = b
    ? `<div class="panel boss"><h2><img class="boss-img" src="/assets/tokens/meila.png" alt=""/>玫拉（阶段 ${b.stage}）</h2>生命 <span class="hpbar">${b.hp}/${b.maxHp}</span> ｜ 护盾 ${b.shield}/${b.shieldMax} ｜ 决战轮 ${b.round}/9 ｜ 宝玉共鸣净化 ${b.gemPurify}/3` +
      `<br/><span class="dim">${BOSS_STAGE_HINTS[b.stage] ?? ''}</span>` +
      `<br/><span class="dim">黑暗宝玉：玫拉进入P3前，其黑暗伤害额外+1；每点共鸣净化使玫拉回合结束效果伤害-1（最低减至0，当前 ${b.gemPurify}/3）。</span></div>`
    : '';
}

/** 锻造展示区：常驻可见，悬停看装备被动/主动原文（附录B） */
function renderEquipDisplay(): void {
  const v = view!;
  $('equipDisplay').innerHTML =
    `<h2>锻造展示区</h2><div class="panel">` +
    (v.equipmentDisplay.map((u) => `<span class="chip hastip">${esc(cardDef(u).name)}${cardTip(u)}</span>`).join('') || '<span class="dim">空</span>') +
    `</div>`;
}

function renderChars(): void {
  const v = view!;
  $('chars').innerHTML = `<h2>角色</h2>` + v.turnOrder
    .map((cid) => {
      const c = v.characters[cid];
      if (!c) return '';
      const mine = v.controlledCharacters.includes(cid);
      const dead = c.alive ? '' : ' <span class="dim">（出局）</span>';
      const tokens = `<span class="tok">材${c.materialTokens} 净${c.purifyTokens} 羁${c.bondTokens}${c.charms ? ` 信${c.charms}` : ''}${c.erosion ? ` <span style="color:#a0a">蚀${c.erosion}</span>` : ''}${c.hasPet ? ' 🐾' : ''}${c.airship ? ` 飞艇${c.airship.cooldownRounds > 0 ? '冷却' : '可用'}` : ''}</span>`;
      const equip = c.equipment.map((u) => `<span class="chip hastip">${esc(cardDef(u).name)}${cardTip(u)}</span>`).join('');
      // 待收书信：投影仅对发送/接收方下发牌面（cardUid 非空才可解析，其余座位只见背面标记）
      const letter = c.pendingLetter
        ? c.pendingLetter.cardUid
          ? `<span class="chip hastip">✉${esc(cardDef(c.pendingLetter.cardUid).name)}${tipHtml(
              `<b>${esc(cardDef(c.pendingLetter.cardUid).name)}</b> <span class="dim">来自 ${charName(c.pendingLetter.from)}</span><br/>${esc(cardDef(c.pendingLetter.cardUid).text ?? '')}`,
            )}</span>`
          : '<span class="chip">✉待收</span>'
        : '';
      const avatar = CHAR_IMG[cid] ? `<img class="avatar" src="/assets/tokens/${CHAR_IMG[cid]}.png" alt=""/>` : '';
      const turnCls = v.currentTurn?.character === cid ? ' turn' : '';
      return `<div class="panel${turnCls}">${avatar}<b>${charName(cid)}</b>${mine ? '（你）' : ''}${dead}<br/><span class="hpbar">♥ ${c.hp}/${c.maxHp}</span> ｜ ${SCENE_NAMES[c.scene]} ｜ 手牌 ${mine ? c.hand.length : c.handCount} ｜ 牌库 ${c.deckCount}<br/>${tokens}<br/>${equip}${letter}</div>`;
    })
    .join('');
}

function renderHand(): void {
  const v = view!;
  const mine = v.controlledCharacters;
  const cur = v.currentTurn?.character;
  const parts: string[] = [];
  for (const cid of mine) {
    const c = v.characters[cid];
    if (!c) continue;
    parts.push(`<div class="dim">${charName(cid)} 的手牌：</div>`);
    for (const uid of c.hand) {
      const d = ACTION_CARD_BY_ID.get(v.cards[uid]?.defId ?? '');
      const sel = pending.cardUid === uid || pending.cardUids.includes(uid) ? ' sel' : '';
      if (!d) {
        // 理论上不会发生（本座手牌投影必含牌面）；兜底只露 uid，绝不编造文案
        parts.push(`<span class="handcard${sel}" data-uid="${uid}" data-owner="${cid}"><div class="hd">${esc(uid)}</div></span>`);
        continue;
      }
      const tags = d.tags.map((t) => `<span class="tag">${TAG_NAMES[t] ?? esc(t)}</span>`).join('');
      const ap = `<span class="tag ap">${d.costAP}AP</span>`;
      const remote = d.remote === true ? '<span class="tag remote">远程</span>' : d.remote === 'conditional' ? '<span class="tag remote">可远程</span>' : '';
      const mat = d.material ? '<span class="mat">【材】</span>' : '';
      const off = cur === cid ? '' : '<span class="dim">（非回合）</span>';
      parts.push(
        `<span class="handcard${sel}" data-uid="${uid}" data-owner="${cid}">` +
          `<div class="hd"><b>${esc(d.name)}</b> ${tags}${ap}${remote}${mat}${off}</div>` +
          `<div class="fx">${esc(d.text)}</div>` +
          `</span>`,
      );
    }
  }
  $('hand').innerHTML = parts.join('') || '<span class="dim">无</span>';
  $('hand').querySelectorAll('.handcard').forEach((el) => {
    el.addEventListener('click', () => clickHandCard(el as HTMLElement));
  });
}

function clickHandCard(el: HTMLElement): void {
  const uid = el.dataset.uid!;
  if (pending.kind === 'forge') {
    // 锻造材料卡多选
    const i = pending.cardUids.indexOf(uid);
    if (i >= 0) pending.cardUids.splice(i, 1);
    else pending.cardUids.push(uid);
    render();
    return;
  }
  if (pending.kind === 'heal') {
    pending.cardUids = [uid];
    render();
    return;
  }
  if (pending.kind === 'send_letter') {
    pending.cardUids = [uid];
    render();
    return;
  }
  // 默认：选择打出
  pending = { ...freshPending(), kind: 'play_card', cardUid: uid };
  render();
}

// ── 行动面板 ───────────────────────────────────────────────────────────────────

function renderActions(): void {
  const v = view!;
  const box = $('actions');
  box.innerHTML = '';
  const cur = v.currentTurn?.character;
  const mine = cur && v.controlledCharacters.includes(cur);
  const inBattle = v.phase.kind === 'final_battle';

  if (v.result) {
    box.innerHTML = `<b>${v.result.outcome === 'victory' ? '✨ 胜利！' : '💀 失败'}：${v.result.reason}</b>`;
    return;
  }
  if (!mine || !cur) {
    const d = v.pendingDecision;
    const dMine = d && (d.decider === 'all' || v.controlledCharacters.includes(d.decider));
    box.innerHTML = `<span class="dim">${d ? (dMine ? '请在上方完成决策…' : `等待 ${d.decider === 'all' ? '所有玩家' : charName(d.decider)} 决策中…`) : '等待其他玩家行动…'}</span>`;
    return;
  }
  const ch = v.characters[cur]!;

  // ── 编排中的行动：目标收集 + 提交 ──
  if (pending.kind) {
    renderPendingComposer(box, cur);
    return;
  }

  // costAP：AP 不足时按钮置灰并在悬停提示中注明所需 AP
  const mk = (label: string, fn: () => void, title = '', costAP = 0) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.onclick = fn;
    if (ch.ap < costAP) {
      b.disabled = true;
      b.title = `${title}（AP 不足：需 ${costAP}）`;
    }
    box.appendChild(b);
  };

  if (!inBattle) {
    mk('移动…', () => {
      pending = { ...freshPending(), kind: 'scene_action', action: '__move' };
      render();
    }, '1 AP 沿相邻路径移动（巴爷可选飞空艇）', 1);
  }
  mk('搜索', () => cmd({ type: 'search', character: cur }), '1 AP 抽 2 张', 1);
  if (!inBattle) {
    mk('锻造…', () => {
      pending = { ...freshPending(), kind: 'forge' };
      render();
    }, '2 AP + 2 材（王城/折扣递减）', 2);
    if (cur === 'xiaoyu' || cur === 'liya') {
      mk('传书…', () => {
        pending = { ...freshPending(), kind: 'send_letter' };
        render();
      }, '1 AP 给对方寄一封书信', 1);
    }
    // 场景行动
    if (ch.scene === 'elf_kingdom') mk('生命树治愈', () => cmd({ type: 'scene_action', character: cur, action: 'tree_heal' }), '1 AP：同场景 1 人回 1 + 1 净化', 1);
    if (ch.scene === 'ancient_battlefield') mk('侦查敌情', () => cmd({ type: 'scene_action', character: cur, action: 'scout' }), '1 AP：看牌库顶 2 张', 1);
    if (ch.scene === 'dark_valley') {
      mk('营救女王', () => cmd({ type: 'scene_action', character: cur, action: 'rescue_queen' }), '3 AP + 2 净化（一局限一次）', 3);
      mk('寻找宠物', () => cmd({ type: 'scene_action', character: cur, action: 'find_pet' }), '1 AP（一局限一次）', 1);
    }
  } else {
    mk('治疗…', () => {
      pending = { ...freshPending(), kind: 'heal' };
      render();
    }, '1 AP 弃 1 手牌：自己或同场景 1 人回 2', 1);
    mk('援护…', () => {
      pending = { ...freshPending(), kind: 'guard' };
      render();
    }, '1 AP：本轮代受某同伴下一次伤害', 1);
    mk('净化蓄能', () => cmd({ type: 'purify_charge', character: cur }), '1 AP：+1 净化', 1);
    if (cur === 'liya') mk('宝玉共鸣', () => cmd({ type: 'gem_attune', character: cur }), '1 AP：宝玉上放 1 净化（需已激活羁绊）', 1);
  }

  // 羁绊主动
  for (const b of v.bonds) {
    if (b.status !== 'active' || !b.cardUid || !b.pair.includes(cur)) continue;
    if (b.activeUsedRound === v.phase.round) continue;
    const d = BOND_CARD_BY_ID.get(v.cards[b.cardUid]?.defId ?? '');
    mk(`羁绊·${d?.name ?? ''}…`, () => {
      pending = { ...freshPending(), kind: 'bond_active', bondUid: b.cardUid! };
      render();
    }, `${d?.text ?? ''}（0 AP 每轮限一次）`);
  }
  // 装备主动
  for (const uid of ch.equipment) {
    const d = EQUIPMENT_CARD_BY_ID.get(v.cards[uid]?.defId ?? '');
    mk(`装备·${d?.name ?? ''}…`, () => {
      pending = { ...freshPending(), kind: 'equipment_active', equipmentUid: uid };
      render();
    }, `${d?.text ?? ''}（主动每轮限一次）`);
  }
  // 材料转让
  if (ch.materialTokens > 0) {
    mk('转材料…', () => {
      pending = { ...freshPending(), kind: 'transfer_material' };
      render();
    }, '同场景自由转让（免费）');
  }
  mk('结束回合', () => cmd({ type: 'end_turn', character: cur }));
}

/** 行动编排器（目标收集 → 提交指令） */
function renderPendingComposer(box: HTMLElement, cur: string): void {
  const p = pending;
  const v = view!;
  const info = document.createElement('div');
  info.innerHTML = `<b>编排行动中</b>：${pendingLabel(p)}<br/><span class="dim">已选危机 ${p.crisisUids.length} ｜ 角色 ${p.characters.join('、') || '—'} ｜ 场景 ${p.scene ?? '—'} ｜ 牌 ${p.cardUids.length}</span>`;
  // 打出卡牌：编排器同步显示卡面原文，确认目标时无需回手牌区翻查
  if (p.kind === 'play_card' && p.cardUid) {
    const t = cardDef(p.cardUid).text;
    if (t) info.innerHTML += `<br/><span class="dim">${esc(t)}</span>`;
  }
  box.appendChild(info);

  // 角色选择（同伴/任意角色）——支援卡打出时也需选目标
  const playCardNeedsChar = p.kind === 'play_card' && p.cardUid && needsChar(p.cardUid);
  const needChar = ['bond_active', 'equipment_active', 'guard', 'transfer_material', 'heal'].includes(p.kind ?? '') || playCardNeedsChar;
  if (needChar) {
    const row = document.createElement('div');
    row.innerHTML = '<span class="dim">选角色：</span>';
    for (const cid of v.turnOrder) {
      const c = v.characters[cid];
      if (!c?.alive) continue;
      // 支援卡排除自身（仅对不能自用的卡：战术转移/护卫誓言）
      if (playCardNeedsChar && needsCharExcludeSelf(p.cardUid!) && cid === cur) continue;
      const b = document.createElement('button');
      b.textContent = charName(cid);
      b.className = p.characters.includes(cid) ? 'sel' : '';
      b.onclick = () => {
        p.characters = [cid];
        render();
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  }

  // 场景选择（移动/卡牌移动效果/羁绊守护）
  const needScene = p.kind === 'scene_action' || p.kind === 'bond_active' || (p.kind === 'play_card' && needsScene(p.cardUid!));
  if (needScene) {
    // 移动编排：按引擎邻接表标记可直达场景（卡牌/羁绊效果不受相邻约束，不标记）
    const isMove = p.kind === 'scene_action';
    const from = isMove ? v.characters[cur]?.scene : undefined;
    const adjSet = from ? new Set(SCENE_ADJ[from] ?? []) : null;
    const row = document.createElement('div');
    row.innerHTML = '<span class="dim">选场景：</span>';
    for (const sid of Object.keys(SCENE_NAMES)) {
      const b = document.createElement('button');
      b.textContent = SCENE_NAMES[sid] ?? sid;
      b.className = p.scene === sid ? 'sel' : '';
      if (adjSet && sid !== from && !adjSet.has(sid)) {
        // 非相邻：置灰虚线，点击提示「不相邻」而非选中
        b.classList.add('no');
        b.title = '不相邻';
        b.onclick = () => {
          sceneHint = `「${SCENE_NAMES[sid]}」与当前位置不相邻`;
          render();
        };
      } else {
        b.onclick = () => {
          p.scene = sid;
          sceneHint = '';
          render();
        };
      }
      row.appendChild(b);
    }
    box.appendChild(row);
    if (p.kind === 'scene_action') {
      const baye = cur === 'baye';
      const air = document.createElement('button');
      air.textContent = '（巴爷）飞空艇前往';
      air.onclick = () => {
        if (p.scene) cmd({ type: 'move', character: cur, to: p.scene, via: 'airship' });
        pending = freshPending();
      };
      air.style.display = baye ? '' : 'none';
      row.appendChild(air);
    }
  }

  // 锻造：展示区装备选择 + 指示物补足数量
  if (p.kind === 'forge') {
    const row = document.createElement('div');
    row.innerHTML = '<span class="dim">选装备：</span>';
    for (const uid of view!.equipmentDisplay) {
      const b = document.createElement('button');
      const cd = cardDef(uid);
      b.textContent = cd.name;
      b.title = cd.text ?? '';
      b.className = p.equipmentUid === uid ? 'sel' : '';
      b.onclick = () => {
        p.equipmentUid = uid;
        render();
      };
      row.appendChild(b);
    }
    const tok = document.createElement('span');
    tok.innerHTML = ' ｜ <span class="dim">指示物补足：</span>';
    for (let n = 0; n <= 2; n++) {
      const b = document.createElement('button');
      b.textContent = `${n}`;
      b.className = p.useTokens === n ? 'sel' : '';
      b.onclick = () => {
        p.useTokens = n;
        render();
      };
      tok.appendChild(b);
    }
    row.appendChild(tok);
    box.appendChild(row);
  }

  // 消耗品声明（攻击）
  if (p.kind === 'play_card') {
    const ch = v.characters[cur]!;
    const row = document.createElement('div');
    row.innerHTML = `<span class="dim">声明消耗：</span>`;
    const mkN = (n: number) => {
      const b = document.createElement('button');
      b.textContent = `净化×${n}`;
      b.className = p.usePurify === n ? 'sel' : '';
      b.onclick = () => {
        p.usePurify = p.usePurify === n ? 0 : n;
        render();
      };
      if (ch.purifyTokens < n) b.disabled = true;
      row.appendChild(b);
    };
    mkN(1);
    mkN(2);
    mkN(3);
    if (ch.charms > 0) {
      const b = document.createElement('button');
      b.textContent = '信物+2';
      b.className = p.useCharm ? 'sel' : '';
      b.onclick = () => {
        p.useCharm = !p.useCharm;
        render();
      };
      row.appendChild(b);
    }
    if (ch.hasPet) {
      const b = document.createElement('button');
      b.textContent = '小剑+1';
      b.className = p.usePetAttack ? 'sel' : '';
      b.onclick = () => {
        p.usePetAttack = !p.usePetAttack;
        render();
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  }

  // 提交 / 取消
  const submit = document.createElement('button');
  submit.textContent = '✔ 提交';
  submit.onclick = () => {
    submitPending(cur);
    pending = freshPending();
    render();
  };
  const cancel = document.createElement('button');
  cancel.textContent = '✖ 取消';
  cancel.onclick = () => {
    pending = freshPending();
    render();
  };
  box.appendChild(submit);
  box.appendChild(cancel);
}

function needsScene(cardUid: string): boolean {
  const defId = view!.cards[cardUid]?.defId ?? '';
  return ['yu-03', 'yu-07', 'ya-02', 'ya-10', 'kai-03', 'ba-08'].includes(defId);
}

/** 支援卡需要选友方角色目标（治愈之矢/风之加护/公爵之令/战术转移/护卫誓言 等） */
function needsChar(cardUid: string): boolean {
  const defId = view!.cards[cardUid]?.defId ?? '';
  return ['ya-04', 'ya-07', 'kai-01', 'kai-03', 'kai-07'].includes(defId);
}

/** 需要排除自身的角色目标卡（战术转移/护卫誓言 不能对自己用） */
function needsCharExcludeSelf(cardUid: string): boolean {
  const defId = view!.cards[cardUid]?.defId ?? '';
  return ['kai-03', 'kai-07'].includes(defId);
}

function pendingLabel(p: PendingAction): string {
  switch (p.kind) {
    case 'play_card':
      return needsChar(p.cardUid!) ? `打出「${cardDef(p.cardUid!).name}」（选角色目标）` : `打出「${cardDef(p.cardUid!).name}」（在版图上点选危机目标）`;
    case 'forge':
      return '锻造：手牌区选材料卡 + 下方选装备';
    case 'send_letter':
      return '传书：手牌区选 1 张寄出';
    case 'bond_active':
      return '发动羁绊主动（按需选角色/场景/危机）';
    case 'equipment_active':
      return '发动装备主动（按需选角色）';
    case 'heal':
      return '治疗：手牌区选 1 张弃置';
    case 'guard':
      return '援护：选 1 名同伴';
    case 'transfer_material':
      return '转材料：选 1 名同场景角色（数量 1）';
    case 'scene_action':
      return '移动：选目标场景';
    default:
      return '';
  }
}

function submitPending(cur: string): void {
  const p = pending;
  const targets: Record<string, unknown> = {};
  if (p.crisisUids.length) targets['crisisUids'] = p.crisisUids;
  if (p.characters.length) targets['characters'] = p.characters;
  if (p.scene) targets['scene'] = p.scene;
  if (p.cardUids.length) targets['cardUids'] = p.cardUids;

  switch (p.kind) {
    case 'play_card':
      cmd({ type: 'play_card', character: cur, cardUid: p.cardUid, targets, usePurify: p.usePurify || undefined, useCharm: p.useCharm || undefined, usePetAttack: p.usePetAttack || undefined });
      break;
    case 'forge':
      cmd({ type: 'forge', character: cur, equipmentUid: p.equipmentUid ?? view!.equipmentDisplay[0], materialCardUids: p.cardUids, useTokens: p.useTokens });
      break;
    case 'send_letter':
      cmd({ type: 'send_letter', character: cur, cardUid: p.cardUids[0] ?? p.cardUid });
      break;
    case 'scene_action':
      if (p.scene) cmd({ type: 'move', character: cur, to: p.scene });
      break;
    case 'bond_active':
      cmd({ type: 'bond_active', character: cur, bondUid: p.bondUid, params: targets });
      break;
    case 'equipment_active':
      cmd({ type: 'equipment_active', character: cur, equipmentUid: p.equipmentUid, params: { target: p.characters[0] ?? p.scene } });
      break;
    case 'heal':
      cmd({ type: 'heal', character: cur, discardUid: p.cardUids[0], target: p.characters[0] ?? cur });
      break;
    case 'guard':
      cmd({ type: 'guard', character: cur, target: p.characters[0] });
      break;
    case 'transfer_material':
      cmd({ type: 'transfer_material', character: cur, to: p.characters[0], count: 1 });
      break;
  }
}

// ── 决策面板 ───────────────────────────────────────────────────────────────────

function renderDecision(): void {
  const v = view!;
  const box = $('decision');
  const d = v.pendingDecision;
  if (!d) {
    box.style.display = 'none';
    return;
  }
  const mine = d.decider === 'all' || v.controlledCharacters.includes(d.decider);
  if (!mine || !d.options) {
    box.style.display = '';
    box.innerHTML = `<span class="dim">等待 ${d.decider === 'all' ? '桌上' : charName(d.decider)} 决策中（${d.kind}）…</span>`;
    return;
  }
  box.style.display = '';
  const o = d.options;
  const parts: string[] = [`<div><b>需要你的决策</b>：${o.prompt ?? d.kind}</div>`];
  // tip：卡牌类决策在选项旁内联显示效果原文，无需翻规则书
  const btn = (label: string, choice: unknown, tip = '') => {
    parts.push(`<div class="opt"><button data-choice='${JSON.stringify(choice)}'>${label}</button>${tip ? `<span class="dim">${esc(tip)}</span>` : ''}</div>`);
  };

  switch (d.kind) {
    case 'place_crisis':
      for (const s of o.scenes as string[]) btn(SCENE_NAMES[s] ?? s, { scene: s });
      break;
    case 'choose_character':
      for (const c of o.candidates as string[]) btn(charName(c), { character: c });
      break;
    case 'choose_crisis':
      for (const u of (o.cardUids as string[]) ?? []) btn(cardDef(u).name, { cardUid: u }, cardDef(u).text ?? '');
      if (o.optional) btn('跳过', { cardUid: null });
      break;
    case 'choose_bond_card':
      for (const u of o.candidateUids as string[]) btn(cardDef(u).name, { cardUid: u }, cardDef(u).text ?? '');
      break;
    case 'choose_option':
      for (const opt of o.options as Array<{ id: string; label: string }>) btn(opt.label, { option: opt.id });
      break;
    case 'choose_cards':
      renderCardPicker(parts, o.cardUids as string[], o.min as number, o.max as number, d.id);
      break;
    case 'order_effects':
      renderOrderPicker(parts, (o.items as Array<{ uid: string; defId: string }>).map((i) => i.uid), d.id);
      break;
    case 'reorder_cards':
      if (o.mode === 'scout') {
        for (const u of o.cardUids as string[]) btn(`置底：${cardDef(u).name}`, { bottom: u }, cardDef(u).text ?? '');
      } else {
        renderOrderPicker(parts, o.cardUids as string[], d.id);
      }
      break;
    case 'choose_share_high':
      for (const c of o.candidates as string[]) btn(`${charName(c)} 承担高份`, { highTaker: c });
      break;
    case 'choose_redirect':
      for (const c of o.candidates as Array<{ buffId: string; guardian: string }>) btn(`由 ${charName(c.guardian)} 代受`, { buffId: c.buffId });
      break;
    case 'choose_equipment':
      if (o.dropOnly) {
        for (const u of o.equipmentUids as string[]) btn(`弃置：${cardDef(u).name}`, { equipmentUid: u }, cardDef(u).text ?? '');
      } else {
        for (const u of o.equipmentUids as string[]) {
          for (const owner of (o.owners as string[]) ?? []) {
            btn(`${cardDef(u).name} → ${charName(owner)}`, { equipmentUid: u, owner }, cardDef(u).text ?? '');
          }
        }
      }
      break;
    default:
      parts.push(`<span class="dim">未知决策类型 ${d.kind}</span>`);
  }

  box.innerHTML = parts.join('');
  box.querySelectorAll('button[data-choice]').forEach((el) => {
    el.addEventListener('click', () => {
      cmd({ type: 'resolve_decision', decisionId: d.id, choice: JSON.parse((el as HTMLElement).dataset.choice!) });
    });
  });
}

/** choose_cards：复选 + 提交 */
function renderCardPicker(parts: string[], uids: string[], min: number, max: number, decisionId: string): void {
  parts.push('<div class="dim">点击选择（悬停看卡面原文；' + (min === max ? `恰 ${min} 张` : `${min}~${max} 张`) + '）：</div>');
  parts.push(uids.map((u) => `<span class="card pickable hastip" data-uid="${u}">${esc(cardDef(u).name)}${cardTip(u)}</span>`).join(''));
  parts.push(`<button class="submit-cards" data-dec="${decisionId}">✔ 确认选择</button>`);
  // 事件在下一帧绑定（innerHTML 后）
  setTimeout(() => {
    const sel = new Set<string>();
    document.querySelectorAll('#decision .pickable').forEach((el) => {
      el.addEventListener('click', () => {
        const uid = (el as HTMLElement).dataset.uid!;
        if (sel.has(uid)) sel.delete(uid);
        else if (sel.size < max) sel.add(uid);
        (el as HTMLElement).classList.toggle('sel');
      });
    });
    document.querySelector('#decision .submit-cards')?.addEventListener('click', () => {
      if (sel.size >= min) cmd({ type: 'resolve_decision', decisionId, choice: { cardUids: [...sel] } });
    });
  }, 0);
}

/** order/reorder：按点击顺序排列 + 提交 */
function renderOrderPicker(parts: string[], uids: string[], decisionId: string): void {
  parts.push('<div class="dim">按期望顺序点击（先点 = 先结算/牌库顶；悬停看卡面原文）：</div><div class="order-state"></div>');
  parts.push(uids.map((u) => `<span class="card orderable hastip" data-uid="${u}">${esc(cardDef(u).name)}${cardTip(u)}</span>`).join(''));
  parts.push(`<button class="submit-order" data-dec="${decisionId}">✔ 确认顺序</button>`);
  setTimeout(() => {
    const order: string[] = [];
    document.querySelectorAll('#decision .orderable').forEach((el) => {
      el.addEventListener('click', () => {
        const uid = (el as HTMLElement).dataset.uid!;
        if (order.includes(uid)) return;
        order.push(uid);
        (el as HTMLElement).classList.add('sel');
        const st = document.querySelector('#decision .order-state');
        if (st) st.textContent = `已选：${order.map((u) => cardDef(u).name).join(' → ')}`;
      });
    });
    document.querySelector('#decision .submit-order')?.addEventListener('click', () => {
      const full = [...order, ...uids.filter((u) => !order.includes(u))];
      cmd({ type: 'resolve_decision', decisionId, choice: { order: full } });
    });
  }, 0);
}

// ── 日志 ──────────────────────────────────────────────────────────────────────

/** 事件日志：每行一个 div，按类型着色（伤害红/治疗绿/系统灰/决策黄/错误亮红）；行尾 \n 仅留于 textContent 供工具链读取 */
function log(line: string, cls = ''): void {
  const el = $('log');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = `${line}\n`;
  el.appendChild(div);
  while (el.childElementCount > 400) el.removeChild(el.firstElementChild!);
  el.scrollTop = el.scrollHeight;
}

/** 事件类型 → 日志着色类 */
function evClass(kind: string): string {
  if (['character_damaged', 'character_eliminated', 'counter_attack', 'boss_damaged', 'erosion_changed', 'berserk_started', 'boss_action'].includes(kind)) return 'l-dmg';
  if (['character_healed', 'berserk_ended'].includes(kind)) return 'l-heal';
  if (kind === 'decision_required') return 'l-dec';
  if (['phase_entered', 'deck_reshuffled', 'crisis_deck_reshuffled', 'turn_started', 'turn_ended', 'game_over', 'final_battle_started', 'boss_stage_changed'].includes(kind)) return 'l-sys';
  return '';
}

function fmtEvent(ev: { kind: string }): string {
  const e = ev as Record<string, unknown>;
  switch (ev.kind) {
    case 'phase_entered':
      return `▶ ${PHASE_NAMES[e['phase'] as string] ?? e['phase']}`;
    case 'card_drawn': {
      const defId = e['cardDefId'] as string;
      const d = defId ? defOf(defId) : undefined;
      return d
        ? `＋ ${charName(e['character'] as string)} 抽到「${d.name}」`
        : `＋ ${charName(e['character'] as string)} 抽牌`;
    }
    case 'deck_reshuffled':
      return `↻ ${charName(e['character'] as string)} 弃牌堆洗回牌库`;
    case 'crisis_deck_reshuffled':
      return `↻ 危机弃牌堆洗混重建`;
    case 'character_healed':
      return `✚ ${charName(e['character'] as string)} 恢复 ${e['amount']} 点生命`;
    case 'erosion_changed':
      return `☠ 小鱼侵蚀 → ${e['amount']}`;
    case 'berserk_started':
      return `‼ 小鱼失控！`;
    case 'berserk_ended':
      return `◎ 小鱼脱离失控`;
    case 'redirected':
      return `➹ ${charName(e['to'] as string)} 代受了 ${charName(e['from'] as string)} 的伤害`;
    case 'shared':
      return `⚖ 伤害分摊：${charName(e['a'] as string)} ${e['amountA']} / ${charName(e['b'] as string)} ${e['amountB']}`;
    case 'material_gained':
      return `⚙ ${charName(e['character'] as string)} +${e['count']} 材料`;
    case 'purify_gained':
      return `✿ ${charName(e['character'] as string)} +${e['count']} 净化`;
    case 'prejudice_flipped':
      return `⚡ 偏见触发：${SCENE_NAMES[e['scene'] as string]} 额外危机`;
    case 'letter_received': {
      // 书信翻开（仅发送/接收方座位能拿到 cardUid，其余座位服务端已脱敏）
      const uid = e['cardUid'] as string;
      const extra = uid ? `「${cardDef(uid).name}」：${cardDef(uid).text ?? ''}` : '';
      return `✉ ${charName(e['character'] as string)} 展开书信${extra}`;
    }
    case 'letter_card_drawn': {
      // 传书卡揭示（非涉及方座位 cardDefId 已脱敏为空，不解析文案）
      const defId = e['cardDefId'] as string;
      const d = defId ? defOf(defId) : undefined;
      return d ? `✉ 传书卡「${d.name}」：${d.text}` : `✉ ${charName(e['character'] as string)} 抽取一张传书卡（牌面对你隐藏）`;
    }
    case 'boss_action':
      return `◆ 玫拉行动：${e['action']}`;
    case 'counter_attack':
      return `◆ 玫拉反击 → ${charName(e['target'] as string)}`;
    case 'boss_damaged':
      return `◆ 玫拉受 ${e['amount']} 点伤害（${e['shielded'] ? '护盾吸收' : '本体'}）`;
    case 'equipment_dropped':
      return `⚒ ${charName(e['character'] as string)} 弃置装备`;
    case 'turn_ended':
      return `— ${charName(e['character'] as string)} 回合结束`;
    case 'turn_started':
      return `— ${charName(e['character'] as string)} 回合（AP ${e['ap']}）`;
    case 'moved':
      return `⇒ ${charName(e['character'] as string)}：${SCENE_NAMES[e['from'] as string]}→${SCENE_NAMES[e['to'] as string]}`;
    case 'card_played': {
      // 打出的卡牌为公开信息（桌面对等：亮出结算），直接按 defId 附原文
      const d = defOf(e['cardDefId'] as string);
      return d
        ? `✦ ${charName(e['character'] as string)} 打出「${d.name}」：${d.text}`
        : `✦ ${charName(e['character'] as string)} 打出「${cardDef(e['cardUid'] as string).name}」`;
    }
    case 'crisis_flipped': {
      const d = defOf(e['cardDefId'] as string);
      return d
        ? `⚠ 危机「${d.name}」→ ${SCENE_NAMES[e['scene'] as string]}：${d.text}`
        : `⚠ 危机「${cardDef(e['cardUid'] as string).name}」→ ${SCENE_NAMES[e['scene'] as string]}`;
    }
    case 'crisis_cleared':
      return `✔ 危机清除「${cardDef(e['cardUid'] as string).name}」（参与：${(e['participants'] as string[]).map(charName).join('、')}）`;
    case 'character_damaged':
      return `✸ ${charName(e['character'] as string)} 受 ${e['amount']} 点伤害`;
    case 'character_eliminated':
      return `💀 ${charName(e['character'] as string)} 出局`;
    case 'bond_formed': {
      // 结成羁绊为公开揭示（卡面朝上置于两角色之间），附原文
      const d = defOf(e['cardDefId'] as string);
      return d ? `♥ 结成羁绊：${d.name}——${d.text}` : `♥ 结成羁绊：${cardDef(e['cardUid'] as string).name}`;
    }
    case 'letter_sent':
      return `✉ ${charName(e['from'] as string)} → ${charName(e['to'] as string)}`;
    case 'forged':
      return `⚒ ${charName(e['character'] as string)} 锻造「${cardDef(e['equipmentUid'] as string).name}」`;
    case 'boss_stage_changed':
      return `◆ 玫拉进入阶段 ${e['stage']}`;
    case 'final_battle_started':
      return `◆◆ 最终决战！玫拉 ${e['bossHp']} 血 / 护盾 ${e['shield']}`;
    case 'game_over':
      return `■ ${e['result'] === 'victory' ? '胜利' : '失败'}：${e['reason']}`;
    case 'decision_required':
      return `？ 等待决策（${(e['decision'] as { kind: string }).kind}）`;
    default:
      return JSON.stringify(ev);
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

/** 触屏点选浮层：点 .hastip 元素弹出/再点关闭，点页面空白全部关闭，同时只开一个；桌面 hover 由 CSS 保留 */
document.addEventListener('click', (ev) => {
  // 点浮层内部不关闭（允许选中文本/滚动长文案）
  if ((ev.target as HTMLElement).closest?.('.tip')) return;
  const host = (ev.target as HTMLElement).closest?.('.hastip') as HTMLElement | null;
  const wasOpen = host?.classList.contains('tip-open') ?? false;
  document.querySelectorAll('.hastip.tip-open').forEach((el) => el.classList.remove('tip-open'));
  if (host && !wasOpen) host.classList.add('tip-open');
});

$('create').onclick = () => send({ op: 'create', name: ($('name') as HTMLInputElement).value });
$('join').onclick = () =>
  send({ op: 'join', roomId: ($('roomId') as HTMLInputElement).value.trim().toUpperCase(), name: ($('name') as HTMLInputElement).value });
$('rejoin').onclick = () =>
  send({
    op: 'rejoin',
    roomId: (($('roomId') as HTMLInputElement).value || localStorage.getItem('elf-room') || '').trim().toUpperCase(),
    token: localStorage.getItem('elf-token') ?? '',
  });
$('start').onclick = () => send({ op: 'start', benchCharacter: ($('bench') as HTMLSelectElement).value });
$('addAi').onclick = () => send({ op: 'add_ai' });
$('shuffleSeats').onclick = () => send({ op: 'shuffle_seats' });
($('roomId') as HTMLInputElement).value = localStorage.getItem('elf-room') ?? '';

// ── 背景音乐播放器 ────────────────────────────────────────────────────────────
(() => {
  const audio = document.getElementById('bgm') as HTMLAudioElement | null;
  const btn = document.getElementById('bgmBtn');
  if (!audio || !btn) return;
  const label = btn.querySelector('.label')!;
  audio.volume = 0.35;
  btn.addEventListener('click', () => {
    if (audio.paused) {
      audio.play().then(() => {
        btn.classList.add('playing');
        label.textContent = '暂停音乐';
      }).catch(() => {
        label.textContent = '点击重试';
      });
    } else {
      audio.pause();
      btn.classList.remove('playing');
      label.textContent = '播放音乐';
    }
  });
  audio.addEventListener('error', () => {
    label.textContent = '播放失败';
    btn.classList.remove('playing');
  });
})();

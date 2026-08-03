/**
 * 伤害结算：有序效果链（§11，冻结【裁A-08】）+ 终端应用（代受/分摊/减免/侵蚀/出局）。
 *
 * 链序规则（数字化映射，冻结）：
 *   静态修饰（被动/装备/持续buff）按 createdOrder（= 实际打出/声明顺序）
 *   → 卡面自带修正（结算时声明）
 *   → 攻击声明消耗品（净化→信物→小剑，固定次序）
 *   → 目标侧节点（玫拉 P3 BOSS_P3）
 *   → 终端：代受（玩家定承受者，按承受者减免【裁A-29】）
 *          → 分摊（总额守恒 ceil+floor，高份玩家定【裁A-30】）
 *          → 承受者 REDUCE 链（各节点钳 0）
 */
import type {
  Buff,
  CharacterId,
  GameEvent,
  GameState,
} from '../types.js';
import { EngineError } from '../types.js';
import { emitEv, suspendDecision } from './common.js';

// ── 链节点 ──────────────────────────────────────────────────────────────────

export type ChainNode =
  | { op: 'ADD'; value: number; source: string }
  | { op: 'MULT'; value: number; source: string }
  | { op: 'REDUCE'; value: number; source: string }       // 钳 0
  | { op: 'BOSS_P3'; value: number; source: string };     // 钳 1

export interface DamageInstance {
  base: number;
  chain: ChainNode[];
  /** 来源标识（侵蚀触发/反击判定用）：'attack_card' | 'crisis' | 'boss' | 'berserk' | 'effect' */
  source: string;
  /** 是否黑暗伤害（宝玉侵蚀/侵蚀 T2/T5 判定） */
  dark: boolean;
  /** 是否攻击卡来源（屠龙者之血【裁A-12】/反击【裁A-35】判定） */
  fromAttackCard: boolean;
}

/** 逐步折叠（后项作用于前项结果） */
export function foldChain(d: DamageInstance): number {
  let v = d.base;
  for (const node of d.chain) {
    switch (node.op) {
      case 'ADD':
        v += node.value;
        break;
      case 'MULT':
        v *= node.value;
        break;
      case 'REDUCE':
        v = Math.max(0, v - node.value);
        break;
      case 'BOSS_P3':
        v = Math.max(1, v - node.value);
        break;
    }
  }
  return v;
}

// ── Buff 辅助 ───────────────────────────────────────────────────────────────

export function addBuff(state: GameState, buff: Omit<Buff, 'id' | 'createdOrder'>): void {
  state.orderCounter += 1;
  state.buffs.push({ ...buff, id: `buff-${state.orderCounter}`, createdOrder: state.orderCounter });
}

export function consumeBuff(state: GameState, buffId: string): void {
  state.buffs = state.buffs.filter((b) => b.id !== buffId);
}

export function findBuffs(state: GameState, pred: (b: Buff) => boolean): Buff[] {
  return state.buffs.filter(pred).sort((a, b) => a.createdOrder - b.createdOrder);
}

// ── 角色伤害终端（含代受/分摊/减免/侵蚀/出局/羁-01回血）────────────────────────

export interface CharacterDamageRequest {
  target: CharacterId;
  damage: DamageInstance;
  /** 来源危机卡 uid（凯-07 材料判定/T2 侵蚀） */
  sourceCrisisUid?: string;
  /** 已锁定的分摊伙伴（羁-10/巴-09 激活时由系统传入） */
  forcedSharePartner?: CharacterId;
}

/**
 * 对角色造成伤害的完整终端管线。
 * 可能产出 PendingDecision（多代受/分摊高份/羁-02代受询问），此时伤害挂起，
 * 由 decisions.ts 的 resume 'damage:apply' 续算；
 * then 为外层流程的续算点（挂起时压入 resumeStack）。
 */
export function dealDamageToCharacter(
  state: GameState,
  events: GameEvent[],
  req: CharacterDamageRequest,
  then?: import('../types.js').ResumeRef,
): void {
  const target = state.characters[req.target];
  if (!target?.alive) return; // 出局不可被选为目标【裁A-06】
  const baseAmount = foldChain(req.damage);
  const suspendWith = (d: Parameters<typeof suspendDecision>[2]) => {
    if (then) state.resumeStack.push(then);
    suspendDecision(state, events, d);
  };

  // ── 羁-02 被动：小鱼受黑暗伤害，莉雅可选择代受（代受后小鱼不放侵蚀【裁A-29】）──
  if (
    req.target === 'xiaoyu' &&
    req.damage.dark &&
    baseAmount > 0 &&
    hasActiveBond(state, 'xiaoyu', 'liya', 'bond-02') &&
    isAliveAndPresent(state, 'liya')
  ) {
    suspendWith({
      kind: 'choose_option',
      decider: 'liya',
      options: {
        prompt: '莉雅是否为小鱼代受此次黑暗伤害（羁-02）？',
        options: [
          { id: 'intercept', label: '代受' },
          { id: 'pass', label: '不代受' },
        ],
      },
      resume: { sys: 'damage', op: 'apply', data: { ...serializeReq(req), bond02Asked: true } },
    });
    return;
  }

  // ── 代受（guard buff：援护/凯-07/羁-09主动）──
  const guards = findBuffs(
    state,
    (b) => b.kind === 'guard' && b.target === req.target && (!b.partner || state.characters[b.partner]?.alive === true),
  );
  if (guards.length > 0 && baseAmount > 0) {
    if (guards.length === 1) {
      const g = guards[0]!;
      consumeBuff(state, g.id);
      const receiver = g.partner!;
      emitEv(events, { kind: 'redirected', from: req.target, to: receiver });
      const applied = applyFinal(state, events, receiver, baseAmount, req, g);
      completeDamageEvent(state, events, req, applied > 0);
      return;
    }
    // 多代受：玩家决定承受者【裁A-29】
    suspendWith({
      kind: 'choose_redirect',
      decider: req.target,
      options: { prompt: '选择代受承受者', candidates: guards.map((g) => ({ buffId: g.id, guardian: g.partner })) },
      resume: { sys: 'damage', op: 'apply', data: serializeReq(req) },
    });
    return;
  }

  // ── 分摊（share buff：巴-09/羁-10主动；羁-01被动常驻见 hasActiveBond）──
  const sharePartner = req.forcedSharePartner ?? findSharePartner(state, req.target);
  if (sharePartner && baseAmount > 0) {
    // 偶数伤害两半相等，无需询问高份归属【裁A-30】
    if (baseAmount % 2 === 0) {
      const half = baseAmount / 2;
      emitEv(events, { kind: 'shared', a: req.target, b: sharePartner, amountA: half, amountB: half });
      const a1 = applyFinal(state, events, req.target, half, req, null, true);
      const a2 = applyFinal(state, events, sharePartner, half, req, null, true);
      completeDamageEvent(state, events, req, a1 > 0 || a2 > 0);
      return;
    }
    suspendWith({
      kind: 'choose_share_high',
      decider: req.target,
      options: {
        prompt: `与 ${sharePartner} 分摊 ${baseAmount} 点伤害，谁承担较高份（${Math.ceil(baseAmount / 2)}）？`,
        candidates: [req.target, sharePartner],
        low: Math.floor(baseAmount / 2),
        high: Math.ceil(baseAmount / 2),
      },
      resume: { sys: 'damage', op: 'apply', data: { ...serializeReq(req), sharePartner } },
    });
    return;
  }

  const applied = applyFinal(state, events, req.target, baseAmount, req, null);
  completeDamageEvent(state, events, req, applied > 0);
}

/** resume 'damage:apply' 的续算入口（decisions.ts 调用） */
export function resumeDamageApply(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const req = deserializeReq(data);
  const c = (choice ?? {}) as Record<string, unknown>;

  // 羁-02 代受询问的回答
  if (data['bond02Asked'] === true && req.target === 'xiaoyu') {
    if (c['option'] === 'intercept') {
      const amount = foldChain(req.damage);
      emitEv(events, { kind: 'redirected', from: 'xiaoyu', to: 'liya' });
      // 代受后小鱼不放侵蚀：把伤害标记为非黑暗交给莉雅（T2/T5 只认小鱼受黑暗伤害）
      const applied = applyFinal(state, events, 'liya', amount, { ...req, damage: { ...req.damage, dark: false } }, null);
      completeDamageEvent(state, events, req, applied > 0);
      return;
    }
    const amount = foldChain(req.damage);
    const applied = applyFinal(state, events, req.target, amount, req, null);
    completeDamageEvent(state, events, req, applied > 0);
    return;
  }

  // 多代受承受者选择
  if (typeof c['buffId'] === 'string') {
    const g = state.buffs.find((b) => b.id === c['buffId'] && b.kind === 'guard');
    if (!g) throw new EngineError('invalid_choice', '代受 buff 不存在');
    consumeBuff(state, g.id);
    const amount = foldChain(req.damage);
    emitEv(events, { kind: 'redirected', from: req.target, to: g.partner! });
    const applied = applyFinal(state, events, g.partner!, amount, req, g);
    completeDamageEvent(state, events, req, applied > 0);
    return;
  }

  // 分摊高份归属
  if (typeof data['sharePartner'] === 'string') {
    const partner = data['sharePartner'] as CharacterId;
    const amount = foldChain(req.damage);
    const high = Math.ceil(amount / 2);
    const low = Math.floor(amount / 2);
    const highTaker = (c['highTaker'] as CharacterId | undefined) ?? req.target;
    if (highTaker !== req.target && highTaker !== partner) throw new EngineError('invalid_choice', '高份承受者非法');
    const a = highTaker === req.target ? high : low;
    const b = highTaker === req.target ? low : high;
    emitEv(events, { kind: 'shared', a: req.target, b: partner, amountA: a, amountB: b });
    // 分摊后各自走自己的减免链【裁A-30】
    const a1 = applyFinal(state, events, req.target, a, req, null, true);
    const a2 = applyFinal(state, events, partner, b, req, null, true);
    completeDamageEvent(state, events, req, a1 > 0 || a2 > 0);
    return;
  }

  throw new EngineError('invalid_choice', '无法识别的伤害续算选择');
}

/**
 * 伤害事件收口（【A-47】事件级触发）：
 * 一次伤害事件内至少一方实承 >0 → 羁-01 被动两人各回 1（合计 2，仅一次）；双 0 不触发。
 */
function completeDamageEvent(state: GameState, events: GameEvent[], req: CharacterDamageRequest, anyApplied: boolean): void {
  if (!anyApplied) return;
  if (req.target !== 'xiaoyu' && req.target !== 'liya') return;
  if (!hasActiveBond(state, 'xiaoyu', 'liya', 'bond-01')) return;
  healCharacter(state, events, 'xiaoyu', 1);
  healCharacter(state, events, 'liya', 1);
}

/** 终段：承受者减免链 → 扣血 → 衍生（侵蚀/出局/凯-07材料）。返回实承伤害。 */
function applyFinal(
  state: GameState,
  events: GameEvent[],
  receiver: CharacterId,
  amount: number,
  req: CharacterDamageRequest,
  usedGuard: Buff | null,
  fromShare = false,
): number {
  const ch = state.characters[receiver];
  if (!ch?.alive) return 0;
  let v = amount;

  // 代受 buff 自带的减伤（羁-09 主动：该伤害 -2）先行扣减（钳 0）
  if (usedGuard && usedGuard.value > 0) v = Math.max(0, v - usedGuard.value);

  // 承受者 REDUCE 链（各节点钳 0；节点顺序 = 声明顺序）
  const reduces = collectReducers(state, receiver);
  for (const node of reduces) {
    v = Math.max(0, v - node.value);
    if (node.consumeBuffId) consumeBuff(state, node.consumeBuffId);
    if (node.markUsedKey) state.roundUsage[node.markUsedKey] = true;
  }

  if (v > 0) {
    ch.hp = Math.max(0, ch.hp - v);
    ch.damagedThisRound = true;
    emitEv(events, { kind: 'character_damaged', character: receiver, amount: v, source: req.damage.source, dark: req.damage.dark });
  }

  // 凯-07：代受来源为【暗】危机 → 声明者获 1 材料
  if (usedGuard?.source === 'kai-07' && req.damage.dark && v > 0) {
    gainMaterial(state, events, receiver, 1);
  }

  // 侵蚀 T2/T5：小鱼因【暗】来源受到伤害（按事件计 1 个，与点数无关【裁A-35】）
  if (receiver === 'xiaoyu' && req.damage.dark && v > 0 && !isBerserk(state)) {
    changeErosion(state, events, 1, req.damage.source === 'boss_counter' ? 'T5' : 'T2');
  }

  // 出局判定【裁A-06】
  if (ch.hp <= 0 && ch.alive) {
    eliminate(state, events, receiver);
  }
  void fromShare;
  return v;
}

/** 承受者减免节点收集（声明顺序） */
function collectReducers(state: GameState, receiver: CharacterId): Array<{ value: number; source: string; consumeBuffId?: string; markUsedKey?: string }> {
  const out: Array<{ value: number; source: string; consumeBuffId?: string; markUsedKey?: string; order: number }> = [];
  const ch = state.characters[receiver];
  if (!ch) return [];

  // 装备被动：装-01 龙鳞护甲（永久，声明顺序视为获得时刻——近似按固定小序号）
  for (const uid of ch.equipment) {
    if (state.cards[uid]?.defId === 'equip-01') out.push({ value: 1, source: 'equip-01', order: -2 });
    if (state.cards[uid]?.defId === 'equip-04') { /* 上限效果，非减免 */ }
  }
  // 凯尔被动：公爵威严（同场景精灵 -1；精灵与人类结羁绊且持卡 -2【C8】）
  const kaier = state.characters['kaier'];
  if (kaier?.alive && kaier.scene === ch.scene && receiver !== 'kaier') {
    const def = receiver === 'liya' ? 'elf' : null;
    if (def === 'elf') {
      const bondedWithHuman = state.bonds.some(
        (b) => b.status === 'active' && b.cardUid && b.pair.includes(receiver) && b.pair.some((p) => p === 'xiaoyu' || p === 'baye'),
      );
      out.push({ value: bondedWithHuman ? 2 : 1, source: 'kaier-passive', order: -1 });
    }
  }
  // 羁-06：凯尔的减免类效果（持续 buff + 装备 + 被动）共享给巴爷【裁A-31】
  const bond06Share = receiver === 'baye' && hasActiveBond(state, 'kaier', 'baye', 'bond-06') && kaier?.alive && kaier.scene === ch.scene;
  if (bond06Share) {
    for (const uid of kaier!.equipment) {
      if (state.cards[uid]?.defId === 'equip-01') out.push({ value: 1, source: 'bond-06-equip-01', order: -2 });
    }
  }
  // buff 类减免（按声明顺序）
  for (const b of findBuffs(state, (x) => x.kind === 'damage_reduce' && (!x.target || x.target === receiver) && (!x.scene || x.scene === ch.scene))) {
    out.push({ value: b.value, source: b.source, order: b.createdOrder });
  }
  // 羁-06：凯尔身上的持续 buff 减免（含装-01 主动）同样作用于巴爷【裁A-31】
  if (bond06Share) {
    for (const b of findBuffs(state, (x) => x.kind === 'damage_reduce' && x.target === 'kaier')) {
      out.push({ value: b.value, source: `bond-06:${b.source}`, order: b.createdOrder });
    }
  }
  // 每轮第一次受伤 -1（羁-04：双方不同场景时）
  const bond04 = state.bonds.find((b) => b.status === 'active' && b.cardUid && state.cards[b.cardUid]?.defId === 'bond-04' && b.pair.includes(receiver));
  if (bond04) {
    const other = bond04.pair[0] === receiver ? bond04.pair[1] : bond04.pair[0];
    const otherCh = state.characters[other];
    const key = `bond04:${receiver}`;
    if (otherCh?.alive && otherCh.scene !== ch.scene && !state.roundUsage[key]) {
      out.push({ value: 1, source: 'bond-04', order: 1e9 - 2, markUsedKey: key });
    }
  }
  // 传-03：下一次伤害 -1（一次性 buff，已含于 buffs，见 kind first_damage_reduce）
  for (const b of findBuffs(state, (x) => x.kind === 'first_damage_reduce' && x.target === receiver)) {
    out.push({ value: b.value, source: b.source, order: b.createdOrder, consumeBuffId: b.id });
  }
  // 小剑与小盾：防御选择（play_card/usePetDefend 声明；此处处理来自危机/首领的被动伤害时由声明侧传入）
  out.sort((a, b) => a.order - b.order);
  return out.map(({ value, source, consumeBuffId, markUsedKey }) => ({ value, source, ...(consumeBuffId ? { consumeBuffId } : {}), ...(markUsedKey ? { markUsedKey } : {}) }));
}

// ── 分摊/羁绊查询 ────────────────────────────────────────────────────────────

export function findSharePartner(state: GameState, target: CharacterId): CharacterId | null {
  // 羁-01 被动：同场景生命共享
  const b01 = state.bonds.find((b) => b.status === 'active' && b.cardUid && state.cards[b.cardUid]?.defId === 'bond-01' && b.pair.includes(target));
  if (b01) {
    const other = b01.pair[0] === target ? b01.pair[1] : b01.pair[0];
    const t = state.characters[target];
    const o = state.characters[other];
    if (t?.alive && o?.alive && t.scene === o.scene) return other;
  }
  // share buff（巴-09/羁-10）
  const buff = findBuffs(state, (b) => b.kind === 'share' && (b.target === target || b.partner === target))[0];
  if (buff) {
    const other = buff.target === target ? buff.partner! : buff.target!;
    if (state.characters[other]?.alive) return other;
  }
  return null;
}

export function hasActiveBond(state: GameState, a: CharacterId, b: CharacterId, defId?: string): boolean {
  return state.bonds.some(
    (x) =>
      x.status === 'active' &&
      x.cardUid !== null &&
      x.pair.includes(a) &&
      x.pair.includes(b) &&
      (defId === undefined || state.cards[x.cardUid]?.defId === defId),
  );
}

export function isAliveAndPresent(state: GameState, c: CharacterId): boolean {
  return state.characters[c]?.alive === true;
}

// ── 生命/材料/净化/侵蚀 原语 ─────────────────────────────────────────────────

export function healCharacter(state: GameState, events: GameEvent[], c: CharacterId, n: number): void {
  const ch = state.characters[c];
  if (!ch?.alive || n <= 0) return;
  const real = Math.min(n, ch.maxHp - ch.hp);
  if (real > 0) {
    ch.hp += real;
    emitEv(events, { kind: 'character_healed', character: c, amount: real });
  }
}

export function gainMaterial(state: GameState, events: GameEvent[], c: CharacterId, n: number): void {
  const ch = state.characters[c];
  if (!ch?.alive || n <= 0) return;
  // 【裁A-28】溢出丢失
  const real = Math.min(n, 4 - ch.materialTokens);
  if (real > 0) {
    ch.materialTokens += real;
    emitEv(events, { kind: 'material_gained', character: c, count: real });
  }
}

export function gainPurify(state: GameState, events: GameEvent[], c: CharacterId, n: number): void {
  const ch = state.characters[c];
  if (!ch?.alive || n <= 0) return;
  const real = Math.min(n, 3 - ch.purifyTokens);
  if (real > 0) {
    ch.purifyTokens += real;
    emitEv(events, { kind: 'purify_gained', character: c, count: real });
  }
}

export function isBerserk(state: GameState): boolean {
  return (state.characters['xiaoyu']?.erosion ?? 0) >= 4;
}

/** 失控进入钩子（羁-02 替换【裁A-04】，由 bonds.ts 注册，避免循环依赖） */
let berserkStartHook: ((state: GameState, events: GameEvent[]) => void) | null = null;
export function setBerserkStartHook(fn: (state: GameState, events: GameEvent[]) => void): void {
  berserkStartHook = fn;
}

/** 侵蚀增减（§6.4）；进入失控触发羁-02 替换钩子【裁A-04】 */
export function changeErosion(state: GameState, events: GameEvent[], delta: number, _trigger: string): void {
  const x = state.characters['xiaoyu'];
  if (!x?.alive) return;
  const before = x.erosion;
  if (delta > 0 && before >= 4) return; // 失控后不再增加【L170】
  x.erosion = Math.max(0, Math.min(4, before + delta));
  if (x.erosion !== before) emitEv(events, { kind: 'erosion_changed', amount: x.erosion });
  if (before < 4 && x.erosion >= 4) {
    emitEv(events, { kind: 'berserk_started' });
    state.flags.berserkCountdown = 0; // 【裁A-07】进入失控计数=0
    berserkStartHook?.(state, events);
  }
  if (before >= 4 && x.erosion <= 3) {
    emitEv(events, { kind: 'berserk_ended' });
    state.flags.berserkCountdown = null; // 脱离失控【裁A-43】
  }
}

/** 出局【裁A-06】：终态移除，全员出局 → F3 判负 */
export function eliminate(state: GameState, events: GameEvent[], c: CharacterId): void {
  const ch = state.characters[c];
  if (!ch || !ch.alive) return;
  ch.alive = false;
  ch.ap = 0;
  emitEv(events, { kind: 'character_eliminated', character: c });
  if (state.currentTurn?.character === c) state.currentTurn = null;
  const anyAlive = state.turnOrder.some((id) => state.characters[id]?.alive);
  if (!anyAlive) {
    state.result = { outcome: 'defeat', reason: '所有角色生命值均归零（F3）' };
    state.phase.kind = 'game_over';
    emitEv(events, { kind: 'game_over', result: 'defeat', reason: '所有角色生命值均归零' });
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function serializeReq(req: CharacterDamageRequest): Record<string, unknown> {
  return { target: req.target, damage: req.damage, sourceCrisisUid: req.sourceCrisisUid ?? null, forcedSharePartner: req.forcedSharePartner ?? null };
}

function deserializeReq(data: Record<string, unknown>): CharacterDamageRequest {
  return {
    target: data['target'] as CharacterId,
    damage: data['damage'] as DamageInstance,
    ...(data['sourceCrisisUid'] ? { sourceCrisisUid: data['sourceCrisisUid'] as string } : {}),
    ...(data['forcedSharePartner'] ? { forcedSharePartner: data['forcedSharePartner'] as CharacterId } : {}),
  };
}

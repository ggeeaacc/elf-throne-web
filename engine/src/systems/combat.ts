/**
 * 交战结算（§6.1）与攻击效果链构建（§11）。
 */
import { CHARACTERS } from '../content/characters.js';
import { CRISIS_CARD_BY_ID } from '../content/crisis-cards.js';
import { ACTION_CARD_BY_ID } from '../content/action-cards.js';
import { isAdjacent } from '../content/scenes.js';
import type {
  CharacterId,
  GameEvent,
  GameState,
  SceneId,
} from '../types.js';
import { EngineError } from '../types.js';
import {
  changeErosion,
  dealDamageToCharacter,
  findBuffs,
  consumeBuff,
  gainMaterial,
  gainPurify,
  healCharacter,
  hasActiveBond,
  isBerserk,
} from './damage.js';
import type { ChainNode, DamageInstance } from './damage.js';
import { drawCards, emitEv, suspendDecision } from './common.js';

// ── 攻击声明（cards.ts 构造，combat 执行） ───────────────────────────────────

export interface AttackDeclaration {
  attacker: CharacterId;
  /** 卡面基础伤害（条件伤害已在 cards.ts 算好） */
  base: number;
  /** 来源攻击卡 defId（屠龙者之血/反击判定）；非卡攻击为 null */
  cardDefId: string | null;
  /** 卡面自带修正（按声明顺序，§11） */
  cardMods?: ChainNode[];
  /** 是否远程（迷雾校验在目标合法性阶段完成） */
  remote: boolean;
  /** 声明消耗品（固定次序：净化→信物→小剑） */
  usePurify?: number;
  useCharm?: boolean;
  usePetAttack?: boolean;
  /** 决战中对玫拉 */
  vsBoss?: boolean;
}

/** 构建有序效果链（§11 冻结映射） */
export function buildAttackChain(state: GameState, atk: AttackDeclaration, targetScene: SceneId): DamageInstance {
  const chain: ChainNode[] = [];
  const attacker = state.characters[atk.attacker];
  if (!attacker) throw new EngineError('invalid_command', '攻击者不在场');

  // ① 静态修饰（createdOrder = 实际声明顺序）
  const statics: Array<{ node: ChainNode; order: number }> = [];

  // 屠龙者之血：仅对玫拉生效（平衡调整：对危机卡不再+1）
  if (atk.cardDefId && atk.attacker === 'xiaoyu' && atk.vsBoss) {
    const def = ACTION_CARD_BY_ID.get(atk.cardDefId);
    if (def?.tags.includes('attack')) statics.push({ node: { op: 'ADD', value: 1, source: 'xiaoyu-passive' }, order: -100 });
  }
  // 精灵神射：仅当指定【相邻场景】危机卡时 +1（§1.2；雅-09/装-02 打相邻仍 +1，打非相邻不加）
  if (atk.attacker === 'liya' && atk.remote && atk.cardDefId) {
    if (targetScene !== attacker.scene && isAdjacent(attacker.scene, targetScene)) {
      statics.push({ node: { op: 'ADD', value: 1, source: 'liya-passive' }, order: -99 });
    }
  }
  // 装备被动：装-02 攻击+1
  for (const uid of attacker.equipment) {
    const defId = state.cards[uid]?.defId;
    if (defId === 'equip-02') statics.push({ node: { op: 'ADD', value: 1, source: 'equip-02' }, order: -90 });
  }
  // 羁绊被动：羁-03 同场景 +1
  for (const bond of state.bonds) {
    if (bond.status !== 'active' || !bond.cardUid || !bond.pair.includes(atk.attacker)) continue;
    const defId = state.cards[bond.cardUid]?.defId;
    const other = bond.pair[0] === atk.attacker ? bond.pair[1] : bond.pair[0];
    const otherCh = state.characters[other];
    if (defId === 'bond-03' && otherCh?.alive && otherCh.scene === attacker.scene) {
      statics.push({ node: { op: 'ADD', value: 1, source: 'bond-03' }, order: -80 });
    }
  }
  // 羁-06：巴爷的攻击加成共享给凯尔（巴爷身上的装备攻击加值）【裁A-31】
  if (atk.attacker === 'kaier' && hasActiveBond(state, 'kaier', 'baye', 'bond-06')) {
    const baye = state.characters['baye'];
    if (baye?.alive && baye.scene === attacker.scene) {
      for (const uid of baye.equipment) {
        const defId = state.cards[uid]?.defId;
        if (defId === 'equip-02') statics.push({ node: { op: 'ADD', value: 1, source: 'bond-06-equip-02' }, order: -79 });
      }
    }
  }
  // buff 类攻击加成（雅-07 消耗型、巴-04/凯-09 场景型、凯-05 自身、羁-08 主动、装-03 主动对玫拉）
  for (const b of findBuffs(state, (x) => x.kind === 'attack_add' || x.kind === 'next_attack_add')) {
    const appliesToChar = !b.target || b.target === atk.attacker;
    const appliesToScene = !b.scene || b.scene === attacker.scene || b.scene === targetScene;
    if (!appliesToChar || !appliesToScene) continue;
    if (b.source === 'equip-03-active' && !atk.vsBoss) continue;
    statics.push({ node: { op: 'ADD', value: b.value, source: b.source }, order: b.createdOrder });
    if (b.kind === 'next_attack_add') consumeBuff(state, b.id);
  }

  statics.sort((a, b) => a.order - b.order);
  for (const s of statics) chain.push(s.node);

  // ② 卡面自带修正（§11 声明顺序：卡面在静态之后）
  for (const m of atk.cardMods ?? []) chain.push(m);

  // ③ 声明消耗品（固定次序：净化→信物→小剑）
  if (atk.usePurify && atk.usePurify > 0) {
    if (attacker.purifyTokens < atk.usePurify) throw new EngineError('insufficient_cost', '净化指示物不足');
    attacker.purifyTokens -= atk.usePurify;
    chain.push({ op: 'ADD', value: atk.usePurify, source: 'purify-token' });
  }
  if (atk.useCharm) {
    if (attacker.charms < 1) throw new EngineError('insufficient_cost', '无信物标记');
    attacker.charms -= 1;
    chain.push({ op: 'ADD', value: 2, source: 'charm' });
  }
  if (atk.usePetAttack) {
    if (!attacker.hasPet) throw new EngineError('condition_not_met', '未持有小剑与小盾');
    const key = `petAtk:${atk.attacker}`;
    if (state.roundUsage[key]) throw new EngineError('usage_limit', '小剑与小盾每轮限用一次');
    state.roundUsage[key] = true;
    chain.push({ op: 'ADD', value: 1, source: 'pet' });
  }

  // ④ 目标侧：玫拉 P3 减免（钳 1）
  if (atk.vsBoss && state.boss?.stage === 3) {
    chain.push({ op: 'BOSS_P3', value: 1, source: 'boss-p3' });
  }

  return { base: atk.base, chain, source: atk.cardDefId ?? 'effect', dark: false, fromAttackCard: atk.cardDefId !== null };
}

// ── 对危机卡的伤害（§6.1）────────────────────────────────────────────────────

/** 攻击链折值（危机卡无减免侧） */
export function damageValue(d: DamageInstance): number {
  let v = d.base;
  for (const n of d.chain) {
    if (n.op === 'ADD') v += n.value;
    else if (n.op === 'MULT') v *= n.value;
    else if (n.op === 'BOSS_P3') v = Math.max(1, v - n.value);
    else if (n.op === 'REDUCE') v = Math.max(0, v - n.value);
  }
  return v;
}

/** 场景内危机卡剩余危机度 */
export function crisisRemaining(state: GameState, uid: string): number {
  const inst = state.cards[uid];
  const def = inst ? CRISIS_CARD_BY_ID.get(inst.defId) : undefined;
  if (!def) return 0;
  for (const scene of Object.values(state.scenes)) {
    if (scene.crisisCards.includes(uid)) {
      return def.crisisValue - (scene.crisisDamage[uid] ?? 0);
    }
  }
  return 0;
}

export function crisisSceneOf(state: GameState, uid: string): SceneId | null {
  for (const scene of Object.values(state.scenes)) {
    if (scene.crisisCards.includes(uid)) return scene.id;
  }
  return null;
}

/**
 * 对危机卡造成 n 点伤害（含伤害轨迹/清除/奖励/羁绊钩子）。
 * berserkAoE=true 时为失控伤害：不算参与、无材料、不追加侵蚀【L170】。
 */
export function dealDamageToCrisis(
  state: GameState,
  events: GameEvent[],
  uid: string,
  amount: number,
  by: CharacterId,
  opts: { berserkAoE?: boolean } = {},
): void {
  const sceneId = crisisSceneOf(state, uid);
  if (!sceneId) throw new EngineError('invalid_target', '危机卡不在场上');
  const scene = state.scenes[sceneId];
  const inst = state.cards[uid];
  const def = inst ? CRISIS_CARD_BY_ID.get(inst.defId) : undefined;
  if (!inst || !def) throw new EngineError('invalid_target', '危机卡定义缺失');

  const dealt = Math.max(0, amount);
  const before = scene.crisisDamage[uid] ?? 0;
  scene.crisisDamage[uid] = before + dealt;
  const remaining = def.crisisValue - scene.crisisDamage[uid]!;
  emitEv(events, { kind: 'crisis_damaged', cardUid: uid, amount: dealt, remaining: Math.max(0, remaining), by });

  // 伤害轨迹（参与清除判定【裁A-09】；失控伤害不算参与【L170】）
  if (dealt >= 1 && !opts.berserkAoE) {
    const log = (state.crisisDamageLog[uid] ??= []);
    if (!log.includes(by)) log.push(by);
  }

  if (remaining <= 0) {
    clearCrisis(state, events, uid, { berserkAoE: opts.berserkAoE === true });
  }
}

/** 清除危机卡（§6.1.3）：基础奖励 + 卡面奖励 + 【暗】侵蚀 + 羁绊钩子 */
export function clearCrisis(state: GameState, events: GameEvent[], uid: string, opts: { berserkAoE?: boolean } = {}): void {
  const sceneId = crisisSceneOf(state, uid);
  if (!sceneId) return;
  const scene = state.scenes[sceneId];
  const inst = state.cards[uid];
  const def = inst ? CRISIS_CARD_BY_ID.get(inst.defId) : undefined;
  if (!inst || !def) return;

  const participants = opts.berserkAoE ? [] : [...(state.crisisDamageLog[uid] ?? [])].filter((c) => state.characters[c]?.alive);

  // 移入危机弃牌堆
  scene.crisisCards = scene.crisisCards.filter((u) => u !== uid);
  delete scene.crisisDamage[uid];
  state.decks.crisisDiscard.push(uid);
  delete state.crisisDamageLog[uid];
  emitEv(events, { kind: 'crisis_cleared', cardUid: uid, cardDefId: def.id, scene: sceneId, participants });

  if (opts.berserkAoE) return; // 失控清除：无任何参与奖励【L170】

  // b. 基础奖励：每位参与者 1 材料（羁-05 被动额外 +1【裁A-09 需为参与者】）
  for (const c of participants) {
    gainMaterial(state, events, c, 1);
    if (hasActiveBondWithDef(state, c, 'bond-05')) gainMaterial(state, events, c, 1);
  }
  // d. 【暗】且小鱼 ∈ 参与者 → 小鱼 E+1（T1）
  if (def.dark && participants.includes('xiaoyu')) {
    changeErosion(state, events, 1, 'T1');
  }
  // 危-10 清除标记（决战 +2 判定）
  if (def.id === 'crisis-10') state.flags.avatarCleared = true;
  if (def.id === 'crisis-09') delete state.flags.sacrifice[uid];

  // c. 卡面清除奖励
  applyClearReward(state, events, def.id, sceneId, participants);

  // ── 羁绊钩子 ──
  hookBondOnClear(state, events, uid, sceneId, participants);

  // 羁-08 被动：小鱼×巴爷同场景合力清除 → 各回 1（§9.6）
  if (
    participants.includes('xiaoyu') &&
    participants.includes('baye') &&
    hasActiveBondWithDef(state, 'xiaoyu', 'bond-08') &&
    state.characters['xiaoyu']?.scene === state.characters['baye']?.scene
  ) {
    healCharacter(state, events, 'xiaoyu', 1);
    healCharacter(state, events, 'baye', 1);
  }

  // 羁-10 被动：小鱼×凯尔首次共同清除 → 各获 1 件免费锻造（仅一次【L400】）
  if (participants.includes('xiaoyu') && participants.includes('kaier')) {
    hookDukeApproval(state, events, participants);
  }

  // 装-03 被动：持有者清除危机卡时，对同场景另一张危机卡造成1点伤害
  for (const c of participants) {
    const ch = state.characters[c];
    if (!ch?.alive) continue;
    if (!ch.equipment.some((equid) => state.cards[equid]?.defId === 'equip-03')) continue;
    const otherCrisis = scene.crisisCards[0];
    if (otherCrisis) dealDamageToCrisis(state, events, otherCrisis, 1, c);
  }
}

/** 羁-10 免费锻造（羁绊系统内联实现，避免循环依赖） */
function hookDukeApproval(state: GameState, events: GameEvent[], _participants: CharacterId[]): void {
  if (!hasActiveBondWithDef(state, 'xiaoyu', 'bond-10')) return;
  if (state.flags.oneShotUsed['bond-10-forge']) return;
  state.flags.oneShotUsed['bond-10-forge'] = true;
  const queue = (['xiaoyu', 'kaier'] as CharacterId[]).filter((c) => state.characters[c]?.alive && state.equipmentDisplay.length > 0);
  const [first, ...rest] = queue;
  if (!first) return;
  if (rest.length > 0) state.resumeStack.push({ sys: 'bond', op: 'free_forge_second', data: { characters: rest } });
  suspendDecision(state, events, {
    kind: 'choose_equipment',
    decider: first,
    options: { prompt: '公爵的认可：免费获得 1 件装备（占持有上限）', equipmentUids: [...state.equipmentDisplay], owners: [first] },
    resume: { sys: 'bond', op: 'free_forge', data: { character: first } },
  });
}

function applyClearReward(state: GameState, events: GameEvent[], defId: string, sceneId: SceneId, participants: CharacterId[]): void {
  const sceneChars = state.turnOrder.filter((c) => state.characters[c]?.alive && state.characters[c]?.scene === sceneId);
  const pick = participants[0] ?? sceneChars[0] ?? state.turnOrder.find((c) => state.characters[c]?.alive);
  switch (defId) {
    case 'crisis-02':
    case 'crisis-03': {
      // 此场景一名角色抽 1 + 1 材料（协商 → 映射首位参与者）
      if (pick) {
        drawCards(state, events, pick, 1);
        gainMaterial(state, events, pick, 1);
      }
      break;
    }
    case 'crisis-04':
      if (pick) {
        gainPurify(state, events, pick, 1);
        drawCards(state, events, pick, 1);
      }
      break;
    case 'crisis-05':
      for (const c of participants) gainMaterial(state, events, c, 2);
      break;
    case 'crisis-06': {
      // 立即免费从展示区取 1 张装备（参与者协商归属【裁A-40】）→ 决策
      if (state.equipmentDisplay.length > 0 && participants.length > 0) {
        suspendDecision(state, events, {
          kind: 'choose_equipment',
          decider: participants[0]!,
          options: { prompt: '危-06 清除奖励：选择装备与归属角色', equipmentUids: [...state.equipmentDisplay], owners: participants },
          resume: { sys: 'crisis', op: 'free_equipment', data: {} },
        });
      }
      break;
    }
    case 'crisis-07': {
      if (pick) drawCards(state, events, pick, 1);
      for (const c of sceneChars) healCharacter(state, events, c, 1);
      break;
    }
    case 'crisis-08':
      if (pick) gainPurify(state, events, pick, 1);
      break;
    case 'crisis-09':
      if (pick) gainPurify(state, events, pick, 3);
      break;
    case 'crisis-10':
      for (const c of state.turnOrder) healCharacter(state, events, c, 99);
      break;
  }
}

/** 清除后的羁绊判定（§6.3：偏见路径/同族路径） */
function hookBondOnClear(state: GameState, events: GameEvent[], uid: string, sceneId: SceneId, participants: CharacterId[]): void {
  if (state.phase.kind === 'final_battle') return; // 决战中不可结成羁绊【裁A-10】

  // 路径一：bondLead 卡被其触发对共同击败（两人均造成过伤害且由其中一人清除）
  const lead = state.bondLeads.find((l) => l.crisisUid === uid);
  if (lead) {
    const [a, b] = lead.pair;
    if (participants.includes(a) && participants.includes(b)) {
      state.bondLeads = state.bondLeads.filter((l) => l !== lead);
      startBondFormation(state, events, [a, b]);
      return;
    }
    // 被第三方清除 → 关联失效【裁A-16】
    state.bondLeads = state.bondLeads.filter((l) => l !== lead);
  }

  // 路径二【裁A-03】：小鱼×巴爷 同场景共同清除任意危机卡
  if (
    participants.includes('xiaoyu') &&
    participants.includes('baye') &&
    state.characters['xiaoyu']?.scene === state.characters['baye']?.scene &&
    state.characters['xiaoyu']?.scene === sceneId &&
    !bondExists(state, 'xiaoyu', 'baye')
  ) {
    startBondFormation(state, events, ['xiaoyu', 'baye']);
  }
}

export function bondExists(state: GameState, a: CharacterId, b: CharacterId): boolean {
  return state.bonds.some((x) => x.pair.includes(a) && x.pair.includes(b));
}

function hasActiveBondWithDef(state: GameState, c: CharacterId, defId: string): boolean {
  return state.bonds.some((x) => x.status === 'active' && x.cardUid && state.cards[x.cardUid]?.defId === defId && x.pair.includes(c));
}

/** 发起结成羁绊：双方各 1 金指示物 → 选卡决策（§5.3） */
export function startBondFormation(state: GameState, events: GameEvent[], pair: [CharacterId, CharacterId]): void {
  const [a, b] = pair;
  const ca = state.characters[a];
  const cb = state.characters[b];
  if (ca?.alive) ca.bondTokens += 1;
  if (cb?.alive) cb.bondTokens += 1;

  // 可选卡：该对专属 + 通用（羁-03/04/05，羁-05 仅限人类×精灵【裁A-18】）
  const PAIR_EXCLUSIVE: Record<string, string> = {
    'xiaoyu|liya': 'bond-01',
    'liya|kaier': 'bond-07',
    'xiaoyu|baye': 'bond-08',
    'kaier|baye': 'bond-06',
    'liya|baye': 'bond-09',
    'xiaoyu|kaier': 'bond-10',
  };
  const order: CharacterId[] = ['xiaoyu', 'liya', 'kaier', 'baye'];
  const key = [a, b].sort((x, y) => order.indexOf(x) - order.indexOf(y)).join('|');
  const exclusive = PAIR_EXCLUSIVE[key];
  const races = [CHARACTERS[a].race, CHARACTERS[b].race];
  const mixed = races.includes('human') && races.includes('elf');
  const candidates = state.decks.bond.filter((uid) => {
    const defId = state.cards[uid]?.defId;
    if (defId === exclusive) return true;
    if (defId === 'bond-03' || defId === 'bond-04') return true;
    if (defId === 'bond-05') return mixed;
    return false;
  });
  if (candidates.length === 0) return; // 牌库无可选（极端），只留指示物

  suspendDecision(state, events, {
    kind: 'choose_bond_card',
    decider: a,
    options: { prompt: `${a}×${b} 结成羁绊：选择羁绊卡`, pair, candidateUids: candidates },
    resume: { sys: 'bond', op: 'form', data: { pair } },
  });
}

// ── 玫拉（§7.3）──────────────────────────────────────────────────────────────

/** 对玫拉造成伤害（护盾吸收/阶段转换即时判定） */
export function dealDamageToBoss(state: GameState, events: GameEvent[], amount: number, by: CharacterId, fromAttackCard: boolean): void {
  const boss = state.boss;
  if (!boss || state.result) return;
  const race = CHARACTERS[by].race;

  if (boss.shield > 0) {
    boss.shield = Math.max(0, boss.shield - amount);
    emitEv(events, { kind: 'boss_damaged', amount, shielded: true, by });
    if (boss.shield === 0 && boss.stage === 1) {
      boss.stage = 2;
      emitEv(events, { kind: 'boss_stage_changed', stage: 2 });
      for (const c of state.turnOrder) healCharacter(state, events, c, 2); // §7.3 P1 转换
    }
  } else {
    boss.hp = Math.max(0, boss.hp - amount);
    boss.damageThisRound[by] = (boss.damageThisRound[by] ?? 0) + amount;
    emitEv(events, { kind: 'boss_damaged', amount, shielded: false, by });
    if (boss.hp <= 0) {
      state.result = { outcome: 'victory', reason: '玫拉生命值归零' };
      state.phase.kind = 'game_over';
      emitEv(events, { kind: 'game_over', result: 'victory', reason: '击败玫拉' });
      return;
    }
    // P2→P3 即时转换【裁A-34】（当次攻击已按转换前结算完毕，不重算）
    if (boss.stage === 2 && boss.hp <= Math.floor(boss.maxHp / 2)) {
      boss.stage = 3;
      emitEv(events, { kind: 'boss_stage_changed', stage: 3 });
      for (const c of state.turnOrder) healCharacter(state, events, c, 1);
    }
  }

  // P2 反击：每张攻击卡结算后按攻击者种族触发一次【裁A-35】
  if (fromAttackCard && boss.stage === 2 && !state.result) {
    emitEv(events, { kind: 'counter_attack', target: by, race });
    if (race === 'human') {
      // 1 点黑暗伤害；宝玉侵蚀 +1（P2 阶段有效【裁A-35】）→ 实为 2；小鱼受此伤害 E+1
      dealDamageToCharacter(state, events, {
        target: by,
        damage: { base: 2, chain: [], source: 'boss_counter', dark: true, fromAttackCard: false },
      });
    } else {
      // 精灵：1 点伤害 + 弃 1 张手牌
      dealDamageToCharacter(state, events, {
        target: by,
        damage: { base: 1, chain: [], source: 'boss_counter', dark: false, fromAttackCard: false },
      });
      if (!state.pendingDecision && (state.characters[by]?.hand.length ?? 0) > 0) {
        suspendDecision(state, events, {
          kind: 'choose_cards',
          decider: by,
          options: { prompt: '灵魂撕裂：弃置 1 张手牌', cardUids: [...state.characters[by]!.hand], min: 1, max: 1 },
          resume: { sys: 'boss', op: 'counter_discard', data: { character: by } },
        });
      }
    }
  }
}

// ── 迷雾校验（危-07【裁A-20】）────────────────────────────────────────────────

export function isSceneFogged(state: GameState, scene: SceneId): boolean {
  return state.scenes[scene].crisisCards.some((uid) => state.cards[uid]?.defId === 'crisis-07');
}

/** 远程合法性：双向失效（迷雾场景内不可发起远程；外部不可以迷雾场景内卡为远程目标） */
export function assertRemoteLegal(state: GameState, attackerScene: SceneId, targetScene: SceneId, remote: boolean): void {
  if (!remote) return;
  if (attackerScene === targetScene) return; // 本场景卡不算远程
  if (isSceneFogged(state, attackerScene)) throw new EngineError('invalid_target', '黑暗迷雾：所在场景远程攻击失效');
  if (isSceneFogged(state, targetScene)) throw new EngineError('invalid_target', '黑暗迷雾：不可以迷雾场景内危机卡为远程目标');
}

// ── 失控 AoE（§6.4）──────────────────────────────────────────────────────────

export function berserkAoE(state: GameState, events: GameEvent[]): void {
  const x = state.characters['xiaoyu'];
  if (!x?.alive || !isBerserk(state)) return;
  const sceneId = x.scene;
  for (const uid of [...state.scenes[sceneId].crisisCards]) {
    dealDamageToCrisis(state, events, uid, 1, 'xiaoyu', { berserkAoE: true });
  }
  for (const c of state.turnOrder) {
    const ch = state.characters[c];
    if (ch?.alive && ch.scene === sceneId) {
      dealDamageToCharacter(state, events, {
        target: c,
        damage: { base: 1, chain: [], source: 'berserk', dark: false, fromAttackCard: false },
      });
    }
  }
}

// ── 决策挂起：统一使用 common.suspendDecision ──────────────────────────────────
export { suspendDecision } from './common.js';

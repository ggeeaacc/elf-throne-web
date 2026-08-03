/**
 * 羁绊系统（§5.3 / §6.3 状态机 + 附录C 羁绊卡）。
 */
import type { CharacterId, GameEvent, GameState, PlayCardTargets, SceneId } from '../types.js';
import { EngineError } from '../types.js';
import { emitEv, suspendDecision } from './common.js';
import { changeErosion, dealDamageToCharacter, healCharacter, hasActiveBond, addBuff, setBerserkStartHook } from './damage.js';
import { drawCards } from './common.js';
import { dealDamageToCrisis, crisisSceneOf } from './combat.js';
import { takeEquipment } from './forge.js';
import { CHARACTERS } from '../content/characters.js';
import { CRISIS_CARD_BY_ID } from '../content/crisis-cards.js';

/** pair 规范化（按回合顺序排序） */
export function pairKey(a: CharacterId, b: CharacterId): [CharacterId, CharacterId] {
  const order: CharacterId[] = ['xiaoyu', 'liya', 'kaier', 'baye'];
  return order.indexOf(a) <= order.indexOf(b) ? [a, b] : [b, a];
}

// 注册失控进入钩子：小鱼失控瞬间 → 小鱼×莉雅获得羁-02 并激活【裁A-04】
setBerserkStartHook((state, events) => applyBerserkBondReplace(state, events));

export function getBond(state: GameState, a: CharacterId, b: CharacterId) {
  const [x, y] = pairKey(a, b);
  return state.bonds.find((p) => p.pair[0] === x && p.pair[1] === y);
}

// ── 结成（resume 'bond:form'，由 combat.startBondFormation 挂起）────────────────

export function resumeBondForm(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const pair = data['pair'] as [CharacterId, CharacterId];
  const cardUid = (choice as Record<string, unknown>)?.['cardUid'] as string | undefined;
  if (!cardUid || !state.decks.bond.includes(cardUid)) throw new EngineError('invalid_choice', '羁绊卡选择非法');
  state.decks.bond = state.decks.bond.filter((u) => u !== cardUid);
  const [a, b] = pairKey(pair[0], pair[1]);
  state.bonds.push({ pair: [a, b], status: 'active', cardUid, replacedByBerserk: false, activeUsedRound: null });
  emitEv(events, { kind: 'bond_formed', pair: [a, b], cardUid, cardDefId: state.cards[cardUid]?.defId ?? '' });
}

/** 小鱼×莉雅 传书激活（羁-01，锁发【裁A-18】）；失控替换（羁-02【裁A-04】） */
export function maybeActivateXiaoyuLiya(state: GameState, events: GameEvent[]): void {
  const bond = getBond(state, 'xiaoyu', 'liya');
  if (!bond || bond.status !== 'inactive' || bond.replacedByBerserk) return;
  if (state.flags.xiaoyuLiyaLetters < 2) return;
  const uid = takeBondCardFromDeck(state, 'bond-01');
  if (!uid) return;
  bond.status = 'active';
  bond.cardUid = uid;
  emitEv(events, { kind: 'bond_formed', pair: [...bond.pair], cardUid: uid, cardDefId: 'bond-01' });
}

/** 小鱼失控瞬间：小鱼×莉雅 立即获得羁-02 并激活（终态，不回退）【裁A-04】 */
export function applyBerserkBondReplace(state: GameState, events: GameEvent[]): void {
  const bond = getBond(state, 'xiaoyu', 'liya');
  const uid = takeBondCardFromDeck(state, 'bond-02');
  if (!uid) return;
  if (bond) {
    // 已持羁-01 → 替换（旧卡移出游戏）
    if (bond.cardUid) emitEv(events, { kind: 'bond_replaced', cardUid: bond.cardUid, cardDefId: state.cards[bond.cardUid]?.defId ?? '' });
    bond.status = 'active';
    bond.cardUid = uid;
    bond.replacedByBerserk = true;
    bond.activeUsedRound = null; // 自发卡当轮起可用（计数独立【裁A-04】）
  } else {
    state.bonds.push({ pair: pairKey('xiaoyu', 'liya'), status: 'active', cardUid: uid, replacedByBerserk: true, activeUsedRound: null });
  }
  emitEv(events, { kind: 'bond_formed', pair: pairKey('xiaoyu', 'liya'), cardUid: uid, cardDefId: 'bond-02' });
}

function takeBondCardFromDeck(state: GameState, defId: string): string | null {
  const uid = state.decks.bond.find((u) => state.cards[u]?.defId === defId);
  if (!uid) return null;
  state.decks.bond = state.decks.bond.filter((u) => u !== uid);
  return uid;
}

// ── 羁绊卡主动（附录C：0 AP、每轮限 1 次；发动者=任一方（羁-02 莉雅可单方【裁A-24】））──

export function useBondActive(state: GameState, events: GameEvent[], character: CharacterId, bondUid: string, params: PlayCardTargets | undefined): void {
  const bond = state.bonds.find((b) => b.cardUid === bondUid && b.status === 'active');
  if (!bond) throw new EngineError('invalid_command', '羁绊未激活或不存在');
  if (!bond.pair.includes(character)) throw new EngineError('invalid_command', '非该羁绊成员');
  // 出局后涉及双方的羁绊卡效果不可用【裁A-06】
  const partnerId = bond.pair[0] === character ? bond.pair[1] : bond.pair[0];
  if (!state.characters[partnerId]?.alive) throw new EngineError('condition_not_met', '羁绊伙伴已出局，涉及双方的羁绊卡不可用【裁A-06】');
  const ch = state.characters[character]!;
  // 失控小鱼不可发动任何羁绊卡主动（羁-02 仅莉雅可单方发动【裁A-24】）
  if (character === 'xiaoyu' && ch.erosion >= 4) {
    throw new EngineError('condition_not_met', '失控状态无法主动行动【裁A-24】');
  }
  if (bond.activeUsedRound === state.phase.round) throw new EngineError('usage_limit', '该羁绊卡主动每轮限用一次');
  const defId = state.cards[bondUid]?.defId;
  const partner = bond.pair[0] === character ? bond.pair[1] : bond.pair[0];
  const partnerCh = state.characters[partner];

  switch (defId) {
    case 'bond-01': {
      // 主动：双方立即各恢复2点生命值，并从各自牌库各抽一张牌
      healCharacter(state, events, character, 2);
      if (partnerCh?.alive) healCharacter(state, events, partner, 2);
      drawCards(state, events, character, 1);
      if (partnerCh?.alive) drawCards(state, events, partner, 1);
      break;
    }
    case 'bond-02': {
      // 移除小鱼至多 1 个侵蚀（莉雅可单方发动【裁A-24】）
      changeErosion(state, events, -1, 'R7');
      break;
    }
    case 'bond-03': {
      // 双方立即各对当前场景一张危机卡造成 2 点伤害
      for (const who of [character, partner]) {
        const whoCh = state.characters[who];
        if (!whoCh?.alive) continue;
        const sc = state.scenes[whoCh.scene];
        if (!sc || sc.crisisCards.length === 0) continue;
        // 选剩余危机度最高的一张
        let bestUid: string | null = null;
        let bestRemain = -1;
        for (const uid of sc.crisisCards) {
          const def = state.cards[uid]?.defId;
          if (!def) continue;
          const remain = (CRISIS_CARD_BY_ID.get(def)?.crisisValue ?? 0) - (sc.crisisDamage[uid] ?? 0);
          if (remain > bestRemain) { bestRemain = remain; bestUid = uid; }
        }
        if (bestUid) dealDamageToCrisis(state, events, bestUid, 2, who);
      }
      break;
    }
    case 'bond-04': {
      // 交换双方位置
      if (!partnerCh?.alive) throw new EngineError('invalid_target', '伙伴不在场');
      const a = ch.scene;
      ch.scene = partnerCh.scene;
      partnerCh.scene = a;
      emitEv(events, { kind: 'moved', character, from: a, to: ch.scene, via: 'bond-04' });
      emitEv(events, { kind: 'moved', character: partner, from: ch.scene, to: a, via: 'bond-04' });
      break;
    }
    case 'bond-05': {
      // 在任意场景放 1 个净化守护
      const scene = params?.scene as SceneId | undefined;
      if (!scene || !(scene in state.scenes)) throw new EngineError('invalid_target', '须选择场景');
      state.sceneWards[scene] = (state.sceneWards[scene] ?? 0) + 1;
      emitEv(events, { kind: 'flag_set', flag: 'ward', value: { scene } });
      break;
    }
    case 'bond-06': {
      // 双方立即各对 1 个危机卡造成 3 点伤害
      const uids = params?.crisisUids ?? [];
      for (const [i, who] of [character, partner].entries()) {
        const uid = uids[i];
        if (uid && crisisSceneOf(state, uid)) dealDamageToCrisis(state, events, uid, 3, who);
      }
      break;
    }
    case 'bond-07':
      drawCards(state, events, character, 2);
      if (partnerCh?.alive) drawCards(state, events, partner, 2);
      break;
    case 'bond-08':
      addBuff(state, { source: 'bond-08-active', kind: 'attack_add', value: 2, target: character, scope: 'round' });
      addBuff(state, { source: 'bond-08-active', kind: 'attack_add', value: 2, target: partner, scope: 'round' });
      break;
    case 'bond-09': {
      // 巴爷替莉雅承受下一次伤害且 -2（guard buff，由巴爷声明给莉雅）
      const guardian = character === 'baye' ? character : partner;
      const protectedOne = character === 'baye' ? partner : character;
      addBuff(state, { source: 'bond-09-active', kind: 'guard', value: 2, target: protectedOne, partner: guardian, scope: 'consumed' });
      break;
    }
    case 'bond-10':
      addBuff(state, { source: 'bond-10-active', kind: 'share', value: 0, target: character, partner, scope: 'round' });
      addBuff(state, { source: 'bond-10-active', kind: 'share', value: 0, target: partner, partner: character, scope: 'round' });
      break;
    default:
      throw new EngineError('invalid_command', '未知羁绊卡');
  }
  bond.activeUsedRound = state.phase.round;
}

// ── 羁-10 免费锻造被动（首次共同清除后触发，仅一次【L400】）────────────────────

export function hookDukeApproval(state: GameState, events: GameEvent[], participants: CharacterId[]): void {
  if (!hasActiveBond(state, 'xiaoyu', 'kaier', 'bond-10')) return;
  if (state.flags.oneShotUsed['bond-10-forge']) return;
  if (!participants.includes('xiaoyu') || !participants.includes('kaier')) return;
  state.flags.oneShotUsed['bond-10-forge'] = true;
  for (const c of ['xiaoyu', 'kaier'] as const) {
    const ch = state.characters[c];
    if (!ch?.alive || state.equipmentDisplay.length === 0) continue;
    // 免费锻造：从展示区选 1 张（协商映射各自控制者）
    suspendDecision(state, events, {
      kind: 'choose_equipment',
      decider: c,
      options: { prompt: '公爵的认可：免费获得 1 件装备', equipmentUids: [...state.equipmentDisplay], owners: [c] },
      resume: { sys: 'bond', op: 'free_forge', data: { character: c } },
    });
    break; // 一次一件地串行（续算栈处理第二件）
  }
  if (state.pendingDecision) {
    state.resumeStack.push({ sys: 'bond', op: 'free_forge_second', data: {} });
  }
}

/** resume 'bond:free_forge' / 'bond:free_forge_second' */
export function resumeFreeForge(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const character = data['character'] as CharacterId;
  const uid = (choice as Record<string, unknown>)?.['equipmentUid'] as string | undefined;
  if (!uid || !state.equipmentDisplay.includes(uid)) throw new EngineError('invalid_choice', '装备选择非法');
  takeEquipment(state, events, character, uid);
}

export function resumeFreeForgeSecond(state: GameState, events: GameEvent[], data: Record<string, unknown>): void {
  const rest = (data['characters'] as CharacterId[] | undefined) ?? [];
  const [first, ...tail] = rest;
  if (!first) return;
  const ch = state.characters[first];
  if (!ch?.alive || state.equipmentDisplay.length === 0) return;
  if (tail.length > 0) state.resumeStack.push({ sys: 'bond', op: 'free_forge_second', data: { characters: tail } });
  suspendDecision(state, events, {
    kind: 'choose_equipment',
    decider: first,
    options: { prompt: '公爵的认可：免费获得 1 件装备（占持有上限）', equipmentUids: [...state.equipmentDisplay], owners: [first] },
    resume: { sys: 'bond', op: 'free_forge', data: { character: first } },
  });
}

// ── 羁-07 复制续算（actions.maybeBond07Copy 挂起）────────────────────────────────

export function resumeCopyOption(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const opt = (choice as Record<string, unknown>)?.['option'];
  if (opt !== 'copy') return;
  const matchable = data['matchable'] as string[];
  if (matchable.length === 1) {
    applyCopy(state, events, data, matchable[0]!);
    return;
  }
  suspendDecision(state, events, {
    kind: 'choose_cards',
    decider: data['sibling'] as CharacterId,
    options: { prompt: '选择弃置的同类型卡', cardUids: matchable, min: 1, max: 1 },
    resume: { sys: 'bond', op: 'copy_discard', data },
  });
}

export function resumeCopyDiscard(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const uid = ((choice as Record<string, unknown>)?.['cardUids'] as string[] | undefined)?.[0];
  if (!uid || !(data['matchable'] as string[]).includes(uid)) throw new EngineError('invalid_choice', '复制弃牌非法');
  applyCopy(state, events, data, uid);
}

function applyCopy(state: GameState, events: GameEvent[], data: Record<string, unknown>, discardUid: string): void {
  const sibling = data['sibling'] as CharacterId;
  const sib = state.characters[sibling]!;
  if (!sib.hand.includes(discardUid)) throw new EngineError('invalid_choice', '弃置卡不在手牌');
  sib.hand.splice(sib.hand.indexOf(discardUid), 1);
  sib.discard.push(discardUid);
  // 以复制者身份半价结算原卡效果（数值减半向下取整【裁A-32】）
  const { resolveCard } = requireCards();
  resolveCard({
    state,
    events,
    character: sibling,
    cardUid: data['cardUid'] as string,
    targets: (data['targets'] as PlayCardTargets) ?? {},
    half: true,
    inBattle: data['inBattle'] === true,
    N: (n: number) => Math.floor(n / 2),
  });
}

// 延迟引用避免循环依赖（cards → bonds → cards）
import { resolveCard as _resolveCard } from './cards.js';
function requireCards() {
  return { resolveCard: _resolveCard };
}

export { CHARACTERS, dealDamageToCharacter, healCharacter };

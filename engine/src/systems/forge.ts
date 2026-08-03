/**
 * 锻造系统（§6.6 + 附录B 装备卡）。
 */
import { ACTION_CARD_BY_ID } from '../content/action-cards.js';
import type { CharacterId, GameEvent, GameState } from '../types.js';
import { EngineError } from '../types.js';
import { emitEv, suspendDecision } from './common.js';
import { healCharacter } from './damage.js';

/** 锻造费用计算（折扣：人类王城 / 巴-07 标记；下限 0【裁A-27】） */
export function forgeCost(state: GameState, character: CharacterId, equipmentUid: string): { ap: number; materials: number } {
  const ch = state.characters[character]!;
  let ap = 2;
  let materials = 2;
  if (ch.scene === 'human_city') {
    ap -= 1;
    materials -= 1;
  }
  if (state.flags.oneShotUsed[`ba07:${equipmentUid}`]) {
    // 巴-07：任何人下一次锻造该装备均可享【裁A-38】
    ap -= 1;
    materials -= 1;
  }
  return { ap: Math.max(0, ap), materials: Math.max(0, materials) };
}

/** B4 锻造（2 AP + 2 份材；材料卡与指示物任意混合【裁A-26】） */
export function forge(state: GameState, events: GameEvent[], character: CharacterId, equipmentUid: string, materialCardUids: string[], useTokens: number): void {
  if (state.phase.kind !== 'action') throw new EngineError('wrong_phase', '决战中锻造不可用【L198】');
  const ch = state.characters[character]!;
  if (!state.equipmentDisplay.includes(equipmentUid)) throw new EngineError('invalid_target', '该装备不在展示区');

  // 危-06：黑暗战船所在场景无法锻造
  const ship = state.scenes[ch.scene].crisisCards.some((uid) => state.cards[uid]?.defId === 'crisis-06');
  if (ship) throw new EngineError('condition_not_met', '黑暗战船：此场景无法锻造');

  const cost = forgeCost(state, character, equipmentUid);
  if (ch.ap < cost.ap) throw new EngineError('insufficient_ap', `行动点不足（需 ${cost.ap}）`);

  // 材料校验：材料卡须在手且带【材】；指示物混合支付总数须达标
  for (const uid of materialCardUids) {
    if (!ch.hand.includes(uid)) throw new EngineError('card_not_in_hand', '材料卡不在手牌中');
    const def = ACTION_CARD_BY_ID.get(state.cards[uid]?.defId ?? '');
    if (!def?.material) throw new EngineError('invalid_command', '所选卡不带【材】标记');
  }
  if (materialCardUids.length + useTokens !== cost.materials) {
    throw new EngineError('insufficient_cost', `材料份数不符（需 ${cost.materials} 份）`);
  }
  if (useTokens > ch.materialTokens) throw new EngineError('insufficient_cost', '材料指示物不足');

  // 支付
  ch.ap -= cost.ap;
  for (const uid of materialCardUids) {
    ch.hand.splice(ch.hand.indexOf(uid), 1);
    ch.discard.push(uid);
  }
  ch.materialTokens -= useTokens;
  delete state.flags.oneShotUsed[`ba07:${equipmentUid}`]; // 巴-07 折扣为一次性

  takeEquipment(state, events, character, equipmentUid);
}

/** 从展示区取装备（锻造/危-06 免费/羁-10 免费共用）；满 2 须先弃 */
export function takeEquipment(state: GameState, events: GameEvent[], character: CharacterId, equipmentUid: string): void {
  const ch = state.characters[character]!;
  const idx = state.equipmentDisplay.indexOf(equipmentUid);
  if (idx < 0) throw new EngineError('invalid_target', '该装备不在展示区');
  if (ch.equipment.length >= 2) {
    // 满则先弃 1（弃置的放回展示区底部【L112】）→ 决策
    suspendDecision(state, events, {
      kind: 'choose_equipment',
      decider: character,
      options: { prompt: '装备已满（2 件）：选择弃置 1 件已有装备', dropOnly: true, equipmentUids: [...ch.equipment], newEquipmentUid: equipmentUid },
      resume: { sys: 'card', op: 'equip_swap', data: { character, equipmentUid, displayIndex: idx } },
    });
    return;
  }
  state.equipmentDisplay.splice(idx, 1);
  grantEquipment(state, events, character, equipmentUid);
}

/** resume 'card:equip_swap' */
export function resumeEquipSwap(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const character = data['character'] as CharacterId;
  const equipmentUid = data['equipmentUid'] as string;
  const ch = state.characters[character]!;
  const drop = (choice as Record<string, unknown>)?.['equipmentUid'] as string | undefined;
  if (!drop || !ch.equipment.includes(drop)) throw new EngineError('invalid_choice', '弃置选择非法');
  dropEquipment(state, events, character, drop);
  const idx = state.equipmentDisplay.indexOf(equipmentUid);
  if (idx < 0) throw new EngineError('invalid_choice', '目标装备已不在展示区');
  state.equipmentDisplay.splice(idx, 1);
  grantEquipment(state, events, character, equipmentUid);
}

function grantEquipment(state: GameState, events: GameEvent[], character: CharacterId, equipmentUid: string): void {
  const ch = state.characters[character]!;
  ch.equipment.push(equipmentUid);
  emitEv(events, { kind: 'forged', character, equipmentUid });
  // 装-04 守护之戒：上限 +2 并立即恢复 2
  if (state.cards[equipmentUid]?.defId === 'equip-04') {
    ch.maxHp += 2;
    healCharacter(state, events, character, 2);
  }
}

/** 弃置装备（放回展示区底部；装-04 卸下钳制【裁A-33】） */
export function dropEquipment(state: GameState, events: GameEvent[], character: CharacterId, equipmentUid: string): void {
  const ch = state.characters[character]!;
  const idx = ch.equipment.indexOf(equipmentUid);
  if (idx < 0) return;
  ch.equipment.splice(idx, 1);
  state.equipmentDisplay.push(equipmentUid); // 底部
  emitEv(events, { kind: 'equipment_dropped', character, equipmentUid });
  if (state.cards[equipmentUid]?.defId === 'equip-04') {
    ch.maxHp = Math.max(1, ch.maxHp - 2);
    ch.hp = Math.min(ch.hp, ch.maxHp);
  }
}

// ── 装备主动（附录B：被动永久；主动每轮限 1 次）────────────────────────────────

export function useEquipmentActive(state: GameState, events: GameEvent[], character: CharacterId, equipmentUid: string, params: { target?: CharacterId } | undefined): void {
  const ch = state.characters[character]!;
  if (!ch.equipment.includes(equipmentUid)) throw new EngineError('invalid_command', '未持有该装备');
  const defId = state.cards[equipmentUid]?.defId;
  const key = `equipActive:${equipmentUid}`;
  if (state.roundUsage[key]) throw new EngineError('usage_limit', '该装备主动每轮限用一次');
  const costs: Record<string, number> = { 'equip-01': 1, 'equip-02': 0, 'equip-03': 1, 'equip-04': 1, 'equip-05': 1 };
  const cost = costs[defId ?? ''] ?? 1;
  if (ch.ap < cost) throw new EngineError('insufficient_ap', `行动点不足（需 ${cost}）`);

  switch (defId) {
    case 'equip-01':
      state.orderCounter += 1;
      state.buffs.push({ id: `buff-${state.orderCounter}`, source: 'equip-01-active', kind: 'damage_reduce', value: 1, target: character, scope: 'round', createdOrder: state.orderCounter });
      break;
    case 'equip-02':
      // 本次攻击视为远程：标记本轮内下一次攻击 remote（以 buff 形式，攻击时消费）
      state.orderCounter += 1;
      state.buffs.push({ id: `buff-${state.orderCounter}`, source: 'equip-02-active', kind: 'next_attack_add', value: 0, target: character, scope: 'consumed', createdOrder: state.orderCounter });
      break;
    case 'equip-03':
      state.orderCounter += 1;
      state.buffs.push({ id: `buff-${state.orderCounter}`, source: 'equip-03-active', kind: 'attack_add', value: 2, target: character, scope: 'round', createdOrder: state.orderCounter });
      break;
    case 'equip-04': {
      const target = params?.target;
      if (!target) throw new EngineError('invalid_target', '须选择同场景一名角色');
      const t = state.characters[target];
      if (!t?.alive || t.scene !== ch.scene) throw new EngineError('invalid_target', '目标须为同场景角色');
      healCharacter(state, events, target, 1);
      break;
    }
    case 'equip-05': {
      const to = params?.target as import('../types.js').SceneId | undefined;
      if (!to || !(to in state.scenes)) throw new EngineError('invalid_target', '须选择目标场景');
      const from = ch.scene;
      ch.scene = to;
      emitEv(events, { kind: 'moved', character, from, to, via: 'skate-active' });
      break;
    }
    default:
      throw new EngineError('invalid_command', '未知装备');
  }
  ch.ap -= cost;
  state.roundUsage[key] = true;
}

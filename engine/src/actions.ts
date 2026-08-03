/**
 * applyCommand v2：唯一状态变更入口（ADR-003 纯函数内核）。
 * 全指令面：移动/搜索/打出卡牌/锻造/传书/场景行动/羁绊主动/装备主动/
 *           材料转让/决战行动（治疗/援护/蓄能/共鸣）/结束回合/决策回答。
 */
import { isAdjacent } from './content/scenes.js';
import { ACTION_CARD_BY_ID } from './content/action-cards.js';
import { MODE_TABLE } from './content/modes.js';
import { beginGame, endTurn, resumeTurnAfterElimination } from './phases.js';
import { resolveDecision } from './systems/decisions.js';
import { drawCards } from './systems/common.js';
import { sendLetter } from './systems/letters.js';
import { forge, useEquipmentActive } from './systems/forge.js';
import { useBondActive } from './systems/bonds.js';
import { battleHeal, battleGuard, purifyCharge, gemAttune } from './systems/boss.js';
import { resolveCard } from './systems/cards.js';
import { isBerserk, healCharacter, gainPurify } from './systems/damage.js';
import { suspendDecision } from './systems/common.js';
import type {
  ApplyResult,
  CharacterId,
  Command,
  GameEvent,
  GameState,
  PlayCardTargets,
  SceneId,
} from './types.js';
import { EngineError } from './types.js';

export function applyCommand(state: GameState, cmd: Command): ApplyResult {
  if (state.result) throw new EngineError('game_over', '对局已结束');
  if (state.pendingDecision && cmd.type !== 'resolve_decision') {
    throw new EngineError('decision_pending', '存在待决策事项，需先 resolve_decision');
  }
  const draft = structuredClone(state);
  const events: GameEvent[] = [];

  switch (cmd.type) {
    case 'move':
      doMove(draft, events, cmd.character, cmd.to, cmd.via ?? 'walk', cmd.carry);
      break;
    case 'search':
      requireAliveTurn(draft, cmd.character, true);
      spendAp(draft, cmd.character, 1);
      drawCards(draft, events, cmd.character, 2);
      break;
    case 'play_card':
      doPlayCard(draft, events, cmd);
      break;
    case 'forge':
      requireAliveTurn(draft, cmd.character, true);
      forge(draft, events, cmd.character, cmd.equipmentUid, cmd.materialCardUids, cmd.useTokens);
      break;
    case 'send_letter':
      requireAliveTurn(draft, cmd.character, true);
      spendAp(draft, cmd.character, 1);
      sendLetter(draft, events, cmd.character, cmd.cardUid);
      break;
    case 'scene_action':
      doSceneAction(draft, events, cmd.character, cmd.action, cmd.params);
      break;
    case 'bond_active':
      requireAliveTurn(draft, cmd.character, false);
      useBondActive(draft, events, cmd.character, cmd.bondUid, cmd.params);
      break;
    case 'equipment_active':
      requireAliveTurn(draft, cmd.character, true); // 失控不可装备主动【裁A-24】
      if (draft.phase.kind === 'final_battle' && draft.cards[cmd.equipmentUid]?.defId === 'equip-05') {
        throw new EngineError('wrong_phase', '决战中移动不可用【L198】');
      }
      useEquipmentActive(draft, events, cmd.character, cmd.equipmentUid, cmd.params as { target?: CharacterId } | undefined);
      break;
    case 'transfer_material':
      doTransferMaterial(draft, events, cmd.character, cmd.to, cmd.count);
      break;
    case 'heal':
      requireBattleTurn(draft, cmd.character);
      battleHeal(draft, events, cmd.character, cmd.discardUid, cmd.target);
      break;
    case 'guard':
      requireBattleTurn(draft, cmd.character);
      battleGuard(draft, events, cmd.character, cmd.target);
      break;
    case 'purify_charge':
      requireBattleTurn(draft, cmd.character);
      purifyCharge(draft, events, cmd.character);
      break;
    case 'gem_attune':
      requireBattleTurn(draft, cmd.character);
      gemAttune(draft, events, cmd.character);
      break;
    case 'end_turn':
      endTurn(draft, events, cmd.character);
      break;
    case 'resolve_decision':
      resolveDecision(draft, events, cmd.decisionId, cmd.choice);
      break;
    default: {
      const never: never = cmd;
      throw new EngineError('invalid_command', `未知指令 ${JSON.stringify(never)}`);
    }
  }
  // 当前回合角色回合中出局 → 回合自动顺延【裁A-06】
  resumeTurnAfterElimination(draft, events);
  // 事件统一落日志（systems 只发事件；state.log 在此单点追加，回放断言用）
  draft.log.push(...events);
  return { state: draft, events };
}

// ── 通用校验 ──────────────────────────────────────────────────────────────────

/** 须为本人存活回合；noBerserk=true 时失控拒动（§6.4 失控无法主动行动） */
function requireAliveTurn(state: GameState, character: CharacterId, noBerserk: boolean): void {
  const inBattle = state.phase.kind === 'final_battle';
  if (state.phase.kind !== 'action' && !inBattle) throw new EngineError('wrong_phase', '当前不在行动相位');
  if (state.currentTurn?.character !== character) {
    throw new EngineError('not_your_turn', `当前不是 ${character} 的回合`);
  }
  if (!state.characters[character]?.alive) throw new EngineError('invalid_command', '角色已出局');
  if (noBerserk && character === 'xiaoyu' && isBerserk(state)) {
    throw new EngineError('condition_not_met', '失控状态无法执行主动行动【L170】');
  }
}

function requireBattleTurn(state: GameState, character: CharacterId): void {
  if (state.phase.kind !== 'final_battle') throw new EngineError('wrong_phase', '该行动仅决战可用');
  requireAliveTurn(state, character, true);
}

function spendAp(state: GameState, character: CharacterId, cost: number): void {
  const ch = state.characters[character];
  if (!ch) throw new EngineError('invalid_command', `角色 ${character} 不在场`);
  if (ch.ap < cost) throw new EngineError('insufficient_ap', `行动点不足（需 ${cost}，余 ${ch.ap}）`);
  ch.ap -= cost;
}

// ── B1 移动（§5.2-B1 + 装-05/飞空艇 §6.7）──────────────────────────────────────

function doMove(state: GameState, events: GameEvent[], character: CharacterId, to: SceneId, via: 'walk' | 'airship' | 'skate', carry?: CharacterId): void {
  if (state.phase.kind !== 'action') throw new EngineError('wrong_phase', '决战中移动不可用【L198】');
  requireAliveTurn(state, character, true);
  const ch = state.characters[character]!;
  if (ch.scene === to) throw new EngineError('invalid_target', '目标场景与当前相同');

  switch (via) {
    case 'airship': {
      if (character !== 'baye' || !ch.airship) throw new EngineError('invalid_command', '仅巴爷可使用飞空艇');
      if (ch.airship.cooldownRounds > 0) throw new EngineError('usage_limit', '飞空艇冷却中（每两轮一次【裁A-13】）');
      const from = ch.scene;
      ch.scene = to;
      ch.airship.cooldownRounds = 2; // 使用后的下一轮不可用（本轮结束 --1 → 下轮=1 不可用，再 --1 → 可用）
      events.push({ kind: 'moved', character, from, to, via: 'airship' });
      // 携带出发场景一名友方（≤1 人，可选）
      if (carry) {
        const c = state.characters[carry];
        if (!c?.alive || c.scene !== from || carry === character) {
          throw new EngineError('invalid_target', '携带者须为出发场景友方角色');
        }
        c.scene = to;
        events.push({ kind: 'moved', character: carry, from, to, via: 'airship-carry' });
        // 羁-09 被动：携带莉雅 → 莉雅到达后免费远程攻击 1 次（2 点）
        if (carry === 'liya' && state.bonds.some((b) => b.status === 'active' && b.cardUid && state.cards[b.cardUid]?.defId === 'bond-09' && b.pair.includes('liya') && b.pair.includes('baye'))) {
          const targets = state.scenes[to].crisisCards;
          if (targets.length > 0) {
            suspendDecision(state, events, {
              kind: 'choose_crisis',
              decider: 'liya',
              options: { prompt: '游侠之风：免费远程攻击（2 点）选择目标', cardUids: targets, optional: true },
              resume: { sys: 'card', op: 'bond09_shot', data: { by: 'liya' } },
            });
          }
        }
      }
      return;
    }
    case 'skate':
      // 装-05 主动经 equipment_active；此分支保留给卡牌效果移动
      throw new EngineError('invalid_command', '非法移动方式');
    case 'walk': {
      const hasSkate = ch.equipment.some((u) => state.cards[u]?.defId === 'equip-05');
      const adjacent = isAdjacent(ch.scene, to);
      // 装-05 被动：每次移动可多跨 1 场景（4 场景环内即任意场景）
      if (!adjacent && !hasSkate) throw new EngineError('not_adjacent', `${ch.scene} 与 ${to} 不相邻`);
      // 装-05 小鱼每回合第一次移动免费
      const freeFirst = character === 'xiaoyu' && hasSkate && !ch.freeMoveUsedThisTurn;
      if (!freeFirst) spendAp(state, character, 1);
      if (character === 'xiaoyu' && hasSkate) ch.freeMoveUsedThisTurn = true;
      const from = ch.scene;
      ch.scene = to;
      events.push({ kind: 'moved', character, from, to, via: 'walk' });
      return;
    }
  }
}

// ── B2 打出卡牌 ────────────────────────────────────────────────────────────────

function doPlayCard(state: GameState, events: GameEvent[], cmd: Extract<Command, { type: 'play_card' }>): void {
  requireAliveTurn(state, cmd.character, true);
  const ch = state.characters[cmd.character]!;
  const idx = ch.hand.indexOf(cmd.cardUid);
  if (idx < 0) throw new EngineError('card_not_in_hand', '该卡不在手牌中');
  const inst = state.cards[cmd.cardUid];
  const def = inst ? ACTION_CARD_BY_ID.get(inst.defId) : undefined;
  if (!def) throw new EngineError('invalid_command', '非行动卡或定义缺失');
  if (def.character !== cmd.character) throw new EngineError('invalid_command', '非本人专属卡');
  spendAp(state, cmd.character, def.costAP);
  ch.hand.splice(idx, 1);

  const inBattle = state.phase.kind === 'final_battle';
  const disposition = resolveCard({
    state,
    events,
    character: cmd.character,
    cardUid: cmd.cardUid,
    targets: cmd.targets ?? {},
    ...(cmd.usePurify ? { usePurify: cmd.usePurify } : {}),
    ...(cmd.useCharm ? { useCharm: cmd.useCharm } : {}),
    ...(cmd.usePetAttack ? { usePetAttack: cmd.usePetAttack } : {}),
    ...(cmd.usePetDefend ? { usePetDefend: cmd.usePetDefend } : {}),
    half: false,
    inBattle,
    N: (n: number) => n,
  });

  if (disposition === 'return_to_hand') ch.hand.push(cmd.cardUid);
  else if (disposition === 'remove_from_game') { /* 巴-10 移出游戏 */ }
  else ch.discard.push(cmd.cardUid);

  // 羁-07 被动：同场景兄妹可弃同类型卡复制（数值减半【裁A-32】）
  maybeBond07Copy(state, events, cmd.character, def.id, cmd.cardUid, cmd.targets ?? {}, inBattle);
}

/** 羁-07 复制钩子（凯尔×莉雅同场景时触发选择） */
function maybeBond07Copy(state: GameState, events: GameEvent[], playedBy: CharacterId, defId: string, cardUid: string, targets: PlayCardTargets, inBattle: boolean): void {
  if (playedBy !== 'kaier' && playedBy !== 'liya') return;
  const sibling: CharacterId = playedBy === 'kaier' ? 'liya' : 'kaier';
  const bond = state.bonds.find((b) => b.status === 'active' && b.cardUid && state.cards[b.cardUid]?.defId === 'bond-07' && b.pair.includes('kaier') && b.pair.includes('liya'));
  if (!bond) return;
  const sib = state.characters[sibling];
  const played = state.characters[playedBy];
  if (!sib?.alive || !played?.alive || sib.scene !== played.scene) return;
  const def = ACTION_CARD_BY_ID.get(defId);
  if (!def) return;
  const matchable = sib.hand.filter((u) => {
    const d = ACTION_CARD_BY_ID.get(state.cards[u]?.defId ?? '');
    return d && d.tags.some((t) => def.tags.includes(t));
  });
  if (matchable.length === 0) return;
  suspendDecision(state, events, {
    kind: 'choose_option',
    decider: sibling,
    options: { prompt: `兄妹同心：是否弃 1 张同类型卡复制「${def.name}」（数值减半）？`, options: [{ id: 'copy', label: '复制' }, { id: 'pass', label: '不复制' }] },
    resume: { sys: 'bond', op: 'copy_option', data: { sibling, playedBy, defId, cardUid, targets, inBattle, matchable } },
  });
}

// ── 场景专属行动（§5.2）────────────────────────────────────────────────────────

function doSceneAction(state: GameState, events: GameEvent[], character: CharacterId, action: string, params: { target?: CharacterId } | undefined): void {
  if (state.phase.kind !== 'action') throw new EngineError('wrong_phase', '场景行动仅常规局可用');
  requireAliveTurn(state, character, true);
  const ch = state.characters[character]!;

  switch (action) {
    case 'tree_heal': {
      if (ch.scene !== 'elf_kingdom') throw new EngineError('wrong_phase', '须在精灵王国');
      const key = `treeHeal:${character}`;
      if (state.roundUsage[key]) throw new EngineError('usage_limit', '生命树的治愈每轮限一次');
      const target = params?.target ?? character;
      const t = state.characters[target];
      if (!t?.alive || t.scene !== 'elf_kingdom') throw new EngineError('invalid_target', '目标须为精灵王国角色');
      spendAp(state, character, 1);
      healCharacter(state, events, target, 1);
      gainPurify(state, events, character, 1);
      state.roundUsage[key] = true;
      return;
    }
    case 'scout': {
      if (ch.scene !== 'ancient_battlefield') throw new EngineError('wrong_phase', '须在古战场废墟');
      spendAp(state, character, 1);
      const top2 = state.decks.crisis.slice(0, 2);
      if (top2.length < 2) return;
      suspendDecision(state, events, {
        kind: 'reorder_cards',
        decider: character,
        options: { prompt: '侦查敌情：选择 1 张置底（另 1 张放回顶）', cardUids: top2, mode: 'scout' },
        resume: { sys: 'card', op: 'scout', data: { top2 } },
      });
      return;
    }
    case 'rescue_queen': {
      if (ch.scene !== 'dark_valley') throw new EngineError('wrong_phase', '须在黑暗山谷');
      if (state.flags.oneShotUsed['rescue_queen']) throw new EngineError('usage_limit', '营救女王一局限一次');
      if (ch.purifyTokens < 2) throw new EngineError('insufficient_cost', '须支付 2 个净化指示物');
      spendAp(state, character, 3);
      ch.purifyTokens -= 2;
      state.flags.oneShotUsed['rescue_queen'] = true;
      state.flags.queenRescued = true;
      events.push({ kind: 'flag_set', flag: 'queenRescued', value: true });
      return;
    }
    case 'find_pet': {
      if (ch.scene !== 'dark_valley') throw new EngineError('wrong_phase', '须在黑暗山谷');
      if (state.flags.oneShotUsed['find_pet']) throw new EngineError('usage_limit', '寻找宠物一局限一次');
      spendAp(state, character, 1);
      state.flags.oneShotUsed['find_pet'] = true;
      state.flags.petFound = true;
      ch.hasPet = true;
      events.push({ kind: 'flag_set', flag: 'petFound', value: { character } });
      return;
    }
    default:
      throw new EngineError('invalid_command', `未知场景行动 ${action}`);
  }
}

// ── 材料转让（§6.1：同场景自由转让，不耗 AP，任意回合）──────────────────────────

function doTransferMaterial(state: GameState, events: GameEvent[], from: CharacterId, to: CharacterId, count: number): void {
  if (count < 1) throw new EngineError('invalid_command', '数量非法');
  const a = state.characters[from];
  const b = state.characters[to];
  if (!a?.alive || !b?.alive) throw new EngineError('invalid_target', '双方须存活');
  if (a.scene !== b.scene) throw new EngineError('condition_not_met', '须同场景');
  if (a.materialTokens < count) throw new EngineError('insufficient_cost', '材料指示物不足');
  a.materialTokens -= count;
  b.materialTokens = Math.min(4, b.materialTokens + count); // 溢出丢失【裁A-28】
  events.push({ kind: 'flag_set', flag: 'material_transferred', value: { from, to, count } });
}

export { beginGame, drawCards };

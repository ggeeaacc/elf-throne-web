/**
 * 测试辅助：自动以默认选择解决全部挂起决策（确定性）。
 * 仅测试使用，不从包入口导出。
 */
import { applyCommand } from './actions.js';
import type { GameState, PendingDecision } from './types.js';

export function defaultChoice(d: PendingDecision, s?: GameState): unknown {
  const o = (d.options ?? {}) as Record<string, unknown>;
  switch (d.kind) {
    case 'place_crisis': {
      // 桌面理性选择：放到当前危机最少的场景；并列时按轮次轮转（避免人为堆叠沦陷）
      if (s) {
        const scenes = Object.values(s.scenes);
        const minCount = Math.min(...scenes.map((x) => x.crisisCards.length));
        const tied = scenes.filter((x) => x.crisisCards.length === minCount);
        const pick = tied[s.phase.round % tied.length]!;
        return { scene: pick.id };
      }
      return { scene: 'human_city' };
    }
    case 'choose_character':
      return { character: (o['candidates'] as string[])[0] };
    case 'choose_crisis':
      return { cardUid: (o['cardUids'] as string[] | undefined)?.[0] };
    case 'choose_cards': {
      const min = (o['min'] as number | undefined) ?? 1;
      return { cardUids: (o['cardUids'] as string[]).slice(0, min) };
    }
    case 'choose_bond_card':
      return { cardUid: (o['candidateUids'] as string[])[0] };
    case 'choose_option':
      return { option: (o['options'] as Array<{ id: string }>)[0]!.id };
    case 'order_effects':
      return { order: (o['items'] as Array<{ uid: string }>).map((i) => i.uid) };
    case 'reorder_cards':
      return o['mode'] === 'scout' ? { bottom: (o['cardUids'] as string[])[0] } : { order: o['cardUids'] };
    case 'choose_share_high':
      return { highTaker: (o['candidates'] as string[])[0] };
    case 'choose_redirect':
      return { buffId: (o['candidates'] as Array<{ buffId: string }>)[0]!.buffId };
    case 'choose_equipment':
      return { equipmentUid: (o['equipmentUids'] as string[])[0], owner: (o['owners'] as string[] | undefined)?.[0] };
    default:
      return {};
  }
}

/** 连续解决挂起决策直至稳定（至多 200 步防死循环） */
export function settle(s: GameState): GameState {
  let guard = 0;
  while (s.pendingDecision && guard++ < 200) {
    const d = s.pendingDecision;
    s = applyCommand(s, { type: 'resolve_decision', decisionId: d.id, choice: defaultChoice(d, s) }).state;
  }
  return s;
}

/** 结束当前回合并 settle */
export function passTurn(s: GameState): GameState {
  const cur = s.currentTurn?.character;
  if (!cur) throw new Error('无当前回合');
  return settle(applyCommand(s, { type: 'end_turn', character: cur }).state);
}

/** 测试摆盘：全体复活满血（长流程空转防减员，绕过 F3 直达决战） */
export function fullHeal(s: GameState): GameState {
  const draft = structuredClone(s);
  for (const ch of Object.values(draft.characters)) {
    ch.alive = true;
    ch.hp = ch.maxHp;
    ch.erosion = 0;
  }
  draft.flags.berserkCountdown = null;
  return draft;
}

/** 测试摆盘：每场景危机修剪至 ≤2（模拟桌面清危机，长流程防 F2 沦陷） */
export function trimCrises(s: GameState): GameState {
  const draft = structuredClone(s);
  for (const scene of Object.values(draft.scenes)) {
    while (scene.crisisCards.length > 2) {
      const uid = scene.crisisCards.shift()!;
      delete scene.crisisDamage[uid];
      draft.decks.crisisDiscard.push(uid);
      delete draft.crisisDamageLog[uid];
    }
  }
  return draft;
}

/** 打出当前回合角色手牌中指定 defId 的卡（取第一张）并 settle */
export function playCardById(s: GameState, character: GameState['turnOrder'][number], defId: string, targets?: import('./types.js').PlayCardTargets): GameState {
  const ch = s.characters[character]!;
  const uid = ch.hand.find((u) => s.cards[u]?.defId === defId);
  if (!uid) throw new Error(`${character} 手牌无 ${defId}（手牌：${ch.hand.map((u) => s.cards[u]?.defId).join(',')}）`);
  return settle(applyCommand(s, { type: 'play_card', character, cardUid: uid, ...(targets ? { targets } : {}) }).state);
}

/** 将指定 defId 的卡换入角色手牌（测试摆盘：从牌库/弃牌堆找来置换首张手牌） */
export function giveCard(s: GameState, character: GameState['turnOrder'][number], defId: string): GameState {
  const draft = structuredClone(s);
  const ch = draft.characters[character]!;
  const zones = [ch.deck, ch.discard];
  for (const zone of zones) {
    const i = zone.findIndex((u) => draft.cards[u]?.defId === defId);
    if (i >= 0) {
      const [uid] = zone.splice(i, 1);
      ch.hand.push(uid!);
      return draft;
    }
  }
  throw new Error(`${character} 牌库/弃牌堆无 ${defId}`);
}

/** 在指定场景放置一张危机卡（测试摆盘：取牌库顶第一张匹配 defId 的或直接放 uid） */
export function putCrisis(s: GameState, defId: string, scene: GameState['turnOrder'][number] extends never ? never : import('./types.js').SceneId): GameState {
  const draft = structuredClone(s);
  const i = draft.decks.crisis.findIndex((u) => draft.cards[u]?.defId === defId);
  if (i < 0) throw new Error(`危机牌库无 ${defId}`);
  const [uid] = draft.decks.crisis.splice(i, 1);
  draft.scenes[scene].crisisCards.push(uid!);
  return draft;
}

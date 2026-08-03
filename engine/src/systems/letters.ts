/**
 * 传书系统（§6.5 飞箭传书 + 附录D 传书卡）。
 */
import type { CharacterId, GameEvent, GameState } from '../types.js';
import { EngineError } from '../types.js';
import { drawLetterTop, emitEv, shuffleInPlace, suspendDecision } from './common.js';
import { changeErosion, dealDamageToCharacter, gainMaterial, healCharacter, isBerserk } from './damage.js';
import { drawCards } from './common.js';
import { LETTER_CARD_BY_ID } from '../content/bond-cards.js';
import { maybeActivateXiaoyuLiya } from './bonds.js';

// ── 发送（§6.5，B5：1 AP）─────────────────────────────────────────────────────

export function sendLetter(state: GameState, events: GameEvent[], from: CharacterId, cardUid: string): void {
  if (state.phase.kind !== 'action') throw new EngineError('wrong_phase', '决战中传书不可用【L198】');
  if (from !== 'xiaoyu' && from !== 'liya') throw new EngineError('invalid_command', '仅小鱼和莉雅可使用传书【L114】');
  const sender = state.characters[from];
  const to: CharacterId = from === 'xiaoyu' ? 'liya' : 'xiaoyu';
  const receiver = state.characters[to];
  if (!sender?.alive || !receiver?.alive) throw new EngineError('invalid_target', '双方须均存活【裁A-06】');
  if (sender.scene === receiver.scene) throw new EngineError('condition_not_met', '双方须处于不同场景【L114】');
  if (sender.lettersSentThisRound >= 1) throw new EngineError('usage_limit', '每轮最多发出一封书信【L118】');
  if (receiver.lettersReceivedThisRound >= 1) throw new EngineError('usage_limit', '对方每轮最多接收一封书信【L118】');
  if (receiver.pendingLetter) throw new EngineError('usage_limit', '对方已有未翻开书信（暂存槽=1【裁A-21】）');
  const idx = sender.hand.indexOf(cardUid);
  if (idx < 0) throw new EngineError('card_not_in_hand', '该卡不在手牌中');

  sender.hand.splice(idx, 1);
  receiver.pendingLetter = { cardUid, from };
  sender.lettersSentThisRound += 1;
  receiver.lettersReceivedThisRound += 1;
  emitEv(events, { kind: 'letter_sent', from, to });
}

// ── 接收（TURN_START，获 AP 之前【L182】）──────────────────────────────────────

/**
 * 回合开始的收信结算。失控/无法行动 → 暂存不翻开【L185】。
 * 可能挂起决策（满手弃牌/小鱼清侵蚀选择/传书卡效果），经续算栈串联。
 */
export function receiveLetterIfAny(state: GameState, events: GameEvent[], character: CharacterId): void {
  const ch = state.characters[character];
  if (!ch?.alive) return;

  // 传-04 反向传递先行（不占限额、不触发书信效果【裁A-22】）
  if (ch.pendingReverseLetter) {
    const rev = ch.pendingReverseLetter;
    ch.pendingReverseLetter = null;
    if (ch.hand.length >= 5) {
      suspendDecision(state, events, {
        kind: 'choose_cards',
        decider: character,
        options: { prompt: '手牌已满：弃 1 张后接收传回卡', cardUids: [...ch.hand], min: 1, max: 1 },
        resume: { sys: 'letter', op: 'reverse_receive', data: { character, cardUid: rev.cardUid } },
      });
      return;
    }
    ch.hand.push(rev.cardUid);
    emitEv(events, { kind: 'card_drawn', character, cardUid: rev.cardUid, cardDefId: state.cards[rev.cardUid]?.defId ?? '' });
  }

  const letter = ch.pendingLetter;
  if (!letter) return;
  // 失控/无法行动 → 不翻开，继续暂存【L185】
  if (character === 'xiaoyu' && isBerserk(state)) return;
  ch.pendingLetter = null;

  // 2. 加入手牌；满 5 须先弃 1【L117】
  if (ch.hand.length >= 5) {
    suspendDecision(state, events, {
      kind: 'choose_cards',
      decider: character,
      options: { prompt: '手牌已满：弃 1 张后接收书信', cardUids: [...ch.hand], min: 1, max: 1 },
      resume: { sys: 'letter', op: 'receive', data: { character, cardUid: letter.cardUid, from: letter.from } },
    });
    return;
  }
  finishReceive(state, events, character, letter.cardUid, letter.from);
}

/** resume 'letter:receive'（满手弃牌后） */
export function resumeReceive(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const character = data['character'] as CharacterId;
  const discard = ((choice as Record<string, unknown>)?.['cardUids'] as string[] | undefined)?.[0];
  const ch = state.characters[character]!;
  if (!discard || !ch.hand.includes(discard)) throw new EngineError('invalid_choice', '弃牌选择非法');
  ch.hand.splice(ch.hand.indexOf(discard), 1);
  ch.discard.push(discard);
  finishReceive(state, events, character, data['cardUid'] as string, data['from'] as CharacterId);
}

/** resume 'letter:reverse_receive'（传-04 满手弃牌后） */
export function resumeReverseReceive(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const character = data['character'] as CharacterId;
  const discard = ((choice as Record<string, unknown>)?.['cardUids'] as string[] | undefined)?.[0];
  const ch = state.characters[character]!;
  if (!discard || !ch.hand.includes(discard)) throw new EngineError('invalid_choice', '弃牌选择非法');
  ch.hand.splice(ch.hand.indexOf(discard), 1);
  ch.discard.push(discard);
  const cardUid = data['cardUid'] as string;
  ch.hand.push(cardUid);
  emitEv(events, { kind: 'card_drawn', character, cardUid, cardDefId: state.cards[cardUid]?.defId ?? '' });
}

function finishReceive(state: GameState, events: GameEvent[], character: CharacterId, cardUid: string, from: CharacterId): void {
  const ch = state.characters[character]!;
  ch.hand.push(cardUid);
  emitEv(events, { kind: 'letter_received', character, cardUid });

  // 3. 恢复效果：默认回 1；小鱼可选改为 -1 侵蚀【L116】
  if (character === 'xiaoyu' && ch.erosion > 0) {
    suspendDecision(state, events, {
      kind: 'choose_option',
      decider: character,
      options: {
        prompt: '接收书信：恢复 1 点生命，或改为移除 1 个侵蚀指示物？',
        options: [
          { id: 'heal', label: '恢复 1 点生命' },
          { id: 'erosion', label: '移除 1 个侵蚀' },
        ],
      },
      resume: { sys: 'letter', op: 'heal_choice', data: { character, from } },
    });
    return;
  }
  healCharacter(state, events, character, 1);
  afterHeal(state, events, character, from);
}

/** resume 'letter:heal_choice' */
export function resumeHealChoice(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const character = data['character'] as CharacterId;
  const opt = (choice as Record<string, unknown>)?.['option'];
  if (opt === 'erosion') changeErosion(state, events, -1, 'R5');
  else healCharacter(state, events, character, 1);
  afterHeal(state, events, character, data['from'] as CharacterId);
}

function afterHeal(state: GameState, events: GameEvent[], character: CharacterId, from: CharacterId): void {
  // 4. 抽传书牌库顶 1 张结算即时效果后弃置【L184, L404】
  const uid = drawLetterTop(state);
  if (uid) {
    emitEv(events, { kind: 'letter_card_drawn', character, cardUid: uid, cardDefId: state.cards[uid]?.defId ?? '' });
    applyLetterCard(state, events, uid, character, from);
    state.decks.letterDiscard.push(uid); // 结算（含挂起中的效果）后即入弃牌堆
  }
  // 5. 成功传书计数（翻开时计入【裁A-23】，方向不限【裁A-44】）；累计 2 次激活羁-01
  state.flags.xiaoyuLiyaLetters += 1;
  emitEv(events, { kind: 'flag_set', flag: 'xiaoyuLiyaLetters', value: state.flags.xiaoyuLiyaLetters });
  maybeActivateXiaoyuLiya(state, events);
}

// ── 传书卡效果（附录D）────────────────────────────────────────────────────────

function applyLetterCard(state: GameState, events: GameEvent[], uid: string, receiver: CharacterId, sender: CharacterId): void {
  const defId = state.cards[uid]?.defId;
  switch (defId) {
    case 'letter-01': {
      healCharacter(state, events, receiver, 2);
      drawCards(state, events, receiver, 1);
      if (receiver === 'xiaoyu') changeErosion(state, events, -1, 'R6');
      if (receiver === 'liya') drawCards(state, events, receiver, 1);
      break;
    }
    case 'letter-02': {
      gainMaterial(state, events, receiver, 1);
      const ch = state.characters[receiver]!;
      ch.charms += 1;
      emitEv(events, { kind: 'flag_set', flag: 'charm', value: { character: receiver, charms: ch.charms } });
      break;
    }
    case 'letter-03': {
      drawCards(state, events, receiver, 1);
      drawCards(state, events, sender, 1);
      // 双方本轮下一次伤害 -1（一次性 first_damage_reduce buff）
      for (const c of [receiver, sender]) {
        state.orderCounter += 1;
        state.buffs.push({
          id: `buff-${state.orderCounter}`,
          source: 'letter-03',
          kind: 'first_damage_reduce',
          value: 1,
          target: c,
          scope: 'consumed',
          createdOrder: state.orderCounter,
        });
      }
      break;
    }
    case 'letter-04': {
      // 接收方将 1 张手牌传给发送方，下一次发送方回合开始时生效【裁A-22】
      const ch = state.characters[receiver]!;
      if (ch.hand.length === 0) break;
      suspendDecision(state, events, {
        kind: 'choose_cards',
        decider: receiver,
        options: { prompt: '誓约之言：选择 1 张手牌传给发送方', cardUids: [...ch.hand], min: 1, max: 1 },
        resume: { sys: 'letter', op: 'vow_send', data: { receiver, sender } },
      });
      break;
    }
    case 'letter-05': {
      healCharacter(state, events, receiver, 1);
      healCharacter(state, events, sender, 1);
      // 各自可弃 1 张并抽 1 张替换（接收方先）
      suspendDecision(state, events, {
        kind: 'choose_option',
        decider: receiver,
        options: { prompt: '见字如面：是否弃 1 张手牌并抽 1 张替换？', options: [{ id: 'yes', label: '替换' }, { id: 'no', label: '不替换' }] },
        resume: { sys: 'letter', op: 'face_swap', data: { who: receiver, other: sender } },
      });
      break;
    }
  }
}

/** resume 'letter:vow_send'（传-04 选卡） */
export function resumeVowSend(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const receiver = data['receiver'] as CharacterId;
  const sender = data['sender'] as CharacterId;
  const cardUid = ((choice as Record<string, unknown>)?.['cardUids'] as string[] | undefined)?.[0];
  const ch = state.characters[receiver]!;
  if (!cardUid || !ch.hand.includes(cardUid)) throw new EngineError('invalid_choice', '选择非法');
  ch.hand.splice(ch.hand.indexOf(cardUid), 1);
  state.characters[sender]!.pendingReverseLetter = { cardUid, from: receiver };
  emitEv(events, { kind: 'flag_set', flag: 'reverse_letter', value: { from: receiver, to: sender } });
}

/** resume 'letter:face_swap'（传-05 双方依次决定；final 标记防止循环互问） */
export function resumeFaceSwap(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const who = data['who'] as CharacterId;
  const other = data['other'] as CharacterId;
  const final = data['final'] === true;
  const opt = (choice as Record<string, unknown>)?.['option'];
  const ch = state.characters[who]!;
  if (opt === 'yes' && ch.hand.length > 0) {
    suspendDecision(state, events, {
      kind: 'choose_cards',
      decider: who,
      options: { prompt: '选择弃置 1 张手牌并抽 1 张替换', cardUids: [...ch.hand], min: 1, max: 1 },
      resume: { sys: 'letter', op: 'face_swap_discard', data: { who, other, final } },
    });
    return;
  }
  if (!final) maybeAskOther(state, events, who, other);
}

/** resume 'letter:face_swap_discard' */
export function resumeFaceSwapDiscard(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const who = data['who'] as CharacterId;
  const other = data['other'] as CharacterId;
  const final = data['final'] === true;
  const cardUid = ((choice as Record<string, unknown>)?.['cardUids'] as string[] | undefined)?.[0];
  const ch = state.characters[who]!;
  if (!cardUid || !ch.hand.includes(cardUid)) throw new EngineError('invalid_choice', '选择非法');
  ch.hand.splice(ch.hand.indexOf(cardUid), 1);
  ch.discard.push(cardUid);
  drawCards(state, events, who, 1);
  if (!final) maybeAskOther(state, events, who, other);
}

function maybeAskOther(state: GameState, events: GameEvent[], who: CharacterId, other: CharacterId): void {
  if (!state.characters[other]?.alive) return;
  suspendDecision(state, events, {
    kind: 'choose_option',
    decider: other,
    options: { prompt: '见字如面：是否弃 1 张手牌并抽 1 张替换？', options: [{ id: 'yes', label: '替换' }, { id: 'no', label: '不替换' }] },
    resume: { sys: 'letter', op: 'face_swap', data: { who: other, other: who, final: true } },
  });
}

export { shuffleInPlace };

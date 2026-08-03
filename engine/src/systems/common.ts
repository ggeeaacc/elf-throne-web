/**
 * systems 共享原语：事件发射 / 决策挂起 / 确定性洗牌抽牌。
 */
import { createRng } from '../rng.js';
import type { CharacterId, GameEvent, GameState } from '../types.js';
import { EngineError } from '../types.js';

export function emitEv(events: GameEvent[], ev: GameEvent): void {
  events.push(ev);
}

/** 挂起中断式决策（ADR-003）；id 由全局序号保证唯一 */
export function suspendDecision(
  state: GameState,
  events: GameEvent[],
  d: { kind: import('../types.js').DecisionKind; decider: CharacterId | 'all'; options: unknown; resume: import('../types.js').ResumeRef },
): void {
  state.orderCounter += 1;
  const decision = { id: `dec-${state.orderCounter}`, kind: d.kind, decider: d.decider, options: d.options, resume: d.resume };
  state.pendingDecision = decision;
  emitEv(events, { kind: 'decision_required', decision });
}

/** 确定性洗牌（游标随状态推进） */
export function shuffleInPlace<T>(state: GameState, arr: T[]): T[] {
  const rng = createRng(state.rng.seed, state.rng.cursor);
  rng.shuffle(arr);
  state.rng.cursor = rng.cursor();
  return arr;
}

/** 抽牌原语：个人牌库耗尽时洗回弃牌堆（§5.2-B3） */
export function drawCards(state: GameState, events: GameEvent[], character: CharacterId, n: number): void {
  const ch = state.characters[character];
  if (!ch) throw new EngineError('invalid_command', `角色 ${character} 不在场`);
  for (let i = 0; i < n; i++) {
    if (ch.deck.length === 0) {
      if (ch.discard.length === 0) return;
      ch.deck = ch.discard.splice(0);
      shuffleInPlace(state, ch.deck);
      emitEv(events, { kind: 'deck_reshuffled', character });
    }
    const uid = ch.deck.shift();
    if (!uid) return;
    ch.hand.push(uid);
    const inst = state.cards[uid];
    emitEv(events, { kind: 'card_drawn', character, cardUid: uid, cardDefId: inst?.defId ?? '' });
  }
}

/** 从危机牌库顶抽 1 张（耗尽则弃牌堆洗混重建【L95】） */
export function drawCrisisTop(state: GameState, events: GameEvent[]): string | null {
  if (state.decks.crisis.length === 0) {
    if (state.decks.crisisDiscard.length === 0) return null;
    state.decks.crisis = state.decks.crisisDiscard.splice(0);
    shuffleInPlace(state, state.decks.crisis);
    emitEv(events, { kind: 'crisis_deck_reshuffled' });
  }
  return state.decks.crisis.shift() ?? null;
}

/**
 * 抽 n 张到临时区（不入手牌，供"抽后选"效果如巴-02）；
 * 牌库耗尽同样洗弃牌堆重建（与 drawCards 同口径【L109】）。
 */
export function drawToTemp(state: GameState, events: GameEvent[], character: CharacterId, n: number): string[] {
  const ch = state.characters[character];
  if (!ch) throw new EngineError('invalid_command', `角色 ${character} 不在场`);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (ch.deck.length === 0) {
      if (ch.discard.length === 0) break;
      ch.deck = ch.discard.splice(0);
      shuffleInPlace(state, ch.deck);
      emitEv(events, { kind: 'deck_reshuffled', character });
    }
    const uid = ch.deck.shift();
    if (!uid) break;
    out.push(uid);
  }
  return out;
}

/** 传书牌库抽 1 张（耗尽洗回【L404】） */
export function drawLetterTop(state: GameState): string | null {
  if (state.decks.letter.length === 0) {
    if (state.decks.letterDiscard.length === 0) return null;
    state.decks.letter = state.decks.letterDiscard.splice(0);
    shuffleInPlace(state, state.decks.letter);
  }
  return state.decks.letter.shift() ?? null;
}

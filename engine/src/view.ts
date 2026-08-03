/**
 * projectView：隐藏信息投影 v2（ADR-002）。发给客户端的一切状态必须经此（control-manifest §8）。
 *
 * 隐藏规则：
 *  - 他人手牌 → 仅数量；个人牌库 → 仅数量；弃牌堆 → 公开；
 *  - 公共牌库（危机/羁绊/传书）→ 仅数量；通牒卡 → 全员不可见；
 *  - 待收书信 → 仅发送方与接收方可见牌面；
 *  - pendingDecision.options → 仅决策人座位可见全量（含私密牌信息），其他座位仅见 kind/decider；
 *  - resumeStack / roundUsage / crisisDamageLog / orderCounter → 内部机制，不下发。
 * 新增 GameState 字段默认隐藏、显式公开（本函数须随 schema 同步更新并钉测试）。
 */
import type { Buff, CharacterId, GameState, PairBond, PendingDecision } from './types.js';

export interface CharacterView {
  id: CharacterId;
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
  pendingLetter: { cardUid: string | null; from: CharacterId } | null;
  hasIncomingReverseLetter: boolean;
  nextTurnApBonus: number;
  ap: number;
  alive: boolean;
  airship?: { cooldownRounds: number };
}

export interface GameView {
  schemaVersion: 1;
  seat: number;
  controlledCharacters: CharacterId[];
  phase: GameState['phase'];
  turnOrder: CharacterId[];
  currentTurn: GameState['currentTurn'];
  characters: Record<string, CharacterView>;
  scenes: GameState['scenes'];
  cards: GameState['cards'];
  decks: {
    crisisCount: number;
    crisisDiscard: string[];
    bondCount: number;
    letterCount: number;
  };
  equipmentDisplay: string[];
  flags: GameState['flags'];
  boss: GameState['boss'];
  bonds: PairBond[];
  buffs: Buff[];
  sceneWards: Record<string, number>;
  pendingDecision: PendingDecision | null;
  result: GameState['result'];
}

export function projectView(state: GameState, seat: number): GameView {
  const controlled = state.config.seatAssignments[seat] ?? [];
  const visibleUids = new Set<string>();
  const characters: Record<string, CharacterView> = {};
  for (const [cid, ch] of Object.entries(state.characters)) {
    const isControlled = controlled.includes(cid as CharacterId);
    const letter = ch.pendingLetter;
    const letterVisible = letter !== null && (isControlled || controlled.includes(letter.from));
    if (isControlled) for (const uid of ch.hand) visibleUids.add(uid);
    for (const uid of ch.discard) visibleUids.add(uid);
    for (const uid of ch.equipment) visibleUids.add(uid);
    if (letter && letterVisible) visibleUids.add(letter.cardUid);
    const view: CharacterView = {
      id: ch.id,
      scene: ch.scene,
      hp: ch.hp,
      maxHp: ch.maxHp,
      erosion: ch.erosion,
      hand: isControlled ? [...ch.hand] : [],
      handCount: ch.hand.length,
      deckCount: ch.deck.length,
      discard: [...ch.discard],
      equipment: [...ch.equipment],
      materialTokens: ch.materialTokens,
      purifyTokens: ch.purifyTokens,
      bondTokens: ch.bondTokens,
      charms: ch.charms,
      hasPet: ch.hasPet,
      pendingLetter: letter ? { cardUid: letterVisible ? letter.cardUid : null, from: letter.from } : null,
      hasIncomingReverseLetter: ch.pendingReverseLetter !== null,
      nextTurnApBonus: ch.nextTurnApBonus,
      ap: ch.ap,
      alive: ch.alive,
    };
    if (ch.airship) view.airship = { ...ch.airship };
    characters[cid] = view;
  }
  for (const scene of Object.values(state.scenes)) for (const uid of scene.crisisCards) visibleUids.add(uid);
  for (const uid of state.decks.crisisDiscard) visibleUids.add(uid);
  for (const uid of state.equipmentDisplay) visibleUids.add(uid);
  for (const b of state.bonds) if (b.cardUid) visibleUids.add(b.cardUid);
  const cards: GameState['cards'] = {};
  for (const uid of visibleUids) {
    const inst = state.cards[uid];
    if (inst) cards[uid] = inst;
  }

  // 决策选项仅决策人可见全量；其他人仅见 kind/decider/id（options 可能含私密牌信息）
  let pendingDecision: PendingDecision | null = null;
  if (state.pendingDecision) {
    const d = state.pendingDecision;
    const mine = d.decider === 'all' || controlled.includes(d.decider as CharacterId);
    pendingDecision = mine ? structuredClone(d) : { id: d.id, kind: d.kind, decider: d.decider, options: null, resume: { sys: d.resume.sys, op: d.resume.op, data: null } };
  }

  return {
    schemaVersion: 1,
    seat,
    controlledCharacters: [...controlled],
    phase: { ...state.phase },
    turnOrder: [...state.turnOrder],
    currentTurn: state.currentTurn ? { ...state.currentTurn } : null,
    characters,
    scenes: structuredClone(state.scenes),
    cards,
    decks: {
      crisisCount: state.decks.crisis.length,
      crisisDiscard: [...state.decks.crisisDiscard],
      bondCount: state.decks.bond.length,
      letterCount: state.decks.letter.length,
    },
    equipmentDisplay: [...state.equipmentDisplay],
    flags: structuredClone(state.flags),
    boss: state.boss ? structuredClone(state.boss) : null,
    bonds: structuredClone(state.bonds),
    buffs: structuredClone(state.buffs),
    sceneWards: { ...state.sceneWards },
    pendingDecision,
    result: state.result ? { ...state.result } : null,
  };
}

/** 事件按座位脱敏：抽牌/收信等事件对非属主隐藏牌面（ADR-002） */
export function projectEvents<T extends { kind: string }>(events: T[], state: GameState, seat: number): T[] {
  const controlled = state.config.seatAssignments[seat] ?? [];
  return events.map((ev) => {
    if (ev.kind === 'card_drawn' || ev.kind === 'letter_received') {
      const e = ev as unknown as { character: CharacterId; cardUid: string; cardDefId?: string };
      if (!controlled.includes(e.character)) {
        return { ...ev, cardUid: '', cardDefId: '' } as T;
      }
    }
    if (ev.kind === 'letter_card_drawn') {
      const e = ev as unknown as { character: CharacterId };
      if (!controlled.includes(e.character)) {
        return { ...ev, cardUid: '', cardDefId: '' } as T;
      }
    }
    return ev;
  });
}

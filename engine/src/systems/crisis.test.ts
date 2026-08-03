/**
 * 危机蔓延（§5.1）与轮末效果（§5.4【裁A-14/15】）测试。
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state.js';
import { beginGame } from '../actions.js';
import { settle } from '../test-utils.js';
import { runCrisisPhase, runCrisisRoundEnd } from './crisis.js';
import type { GameConfig, GameState, GameEvent } from '../types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 21,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};
const cfg2: GameConfig = {
  playerCount: 2,
  seed: 21,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'] },
};

function freshGame(cfg: GameConfig = cfg4): GameState {
  return settle(beginGame(createInitialState(cfg)).state);
}

function crisisOnBoard(s: GameState): number {
  return Object.values(s.scenes).reduce((n, sc) => n + sc.crisisCards.length, 0);
}

describe('P1 危机蔓延（§5.1 / §3.2 翻牌量）', () => {
  it('开局 D1 清晨翻牌量（4P 翻 2 / 2P 翻 1，§3.2）', () => {
    expect(crisisOnBoard(freshGame())).toBe(2);
    expect(crisisOnBoard(freshGame(cfg2))).toBe(1);
  });

  it('翻牌量表：四人 D2 每天 2-3 / 双人 D2 每天 2（§3.2）', () => {
    for (const [cfg, d2] of [[cfg4, 2] as const, [cfg2, 2] as const]) {
      const s = freshGame(cfg);
      const draft = structuredClone(s);
      draft.phase.day = 2;
      draft.phase.segment = 'dawn';
      const before = crisisOnBoard(draft);
      const events: GameEvent[] = [];
      runCrisisPhase(draft, events);
      const after = settle(draft); // applyCommand 返回新引用，须用返回值
      expect(crisisOnBoard(after) - before).toBe(d2);
    }
  });

  it('通用卡挂起放置决策，指定场景卡直接落位（§5.1-c/d）', () => {
    const s = freshGame();
    const draft = structuredClone(s);
    draft.decks.crisis = [
      draft.decks.crisis.find((u) => draft.cards[u]?.defId === 'crisis-01')!, // 通用
      draft.decks.crisis.find((u) => draft.cards[u]?.defId === 'crisis-02')!, // 古战场
      ...draft.decks.crisis.filter((u) => !['crisis-01', 'crisis-02'].includes(draft.cards[u]?.defId ?? '')),
    ];
    draft.phase.day = 2;
    draft.phase.segment = 'dawn';
    const events: GameEvent[] = [];
    runCrisisPhase(draft, events);
    expect(draft.pendingDecision?.kind).toBe('place_crisis');
    const s2 = settle(draft);
    expect(s2.scenes['ancient_battlefield'].crisisCards.some((u) => s2.cards[u]?.defId === 'crisis-02')).toBe(true);
  });

  it('D2 黄昏首张固定为旁置通牒卡（§3.2【L69】）', () => {
    const s = freshGame();
    const draft = structuredClone(s);
    draft.phase.day = 2;
    draft.phase.segment = 'dusk';
    const aside = draft.ultimatumAsideUid!;
    const events: GameEvent[] = [];
    runCrisisPhase(draft, events);
    settle(draft);
    expect(draft.ultimatumAsideUid).toBeNull();
    expect(draft.scenes['ancient_battlefield'].crisisCards).toContain(aside); // 通牒卡目标场景=古战场废墟
  });

  it('危机牌库耗尽时弃牌堆洗混重建（§5.1-b【L95】）', () => {
    const s = freshGame();
    const draft = structuredClone(s);
    draft.decks.crisisDiscard = draft.decks.crisis.splice(0); // 牌库清空，弃牌堆 29 张
    draft.phase.day = 2;
    draft.phase.segment = 'dawn';
    const events: GameEvent[] = [];
    runCrisisPhase(draft, events);
    const after = settle(draft);
    expect(events.some((e) => e.kind === 'crisis_deck_reshuffled')).toBe(true);
    expect(crisisOnBoard(after)).toBeGreaterThan(0);
  });
});

describe('P4① 危机卡轮末效果（§5.4【裁A-14】）', () => {
  /** 摆盘：清空场面后放置指定危机卡 */
  function withBoard(defIds: string[]): GameState {
    const s = freshGame();
    const draft = structuredClone(s);
    for (const sc of Object.values(draft.scenes)) {
      draft.decks.crisis.push(...sc.crisisCards);
      sc.crisisCards = [];
      sc.crisisDamage = {};
    }
    for (const defId of defIds) {
      const i = draft.decks.crisis.findIndex((u) => draft.cards[u]?.defId === defId);
      const [uid] = draft.decks.crisis.splice(i, 1);
      const scene = defId === 'crisis-05' || defId === 'crisis-06' || defId === 'crisis-03' ? 'dark_valley' : defId === 'crisis-02' || defId === 'crisis-09' || defId === 'crisis-10' ? 'ancient_battlefield' : 'human_city';
      draft.scenes[scene].crisisCards.push(uid!);
    }
    return draft;
  }

  it('危-05 火山喷发：所在场景全体 1 伤（放置当轮即触发）', () => {
    let s = withBoard(['crisis-05']);
    s.characters['xiaoyu']!.scene = 'dark_valley';
    s.characters['baye']!.scene = 'dark_valley';
    const events: GameEvent[] = [];
    runCrisisRoundEnd(s, events);
    s = settle(s);
    expect(s.characters['xiaoyu']?.hp).toBe(4);
    expect(s.characters['baye']?.hp).toBe(4);
    expect(s.characters['liya']?.hp).toBe(5); // 不在该场景
  });

  it('危-04：小鱼在场 → 小鱼 E+1（T4）；不在场 → 全体 1 伤', () => {
    let s = withBoard(['crisis-04']); // 通用 → 放人类王城，小鱼初始在此
    const events: GameEvent[] = [];
    runCrisisRoundEnd(s, events);
    s = settle(s);
    expect(s.characters['xiaoyu']?.erosion).toBe(1);
    expect(s.characters['baye']?.hp).toBe(5); // 小鱼在 → 不群伤
  });

  it('危-09 献祭进度每卡独立累计【裁A-15】', () => {
    const s = withBoard(['crisis-09']);
    const uid = s.scenes['ancient_battlefield'].crisisCards[0]!;
    const events: GameEvent[] = [];
    runCrisisRoundEnd(s, events);
    expect(s.flags.sacrifice[uid]).toBe(1);
    runCrisisRoundEnd(s, events);
    expect(s.flags.sacrifice[uid]).toBe(2);
  });

  it('多张轮末效果卡挂起定序决策【裁A-14】', () => {
    const s = withBoard(['crisis-05', 'crisis-09']);
    const events: GameEvent[] = [];
    runCrisisRoundEnd(s, events);
    expect(s.pendingDecision?.kind).toBe('order_effects');
    const resolved = settle(s);
    expect(resolved.pendingDecision).toBeNull();
  });
});

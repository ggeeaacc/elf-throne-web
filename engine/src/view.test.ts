import { describe, expect, it } from 'vitest';
import { beginGame } from './actions.js';
import { createInitialState } from './state.js';
import { projectEvents, projectView } from './view.js';
import type { GameConfig } from './types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 11,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};

describe('projectView 隐藏信息投影（ADR-002）', () => {
  const state = beginGame(createInitialState(cfg4)).state;

  it('本人见手牌牌面，他人仅见数量', () => {
    const v0 = projectView(state, 0);
    expect(v0.characters['xiaoyu']?.hand).toHaveLength(4);
    expect(v0.characters['liya']?.hand).toHaveLength(0);
    expect(v0.characters['liya']?.handCount).toBe(4);
  });

  it('公共牌库仅见数量，通牒卡不外泄', () => {
    const v = projectView(state, 0);
    expect(v.decks.crisisCount).toBe(28); // 29 - D1 清晨已翻 1 张（§5.1）
    expect(v.decks.bondCount).toBe(9); // 羁-07 已发出（§5.3）
    expect(JSON.stringify(v)).not.toContain(state.ultimatumAsideUid ?? '∅');
  });

  it('牌库顺序不外泄（视图不含任何 deck 数组）', () => {
    const v = projectView(state, 2);
    expect(JSON.stringify(v)).not.toContain('"deck":');
    expect(v.characters['kaier']?.deckCount).toBe(6);
  });

  it('弃牌堆公开（实体桌游可查）', () => {
    const v = projectView(state, 1);
    expect(v.characters['xiaoyu']?.discard).toEqual([]);
    expect(v.decks.crisisDiscard).toEqual([]);
  });

  it('projectEvents：抽牌事件对非属主脱敏', () => {
    const events = [{ kind: 'card_drawn', character: 'xiaoyu', cardUid: 'yu-01#0', cardDefId: 'yu-01' }] as const;
    const forOwner = projectEvents([...events], state, 0);
    const forOther = projectEvents([...events], state, 1);
    expect(forOwner[0]?.cardUid).toBe('yu-01#0');
    expect(forOther[0]?.cardUid).toBe('');
  });

  it('单人双控：0 号座见小鱼与莉雅两手牌', () => {
    const solo = beginGame(
      createInitialState({ playerCount: 1, seed: 5, seatAssignments: { 0: ['xiaoyu', 'liya'] } }),
    ).state;
    const v = projectView(solo, 0);
    expect(v.characters['xiaoyu']?.hand).toHaveLength(4);
    expect(v.characters['liya']?.hand).toHaveLength(4);
  });
});

import { describe, expect, it } from 'vitest';
import { applyCommand, beginGame } from './actions.js';
import { createInitialState } from './state.js';
import { settle } from './test-utils.js';
import type { GameConfig, GameState } from './types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 7,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};

function freshGame(): GameState {
  return settle(beginGame(createInitialState(cfg4)).state);
}

describe('基础行动（§5.2-B 表）', () => {
  it('移动：相邻校验 + 1 AP（B1）', () => {
    const s0 = freshGame();
    const s1 = applyCommand(s0, { type: 'move', character: 'xiaoyu', to: 'ancient_battlefield' }).state;
    expect(s1.characters['xiaoyu']?.scene).toBe('ancient_battlefield');
    expect(s1.characters['xiaoyu']?.ap).toBe(2);
    expect(s1.log.some((e) => e.kind === 'moved')).toBe(true);
  });

  it('移动：非相邻拒绝（人类王城 ✗ 精灵王国）', () => {
    const s0 = freshGame();
    expect(() => applyCommand(s0, { type: 'move', character: 'xiaoyu', to: 'elf_kingdom' })).toThrow(/不相邻/);
  });

  it('移动：AP 耗尽拒绝', () => {
    let s = freshGame();
    s = applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'ancient_battlefield' }).state;
    s = applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'human_city' }).state;
    s = applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'ancient_battlefield' }).state;
    expect(s.characters['xiaoyu']?.ap).toBe(0);
    expect(() => applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'human_city' })).toThrow(/行动点不足/);
  });

  it('移动：非当前回合角色拒绝', () => {
    const s0 = freshGame();
    expect(() => applyCommand(s0, { type: 'move', character: 'liya', to: 'ancient_battlefield' })).toThrow(/不是 liya 的回合/);
  });

  it('搜索：1 AP 抽 2 张（B3）', () => {
    const s0 = freshGame();
    const before = s0.characters['xiaoyu']!;
    const s1 = applyCommand(s0, { type: 'search', character: 'xiaoyu' }).state;
    const after = s1.characters['xiaoyu']!;
    expect(after.hand.length).toBe(before.hand.length + 2);
    expect(after.deck.length).toBe(before.deck.length - 2);
    expect(after.ap).toBe(2);
  });

  it('纯函数性：applyCommand 不改动入参状态', () => {
    const s0 = freshGame();
    const snapshot = JSON.stringify(s0);
    applyCommand(s0, { type: 'move', character: 'xiaoyu', to: 'ancient_battlefield' });
    expect(JSON.stringify(s0)).toBe(snapshot);
  });

  it('打出卡牌：手牌校验与费用（B2）', () => {
    const s0 = freshGame();
    // 他人专属卡 → 拒绝
    expect(() => applyCommand(s0, { type: 'play_card', character: 'xiaoyu', cardUid: 'kai-01#0' })).toThrow(/不在手牌|非本人/);
    // 打出自己手牌：AP -1 且产生 card_played 事件
    const uid = s0.characters['xiaoyu']!.hand.find((u) => {
      const d = s0.cards[u]!.defId;
      return d === 'yu-02' || d === 'yu-04' || d === 'yu-06'; // 无目标需求的安全卡
    });
    if (uid) {
      const s1 = settle(applyCommand(s0, { type: 'play_card', character: 'xiaoyu', cardUid: uid, targets: {} }).state);
      expect(s1.characters['xiaoyu']?.ap).toBe(2);
      expect(s1.log.some((e) => e.kind === 'card_played')).toBe(true);
    }
  });

  it('锻造：材料不足拒绝（B4）', () => {
    const s0 = freshGame();
    expect(() =>
      applyCommand(s0, { type: 'forge', character: 'xiaoyu', equipmentUid: s0.equipmentDisplay[0]!, materialCardUids: [], useTokens: 0 }),
    ).toThrow(/材料|【材】/);
  });

  it('材料转让：同场景自由转让（§6.1）', () => {
    const s0 = freshGame();
    const draft = structuredClone(s0);
    draft.characters['xiaoyu']!.materialTokens = 2;
    const s1 = applyCommand(draft, { type: 'transfer_material', character: 'xiaoyu', to: 'baye', count: 1 }).state;
    expect(s1.characters['xiaoyu']?.materialTokens).toBe(1);
    expect(s1.characters['baye']?.materialTokens).toBe(1);
  });
});

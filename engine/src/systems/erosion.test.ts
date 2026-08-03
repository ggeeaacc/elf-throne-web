/**
 * 黑暗侵蚀状态机测试（§6.4【裁A-04/07/12/24/25/43】）。
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state.js';
import { beginGame, applyCommand } from '../actions.js';
import { settle, passTurn } from '../test-utils.js';
import { changeErosion, isBerserk } from './damage.js';
import { berserkAoE } from './combat.js';
import type { GameConfig, GameState, GameEvent } from '../types.js';

const cfg2: GameConfig = {
  playerCount: 2,
  seed: 44,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'] },
};

function freshGame(): GameState {
  return settle(beginGame(createInitialState(cfg2)).state);
}

describe('侵蚀等级（§6.4）', () => {
  it('E=3 中度：小鱼 AP -1（常规 3→2）', () => {
    let s = freshGame();
    s = structuredClone(s);
    s.characters['xiaoyu']!.erosion = 3;
    // 结束当前小鱼回合 → 莉雅 → 下一轮小鱼
    s = passTurn(s);
    s = passTurn(s);
    expect(s.characters['xiaoyu']?.ap).toBe(2);
  });

  it('E=4 失控：AP 0、无法主动行动、回合结束 AoE【L170】', () => {
    let s = freshGame();
    s = structuredClone(s);
    const events: GameEvent[] = [];
    changeErosion(s, events, 4, 'test');
    expect(isBerserk(s)).toBe(true);
    s = settle(s);
    // 失控后指令拒绝（除 end_turn/resolve_decision）
    expect(() => applyCommand(s, { type: 'search', character: 'xiaoyu' })).toThrow(/失控/);
    expect(() => applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'ancient_battlefield' })).toThrow(/失控/);
  });

  it('失控 AoE：回合结束对所在场景危机与友方各 1 点（固定 1 点【裁A-12】）', () => {
    let s = freshGame();
    s = structuredClone(s);
    s.characters['xiaoyu']!.erosion = 4;
    s.flags.berserkCountdown = 0;
    // 在人类王城放一张危机卡 + 莉雅同场景
    const uid = s.decks.crisis.find((u) => s.cards[u]?.defId === 'crisis-01')!;
    s.decks.crisis.splice(s.decks.crisis.indexOf(uid), 1);
    s.scenes['human_city'].crisisCards.push(uid);
    s.characters['liya']!.scene = 'human_city';
    const events: GameEvent[] = [];
    berserkAoE(s, events);
    expect(s.scenes['human_city'].crisisDamage[uid]).toBe(1);
    expect(s.characters['liya']?.hp).toBe(4);
    expect(s.characters['xiaoyu']?.erosion).toBe(4); // 失控后不再增加【L170】
  });

  it('失控瞬间：小鱼×莉雅立即获得羁-02 并激活（终态【裁A-04】）', () => {
    let s = freshGame();
    s = structuredClone(s);
    const events: GameEvent[] = [];
    changeErosion(s, events, 4, 'test');
    const bond = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(bond?.status).toBe('active');
    expect(bond?.cardUid).toMatch(/^bond-02#/);
    expect(bond?.replacedByBerserk).toBe(true);
  });

  it('侵蚀 ≤3 脱离失控【裁A-43】；羁-02 主动莉雅可单方发动 -3【裁A-24】', () => {
    let s = freshGame();
    s = structuredClone(s);
    const events: GameEvent[] = [];
    changeErosion(s, events, 4, 'test');
    s = settle(s);
    expect(isBerserk(s)).toBe(true);
    // 摆盘：轮到莉雅
    s = structuredClone(s);
    s.currentTurn = { character: 'liya' };
    s.characters['liya']!.ap = 2;
    // 莉雅单方发动羁-02
    const bond = s.bonds.find((b) => b.cardUid?.startsWith('bond-02'))!;
    const s2 = settle(applyCommand(s, { type: 'bond_active', character: 'liya', bondUid: bond.cardUid! }).state);
    expect(s2.characters['xiaoyu']?.erosion).toBe(3);
    expect(isBerserk(s2)).toBe(false);
    expect(s2.flags.berserkCountdown).toBeNull();
  });

  it('失控倒计时：第 3 次小鱼回合开始仍失控 → F4 判负【裁A-07】', () => {
    let s = freshGame();
    s = structuredClone(s);
    const events: GameEvent[] = [];
    changeErosion(s, events, 4, 'test');
    expect(s.flags.berserkCountdown).toBe(0);
    s = settle(s);
    // 第 1 次：进入失控后首个小鱼回合开始（当前就是他的回合则跳过——走完整轮）
    for (let i = 0; i < 6 && !s.result; i++) {
      s = passTurn(s);
    }
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F4');
  });
});

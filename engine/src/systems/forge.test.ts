/**
 * 锻造与装备测试（§6.6 + 附录B【裁A-26/27/33】）。
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state.js';
import { beginGame, applyCommand } from '../actions.js';
import { settle } from '../test-utils.js';
import { forgeCost, forge, dropEquipment } from './forge.js';
import type { GameConfig, GameState, GameEvent } from '../types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 66,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};

function freshGame(): GameState {
  return settle(beginGame(createInitialState(cfg4)).state);
}

/** 摆盘：给小鱼手牌塞 2 张【材】卡 + 材料指示物 */
function withMaterials(s: GameState): GameState {
  const d = structuredClone(s);
  const ch = d.characters['xiaoyu']!;
  const materialCards = ['yu-02#0', 'yu-04#0', 'yu-09#0'].filter((u) => d.cards[u]);
  ch.hand = materialCards.slice(0, 2);
  ch.deck = ch.deck.filter((u) => !ch.hand.includes(u));
  ch.materialTokens = 2;
  return d;
}

describe('锻造（§6.6）', () => {
  it('费用：2 AP + 2 份材；人类王城 -1/-1【L123】', () => {
    const s = freshGame();
    expect(forgeCost(s, 'xiaoyu', s.equipmentDisplay[0]!)).toEqual({ ap: 1, materials: 1 }); // 小鱼在人类王城
    const d = structuredClone(s);
    d.characters['xiaoyu']!.scene = 'dark_valley';
    expect(forgeCost(d, 'xiaoyu', d.equipmentDisplay[0]!)).toEqual({ ap: 2, materials: 2 });
  });

  it('材料卡与指示物任意混合支付【裁A-26】', () => {
    let s = withMaterials(freshGame());
    const eq = s.equipmentDisplay[0]!;
    const events: GameEvent[] = [];
    // 人类王城费用 1 AP + 1 材：1 张材料卡 + 0 指示物
    forge(s, events, 'xiaoyu', eq, [s.characters['xiaoyu']!.hand[0]!], 0);
    expect(s.characters['xiaoyu']?.equipment).toContain(eq);
    expect(s.characters['xiaoyu']?.ap).toBe(2);
    expect(s.equipmentDisplay).not.toContain(eq);
  });

  it('装备 ≤2：满则决策弃 1 件（弃置放回展示区底部【L112】）', () => {
    let s = withMaterials(freshGame());
    const d = structuredClone(s);
    d.characters['xiaoyu']!.equipment = [d.equipmentDisplay[0]!, d.equipmentDisplay[1]!];
    d.equipmentDisplay = d.equipmentDisplay.slice(2);
    const events: GameEvent[] = [];
    const target = d.equipmentDisplay[0]!;
    forge(d, events, 'xiaoyu', target, [d.characters['xiaoyu']!.hand[0]!], 0);
    expect(d.pendingDecision?.kind).toBe('choose_equipment');
    s = settle(d);
    expect(s.characters['xiaoyu']?.equipment).toHaveLength(2);
    expect(s.characters['xiaoyu']?.equipment).toContain(target);
    // 被弃装备回到展示区底部
    expect(s.equipmentDisplay[s.equipmentDisplay.length - 1]).toBe(d.characters['xiaoyu']!.equipment[0]);
  });

  it('装-04 守护之戒：上限 +2 立即回 2；卸下钳制【裁A-33】', () => {
    let s = freshGame();
    const d = structuredClone(s);
    d.characters['xiaoyu']!.hp = 2;
    const ring = d.equipmentDisplay.find((u) => d.cards[u]?.defId === 'equip-04')!;
    d.characters['xiaoyu']!.equipment = [ring];
    d.equipmentDisplay = d.equipmentDisplay.filter((u) => u !== ring);
    // 模拟获得效果（grant 时已 +2/回 2；此处直接测卸下）
    d.characters['xiaoyu']!.maxHp = 7;
    d.characters['xiaoyu']!.hp = 6;
    const events: GameEvent[] = [];
    dropEquipment(d, events, 'xiaoyu', ring);
    expect(d.characters['xiaoyu']?.maxHp).toBe(5);
    expect(d.characters['xiaoyu']?.hp).toBe(5); // 钳制到新上限
  });

  it('危-06 所在场景无法锻造', () => {
    let s = withMaterials(freshGame());
    const d = structuredClone(s);
    const uid = d.decks.crisis.find((u) => d.cards[u]?.defId === 'crisis-06')!;
    d.decks.crisis.splice(d.decks.crisis.indexOf(uid), 1);
    d.scenes['human_city'].crisisCards.push(uid);
    const events: GameEvent[] = [];
    expect(() => forge(d, events, 'xiaoyu', d.equipmentDisplay[0]!, [d.characters['xiaoyu']!.hand[0]!], 0)).toThrow(/无法锻造/);
  });

  it('巴-07 折扣标记：下一次锻造该装备 -1/-1（任何人可享【裁A-38】）', () => {
    const s = freshGame();
    const d = structuredClone(s);
    const eq = d.equipmentDisplay[2]!;
    d.flags.oneShotUsed[`ba07:${eq}`] = true;
    // 人类王城 + 巴-07 → 2-1-1=0 AP / 2-1-1=0 材（下限 0【裁A-27】）
    expect(forgeCost(d, 'xiaoyu', eq)).toEqual({ ap: 0, materials: 0 });
  });
});

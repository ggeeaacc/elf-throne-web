/**
 * 交战结算测试（§6.1【裁A-09】+ 羁绊结成 §6.3【裁A-03/16】+ 迷雾【裁A-20】）。
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state.js';
import { beginGame } from '../actions.js';
import { settle, putCrisis } from '../test-utils.js';
import { dealDamageToCrisis, clearCrisis, crisisRemaining } from './combat.js';
import type { GameConfig, GameState, GameEvent } from '../types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 9,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};

function freshGame(): GameState {
  return settle(beginGame(createInitialState(cfg4)).state);
}

describe('交战结算（§6.1）', () => {
  it('伤害从危机度扣除；参与者各获 1 材料【裁A-09】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'human_city'); // 危机度 4
    const uid = s.scenes['human_city'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-01')!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 1, 'xiaoyu');
    expect(crisisRemaining(s, uid)).toBe(3);
    dealDamageToCrisis(s, events, uid, 3, 'baye');
    expect(crisisRemaining(s, uid)).toBe(0); // 已清除
    expect(s.scenes['human_city'].crisisCards).not.toContain(uid);
    expect(s.decks.crisisDiscard).toContain(uid);
    // 参与者 = 造成过实际伤害的小鱼与巴爷
    expect(s.characters['xiaoyu']?.materialTokens).toBe(1);
    expect(s.characters['baye']?.materialTokens).toBe(1);
    expect(s.characters['liya']?.materialTokens).toBe(0);
  });

  it('单次攻击溢出伤害浪费（§6.1.2）', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-08', 'elf_kingdom'); // 危机度 1
    const uid = s.scenes['elf_kingdom'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-08')!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 99, 'liya');
    expect(crisisRemaining(s, uid)).toBe(0); // 清除，无溢出结转对象
  });

  it('小鱼参与清除【暗】卡 → 侵蚀 +1（T1【L138】）；未参与不加', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-02', 'ancient_battlefield'); // 【暗】危机度 4
    const uid = s.scenes['ancient_battlefield'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-02')!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 4, 'kaier'); // 仅凯尔参与
    expect(s.characters['xiaoyu']?.erosion).toBe(0);

    s = putCrisis(s, 'crisis-02', 'ancient_battlefield');
    const uid2 = s.scenes['ancient_battlefield'].crisisCards.find((u) => u !== uid && s.cards[u]?.defId === 'crisis-02')!;
    dealDamageToCrisis(s, events, uid2, 1, 'xiaoyu');
    dealDamageToCrisis(s, events, uid2, 3, 'kaier');
    expect(s.characters['xiaoyu']?.erosion).toBe(1);
  });

  it('失控 AoE 清除：不算参与、无材料、不追加侵蚀【L170】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-02', 'human_city');
    const uid = s.scenes['human_city'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-02')!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 4, 'xiaoyu', { berserkAoE: true });
    expect(crisisRemaining(s, uid)).toBe(0);
    expect(s.characters['xiaoyu']?.materialTokens).toBe(0);
    expect(s.characters['xiaoyu']?.erosion).toBe(0);
  });

  it('卡面清除奖励与基础奖励并存（危-05：参与者各 +2 材料，共 3）', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-05', 'dark_valley');
    const uid = s.scenes['dark_valley'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-05')!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 4, 'xiaoyu');
    expect(s.characters['xiaoyu']?.materialTokens).toBe(3); // 基础 1 + 卡面 2
  });

  it('危-10 清除：全体回满；标记 avatarCleared（§9.8）', () => {
    let s = freshGame();
    const draft = structuredClone(s);
    draft.characters['liya']!.hp = 1;
    s = putCrisis(draft, 'crisis-10', 'ancient_battlefield');
    const uid = s.scenes['ancient_battlefield'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-10')!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 6, 'kaier');
    expect(s.characters['liya']?.hp).toBe(s.characters['liya']?.maxHp);
    expect(s.flags.avatarCleared).toBe(true);
  });
});

describe('羁绊结成（§6.3）', () => {
  it('偏见路径：bondLead 卡被触发对共同击败 → 结成（选卡决策）', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'human_city');
    const uid = s.scenes['human_city'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-01')!;
    // 模拟偏见关联：小鱼×凯尔（实际不同场景也能测状态机）
    s = structuredClone(s);
    s.bondLeads.push({ pair: ['kaier', 'xiaoyu'], crisisUid: uid });
    s.characters['kaier']!.scene = 'human_city';
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 1, 'xiaoyu');
    dealDamageToCrisis(s, events, uid, 3, 'kaier');
    // 挂起选卡决策
    expect(s.pendingDecision?.kind).toBe('choose_bond_card');
    expect(s.characters['xiaoyu']?.bondTokens).toBe(1);
    expect(s.characters['kaier']?.bondTokens).toBe(1);
    const resolved = settle(s);
    const bond = resolved.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('kaier'));
    expect(bond?.status).toBe('active');
    expect(bond?.cardUid).toBeTruthy();
    expect(resolved.bondLeads).toHaveLength(0);
  });

  it('bondLead 被第三方清除 → 关联失效【裁A-16】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'human_city');
    const uid = s.scenes['human_city'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-01')!;
    s = structuredClone(s);
    s.bondLeads.push({ pair: ['kaier', 'xiaoyu'], crisisUid: uid });
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 4, 'baye'); // 第三方单独清除
    expect(s.bondLeads).toHaveLength(0);
    expect(s.bonds.some((b) => b.pair.includes('xiaoyu') && b.pair.includes('kaier'))).toBe(false);
  });

  it('同族路径【裁A-03】：小鱼×巴爷同场景共同清除 → 可结成', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'human_city');
    const uid = s.scenes['human_city'].crisisCards.find((u) => s.cards[u]?.defId === 'crisis-01')!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 1, 'xiaoyu');
    dealDamageToCrisis(s, events, uid, 3, 'baye');
    expect(s.pendingDecision?.kind).toBe('choose_bond_card');
    const resolved = settle(s);
    expect(resolved.bonds.some((b) => b.pair.includes('xiaoyu') && b.pair.includes('baye') && b.status === 'active')).toBe(true);
  });
});

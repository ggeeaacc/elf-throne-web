/**
 * TC-SC 场景行动与移动/飞空艇 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import {
  answer,
  cfg4,
  crisisIn,
  ensureCard,
  freshGame,
  giveEquipment,
  mut,
  passTurn,
  playCardById,
  playRaw,
  settle,
} from '../helpers/regression-utils.js';

describe('TC-SC 场景行动与移动/飞空艇', () => {
  it('TC-SC-001 移动 1 AP 沿相邻；非相邻拒绝【§1.1】【L40-44, L101】', () => {
    let s = freshGame();
    // human_city → dark_valley 相邻
    s = applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'dark_valley' }).state;
    expect(s.characters['xiaoyu']?.scene).toBe('dark_valley');
    expect(s.characters['xiaoyu']?.ap).toBe(2);
    // dark_valley × ancient_battlefield 不相邻
    expect(() => applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'ancient_battlefield' })).toThrow(/不相邻/);
    // human_city × elf_kingdom 不相邻
    let s2 = freshGame();
    expect(() => applyCommand(s2, { type: 'move', character: 'xiaoyu', to: 'elf_kingdom' })).toThrow(/不相邻/);
  });

  it('TC-SC-002 生命树的治愈：1 AP 回 1 + 1 净化；每角色每轮限 1【§5.2】【L126】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['liya']!.hp = 3;
    });
    s = passTurn(s); // → 莉雅回合
    s = applyCommand(s, { type: 'scene_action', character: 'liya', action: 'tree_heal' }).state;
    expect(s.characters['liya']?.hp).toBe(4);
    expect(s.characters['liya']?.purifyTokens).toBe(1);
    expect(s.characters['liya']?.ap).toBe(2);
    expect(() => applyCommand(s, { type: 'scene_action', character: 'liya', action: 'tree_heal' })).toThrow(/限/);
    // 同场景凯尔当轮可自用自己的 1 次
    s = passTurn(s); // → 凯尔回合
    s = mut(s, (d) => {
      d.characters['kaier']!.hp = 4;
    });
    s = applyCommand(s, { type: 'scene_action', character: 'kaier', action: 'tree_heal' }).state;
    expect(s.characters['kaier']?.hp).toBe(5);
  });

  it('TC-SC-003 侦查敌情：看顶 2，1 置底 1 放回顶【§5.2】【L129】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'ancient_battlefield';
    });
    const top2 = [...s.decks.crisis.slice(0, 2)];
    const total = s.decks.crisis.length;
    const r = applyCommand(s, { type: 'scene_action', character: 'xiaoyu', action: 'scout' });
    expect(r.state.pendingDecision?.kind).toBe('reorder_cards');
    const s2 = answer(r.state, { bottom: top2[1] });
    expect(s2.decks.crisis[0]).toBe(top2[0]);
    expect(s2.decks.crisis[s2.decks.crisis.length - 1]).toBe(top2[1]);
    expect(s2.decks.crisis.length).toBe(total);
  });

  it('TC-SC-004 营救女王：3 AP + 2 净化 → 决战跳首领 P1；一局限 1【§5.2】【L132】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'dark_valley';
      d.characters['xiaoyu']!.purifyTokens = 2;
    });
    s = applyCommand(s, { type: 'scene_action', character: 'xiaoyu', action: 'rescue_queen' }).state;
    expect(s.flags.queenRescued).toBe(true);
    expect(s.characters['xiaoyu']?.ap).toBe(0);
    expect(s.characters['xiaoyu']?.purifyTokens).toBe(0);
    expect(() => applyCommand(s, { type: 'scene_action', character: 'xiaoyu', action: 'rescue_queen' })).toThrow(/限/);
  });

  it('TC-SC-005 寻找宠物：小剑小盾每轮一次 +1 或受击 -1；一局限 1【§5.2】【L133】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'dark_valley';
    });
    s = applyCommand(s, { type: 'scene_action', character: 'xiaoyu', action: 'find_pet' }).state;
    expect(s.characters['xiaoyu']?.hasPet).toBe(true);
    expect(() => applyCommand(s, { type: 'scene_action', character: 'xiaoyu', action: 'find_pet' })).toThrow(/限/);
    // 当轮攻击声明 +1：小鱼横斩 3+1（屠龙者）+1（小剑）=5
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.ap = 3;
      const uid = d.decks.crisis.find((u) => d.cards[u]?.defId === 'crisis-10')!;
      d.decks.crisis = d.decks.crisis.filter((u) => u !== uid);
      d.scenes['dark_valley'].crisisCards.push(uid);
    });
    const uid = crisisIn(s, 'dark_valley', 'crisis-10')[0]!;
    const r = playRaw(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] }, { usePetAttack: true });
    const dmg = r.events.find((e) => e.kind === 'crisis_damaged') as { amount: number } | undefined;
    expect(dmg?.amount).toBe(4); // 3+0(屠龙者已无关危机卡)+1(小剑)
    // 同轮第二次声明小剑拒绝
    let s3 = settle(r.state);
    s3 = ensureCard(s3, 'xiaoyu', 'yu-01');
    expect(() => playRaw(s3, 'xiaoyu', 'yu-01', { crisisUids: [uid] }, { usePetAttack: true })).toThrow(/每轮限用一次/);
  });

  it('TC-SC-006 搜索 1 AP 抽 2；牌库空洗弃牌堆重建【§5.2】【L109】', () => {
    let s = freshGame();
    const hand0 = s.characters['xiaoyu']!.hand.length;
    s = applyCommand(s, { type: 'search', character: 'xiaoyu' }).state;
    expect(s.characters['xiaoyu']?.hand.length).toBe(hand0 + 2);
    // 牌库=1、弃牌堆=3 → 先抽 1 → 洗混重建 → 再抽 1
    let s2 = freshGame();
    s2 = mut(s2, (d) => {
      const x = d.characters['xiaoyu']!;
      x.discard.push(...x.deck.splice(0, x.deck.length - 1)); // 牌库留 1，弃牌堆 5
    });
    const before = s2.characters['xiaoyu']!.hand.length;
    const r = applyCommand(s2, { type: 'search', character: 'xiaoyu' });
    expect(r.events.some((e) => e.kind === 'deck_reshuffled')).toBe(true);
    expect(r.state.characters['xiaoyu']?.hand.length).toBe(before + 2);
  });

  it('TC-SC-007 打出卡牌 1 AP 结算后入弃牌堆；攻击卡默认当前场景【§5.2】【L105-106】', () => {
    let s = freshGame();
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = mut(s, (d) => {
      // 用危-10（危机度 6）：4 点伤害不清除，伤害标记留存（§6.1 黑色指示物标记）
      const uid = d.decks.crisis.find((u) => d.cards[u]?.defId === 'crisis-10')!;
      d.decks.crisis = d.decks.crisis.filter((u) => u !== uid);
      d.scenes['ancient_battlefield'].crisisCards.push(uid);
      d.characters['xiaoyu']!.scene = 'ancient_battlefield';
    });
    const uid = crisisIn(s, 'ancient_battlefield', 'crisis-10')[0]!;
    s = playCardById(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] });
    expect(s.characters['xiaoyu']?.ap).toBe(2);
    expect(s.characters['xiaoyu']?.discard.some((u) => s.cards[u]?.defId === 'yu-01')).toBe(true);
    expect(s.scenes['ancient_battlefield'].crisisDamage[uid]).toBe(3); // 3（屠龙者已不适用危机卡）
  });
});

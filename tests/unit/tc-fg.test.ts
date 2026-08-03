/**
 * TC-FG 锻造与装备 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import { forgeCost, dropEquipment } from '../../engine/src/systems/forge.js';
import { dealDamageToCrisis } from '../../engine/src/systems/combat.js';
import { dealDamageToCharacter } from '../../engine/src/systems/damage.js';
import type { GameEvent } from '../../engine/src/types.js';
import {
  answer,
  cfg4,
  crisisIn,
  ensureCard,
  evs,
  freshGame,
  giveEquipment,
  mut,
  passRound,
  playCardById,
  playPassCopy,
  playRaw,
  putCrisis,
  settle,
  toBattle,
} from '../helpers/regression-utils.js';
import type { CharacterId, GameState } from '../../engine/src/types.js';

function giveTurn(s: GameState, c: CharacterId, ap = 3): GameState {
  return mut(s, (d) => {
    d.currentTurn = { character: c };
    d.characters[c]!.ap = ap;
  });
}

/** 从展示区找指定 defId 的 uid */
function displayUid(s: GameState, defId: string): string {
  return s.equipmentDisplay.find((u) => s.cards[u]?.defId === defId)!;
}

describe('TC-FG 锻造与装备', () => {
  it('TC-FG-001 锻造基础费用 2 AP + 2 份材；材料卡与指示物任意混合【§6.6】【L110-111】【裁A-26】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom'; // 非人类王城（无折扣）
      d.characters['xiaoyu']!.materialTokens = 1;
    });
    s = ensureCard(s, 'xiaoyu', 'yu-02'); // 【材】卡
    const matUid = s.characters['xiaoyu']!.hand.find((u) => s.cards[u]?.defId === 'yu-02')!;
    s = applyCommand(s, {
      type: 'forge',
      character: 'xiaoyu',
      equipmentUid: displayUid(s, 'equip-01'),
      materialCardUids: [matUid],
      useTokens: 1,
    }).state; // 1 卡 + 1 指示物 = 2 份
    expect(s.characters['xiaoyu']?.ap).toBe(1);
    expect(s.characters['xiaoyu']?.materialTokens).toBe(0);
    expect(s.characters['xiaoyu']?.hand.some((u) => s.cards[u]?.defId === 'yu-02')).toBe(false);
    expect(s.characters['xiaoyu']?.equipment.length).toBe(1);
  });

  it('TC-FG-002 人类王城折扣：AP -1、材料 -1（实付 1 AP + 1 材）【§5.2】【L123】', () => {
    let s = freshGame(); // 小鱼在人类王城
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.materialTokens = 1;
    });
    const cost = forgeCost(s, 'xiaoyu', displayUid(s, 'equip-02'));
    expect(cost).toEqual({ ap: 1, materials: 1 });
    s = applyCommand(s, {
      type: 'forge',
      character: 'xiaoyu',
      equipmentUid: displayUid(s, 'equip-02'),
      materialCardUids: [],
      useTokens: 1,
    }).state;
    expect(s.characters['xiaoyu']?.ap).toBe(2);
    expect(s.characters['xiaoyu']?.materialTokens).toBe(0);
  });

  it('TC-FG-003 巴-07 折扣：任何人下一次锻造该装备均可享【§6.6】【§9.4】【裁A-38】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom';
      d.characters['xiaoyu']!.materialTokens = 1;
      d.flags.oneShotUsed[`ba07:${'equip-03#0'}`] = true;
    });
    const uid = displayUid(s, 'equip-03');
    const cost = forgeCost(s, 'xiaoyu', uid);
    expect(cost).toEqual({ ap: 1, materials: 1 }); // 巴-07 -1/-1
    s = applyCommand(s, { type: 'forge', character: 'xiaoyu', equipmentUid: uid, materialCardUids: [], useTokens: 1 }).state;
    expect(s.characters['xiaoyu']?.ap).toBe(2);
    expect(s.flags.oneShotUsed[`ba07:${uid}`]).toBeUndefined(); // 折扣一次性已消费
  });

  it('TC-FG-004 费用下限 0：王城+巴-07 双折扣可免费锻造【§6.6】【裁A-27】', () => {
    let s = freshGame(); // 小鱼在人类王城
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.materialTokens = 0;
      d.flags.oneShotUsed[`ba07:${'equip-01#0'}`] = true;
    });
    const uid = displayUid(s, 'equip-01');
    const cost = forgeCost(s, 'xiaoyu', uid);
    expect(cost).toEqual({ ap: 0, materials: 0 }); // 钳制下限 0
    s = applyCommand(s, { type: 'forge', character: 'xiaoyu', equipmentUid: uid, materialCardUids: [], useTokens: 0 }).state;
    expect(s.characters['xiaoyu']?.ap).toBe(3); // 0 AP 未扣
    expect(s.characters['xiaoyu']?.equipment.length).toBe(1);
  });

  it('TC-FG-005 持有 ≤2：满则先弃 1（弃置放回展示区底部）【§6.6】【L111-112】', () => {
    let s = freshGame();
    s = giveEquipment(s, 'xiaoyu', 'equip-01');
    s = giveEquipment(s, 'xiaoyu', 'equip-02');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.materialTokens = 2;
    });
    const uid = displayUid(s, 'equip-03');
    const r = applyCommand(s, { type: 'forge', character: 'xiaoyu', equipmentUid: uid, materialCardUids: [], useTokens: 1 }); // 王城折扣：1 AP + 1 材
    expect(r.state.pendingDecision?.kind).toBe('choose_equipment'); // 满 2 弃 1
    const dropUid = r.state.characters['xiaoyu']!.equipment[0]!;
    const s2 = answer(r.state, { equipmentUid: dropUid });
    expect(s2.characters['xiaoyu']?.equipment.length).toBe(2);
    expect(s2.characters['xiaoyu']?.equipment).toContain(uid);
    expect(s2.equipmentDisplay[s2.equipmentDisplay.length - 1]).toBe(dropUid); // 放回底部
  });

  it('TC-FG-006 装备被动永久；主动每轮限 1【§6.6】【L377】', () => {
    let s = freshGame();
    s = giveEquipment(s, 'xiaoyu', 'equip-01');
    const eqUid = s.characters['xiaoyu']!.equipment[0]!;
    s = applyCommand(s, { type: 'equipment_active', character: 'xiaoyu', equipmentUid: eqUid }).state;
    expect(() => applyCommand(s, { type: 'equipment_active', character: 'xiaoyu', equipmentUid: eqUid })).toThrow(/限/);
    // 被动仍在（减伤 -1）
    expect(s.characters['xiaoyu']?.equipment).toContain(eqUid);
  });

  it('TC-FG-007 危-06 清除奖励：免费取 1 件装备（参与者协商归属、占持有上限）【§9.8】【§6.6】【裁A-40】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-06', 'dark_valley');
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-01');
    // 危-06 危机度 4：巴-01(3) 不够——摆盘已损 1
    s = mut(s, (d) => {
      const uid = d.scenes['dark_valley'].crisisCards.find((u) => d.cards[u]?.defId === 'crisis-06')!;
      d.scenes['dark_valley'].crisisDamage[uid] = 1;
      d.crisisDamageLog[uid] = ['baye'];
    });
    const uid = crisisIn(s, 'dark_valley', 'crisis-06')[0]!;
    const r = playRaw(s, 'baye', 'ba-01', { crisisUids: [uid] });
    expect(r.state.pendingDecision?.kind).toBe('choose_equipment'); // 免费装备归属决策
    const s2 = answer(r.state, { equipmentUid: displayUid(r.state, 'equip-04'), owner: 'baye' });
    expect(s2.characters['baye']?.equipment.length).toBe(1);
    expect(s2.characters['baye']?.ap).toBe(2); // 仅打卡 1 AP，免费锻造不耗
    expect(s2.characters['baye']?.maxHp).toBe(7); // 装-04 上限 +2
  });

  it('TC-FG-008 羁-10 免费锻造：不耗材料与 AP、仅触发 1 次、占持有上限【§9.6】【L400】', () => {
    // 见 TC-BD-028-b（同一钩子）：此处断言"若实现"的费用与次数口径
    let s = freshGame();
    s = mut(s, (d) => {
      d.bonds.push({ pair: ['kaier', 'xiaoyu'], status: 'active', cardUid: 'bond-10#0', replacedByBerserk: false, activeUsedRound: null });
      d.decks.bond = d.decks.bond.filter((u) => u !== 'bond-10#0');
    });
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom';
      const u = d.scenes['elf_kingdom'].crisisCards.find((x) => d.cards[x]?.defId === 'crisis-10')!;
      d.scenes['elf_kingdom'].crisisDamage[u] = 3;
      d.crisisDamageLog[u] = ['xiaoyu', 'kaier'];
    });
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 3, 'kaier'); // 共同清除
    // 【预期失败=引擎 bug】应挂起免费装备决策（小鱼、凯尔各 1 件）
    expect(s.pendingDecision?.kind).toBe('choose_equipment');
  });

  it('TC-FG-009 装-01：被动受伤 -1（钳 0）；主动 1 AP 本轮再 -1【§9.5】', () => {
    let s = freshGame();
    s = giveEquipment(s, 'xiaoyu', 'equip-01');
    const hit = (st: GameState, n: number): GameState => {
      const d = structuredClone(st);
      const ev: GameEvent[] = [];
      dealDamageToCharacter(d, ev, { target: 'xiaoyu', damage: { base: n, chain: [], source: 't', dark: false, fromAttackCard: false } });
      d.log.push(...ev);
      return d;
    };
    s = hit(s, 1);
    expect(s.characters['xiaoyu']?.hp).toBe(5); // 1-1 钳 0
    s = hit(s, 3);
    expect(s.characters['xiaoyu']?.hp).toBe(3); // 3-1=2
    // 主动：本轮再 -1 → 3-2=1
    const eqUid = s.characters['xiaoyu']!.equipment[0]!;
    s = applyCommand(s, { type: 'equipment_active', character: 'xiaoyu', equipmentUid: eqUid }).state;
    expect(s.characters['xiaoyu']?.ap).toBe(2);
    s = hit(s, 3);
    expect(s.characters['xiaoyu']?.hp).toBe(2);
  });

  it('TC-FG-010 装-02：被动攻击 +1；主动 0 AP 本次视为远程【§9.5】', () => {
    let s = freshGame();
    s = giveEquipment(s, 'xiaoyu', 'equip-02');
    s = putCrisis(s, 'crisis-10', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    const uid = crisisIn(s, 'human_city', 'crisis-10')[0]!;
    let r = playRaw(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] });
    expect((r.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(4); // 3+装备1（屠龙者已不适用危机卡）
    // 主动 0 AP：本次攻击远程（可打非当前场景）
    let s2 = freshGame();
    s2 = giveEquipment(s2, 'xiaoyu', 'equip-02');
    s2 = putCrisis(s2, 'crisis-02', 'ancient_battlefield');
    s2 = ensureCard(s2, 'xiaoyu', 'yu-01');
    const eqUid = s2.characters['xiaoyu']!.equipment[0]!;
    const ap0 = s2.characters['xiaoyu']!.ap;
    s2 = applyCommand(s2, { type: 'equipment_active', character: 'xiaoyu', equipmentUid: eqUid }).state;
    expect(s2.characters['xiaoyu']?.ap).toBe(ap0); // 0 AP
    const uid2 = crisisIn(s2, 'ancient_battlefield', 'crisis-02')[0]!;
    let r2 = playRaw(s2, 'xiaoyu', 'yu-01', { crisisUids: [uid2] }); // 横斩本限当前场景 → 远程标记放开
    expect(r2.events.find((e) => e.kind === 'crisis_damaged')).toBeTruthy();
  });

  it('TC-FG-011 装-03：被动清除危机时溅射同场景另一张危机卡1点伤害；主动 1 AP 本轮对玫拉 +2【§9.5】', () => {
    // 被动（溅射：持有者清除危机时对同场景另一张危机卡造成1点伤害）
    let s = freshGame();
    s = giveEquipment(s, 'xiaoyu', 'equip-03');
    // 放置两张低危机度卡在同场景
    s = putCrisis(s, 'crisis-08', 'human_city');
    s = putCrisis(s, 'crisis-08', 'human_city');
    const [uid1, uid2] = crisisIn(s, 'human_city', 'crisis-08');
    const events: GameEvent[] = [];
    // xiaoyu 清除第一张（crisis-08 危机度=1）
    dealDamageToCrisis(s, events, uid1!, 1, 'xiaoyu');
    // 装-03 溅射：同场景另一张危机卡应受到 1 点伤害
    const splashEv = events.find((e) => e.kind === 'crisis_damaged' && (e as { cardUid: string }).cardUid === uid2);
    expect(splashEv).toBeDefined();
    expect((splashEv as { amount: number }).amount).toBe(1);
    // 无装备角色清除不触发溅射
    let s2 = freshGame();
    s2 = putCrisis(s2, 'crisis-08', 'human_city');
    s2 = putCrisis(s2, 'crisis-08', 'human_city');
    const [u1, u2] = crisisIn(s2, 'human_city', 'crisis-08');
    const ev2: GameEvent[] = [];
    dealDamageToCrisis(s2, ev2, u1!, 1, 'xiaoyu');
    const noSplash = ev2.find((e) => e.kind === 'crisis_damaged' && (e as { cardUid: string }).cardUid === u2);
    expect(noSplash).toBeUndefined();
    // 主动（决战对玫拉 +2）
    let b = toBattle(freshGame());
    b = giveEquipment(b, 'xiaoyu', 'equip-03');
    b = mut(b, (d) => {
      d.currentTurn = { character: 'xiaoyu' };
      d.characters['xiaoyu']!.ap = 2;
    });
    const eqUid = b.characters['xiaoyu']!.equipment[0]!;
    b = applyCommand(b, { type: 'equipment_active', character: 'xiaoyu', equipmentUid: eqUid }).state;
    b = ensureCard(b, 'xiaoyu', 'yu-01');
    const shield0 = b.boss!.shield;
    b = playPassCopy(b, 'xiaoyu', 'yu-01');
    expect(b.boss?.shield).toBe(shield0 - 6); // 3(横斩)+1(屠龙者)+2(装-03主动)=6（被动不再加攻击力）
  });

  it('TC-FG-012 装-04：上限 +2 立即回 2；失去时上限 -2、当前生命钳制【§9.5】【裁A-33】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.materialTokens = 1; // 王城折扣：1 AP + 1 材
    });
    s = applyCommand(s, { type: 'forge', character: 'xiaoyu', equipmentUid: displayUid(s, 'equip-04'), materialCardUids: [], useTokens: 1 }).state;
    expect(s.characters['xiaoyu']?.maxHp).toBe(7);
    expect(s.characters['xiaoyu']?.hp).toBe(7); // +2 并立即回 2
    // 失去：上限 -2、当前生命钳制
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.hp = 6;
    });
    const events: GameEvent[] = [];
    const d = structuredClone(s);
    dropEquipment(d, events, 'xiaoyu', d.characters['xiaoyu']!.equipment[0]!);
    expect(d.characters['xiaoyu']?.maxHp).toBe(5);
    expect(d.characters['xiaoyu']?.hp).toBe(5); // 6 钳制到 5
  });

  it('TC-FG-013 装-05：每次移动多跨 1；小鱼每回合首次移动免费；主动 1 AP 移至任意【§9.5】【L384】', () => {
    // 小鱼持装-05：首次移动 0 AP 且可跨 2（人类王城→精灵王国，跨 2 且本不相邻）
    let s = freshGame();
    s = giveEquipment(s, 'xiaoyu', 'equip-05');
    s = applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'elf_kingdom' }).state;
    expect(s.characters['xiaoyu']?.scene).toBe('elf_kingdom');
    expect(s.characters['xiaoyu']?.ap).toBe(3); // 首次免费
    // 第二次移动 1 AP（仍可多跨 1：精灵王国→人类王城）
    s = applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'human_city' }).state;
    expect(s.characters['xiaoyu']?.ap).toBe(2);
    // 莉雅持装-05：无免费，但移动可跨 2
    let b = freshGame();
    b = giveEquipment(b, 'liya', 'equip-05');
    b = mut(b, (d) => {
      d.currentTurn = { character: 'liya' };
      d.characters['liya']!.ap = 3;
    });
    b = applyCommand(b, { type: 'move', character: 'liya', to: 'human_city' }).state; // 跨 2（精灵王国→古战场→王城）
    expect(b.characters['liya']?.scene).toBe('human_city');
    expect(b.characters['liya']?.ap).toBe(2);
    // 主动：1 AP 移至任意场景
    let c = freshGame();
    c = giveEquipment(c, 'xiaoyu', 'equip-05');
    const eqUid = c.characters['xiaoyu']!.equipment[0]!;
    c = applyCommand(c, { type: 'equipment_active', character: 'xiaoyu', equipmentUid: eqUid, params: { target: 'dark_valley' } as never }).state;
    expect(c.characters['xiaoyu']?.scene).toBe('dark_valley');
    expect(c.characters['xiaoyu']?.ap).toBe(2);
  });

  it('TC-FG-014 决战不可用锻造【§5.2】【L198】', () => {
    let s = toBattle(freshGame());
    s = mut(s, (d) => {
      d.currentTurn = { character: 'xiaoyu' };
      d.characters['xiaoyu']!.ap = 2;
      d.characters['xiaoyu']!.materialTokens = 2;
    });
    expect(() =>
      applyCommand(s, { type: 'forge', character: 'xiaoyu', equipmentUid: s.equipmentDisplay[0]!, materialCardUids: [], useTokens: 2 }),
    ).toThrow(/决战/);
  });
});

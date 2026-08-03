/**
 * TC-ER 侵蚀与失控状态机 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import { berserkAoE, dealDamageToBoss, dealDamageToCrisis } from '../../engine/src/systems/combat.js';
import { dealDamageToCharacter, isBerserk } from '../../engine/src/systems/damage.js';
import { startTurn } from '../../engine/src/phases.js';
import {
  answer,
  bumpErosion,
  cfg4,
  crisisIn,
  ensureCard,
  evs,
  freshGame,
  mut,
  passRound,
  passTurn,
  playCardById,
  playPassCopy,
  playRaw,
  putCrisis,
  setBond,
  setErosion,
  settle,
  toBattle,
} from '../helpers/regression-utils.js';
import type { CharacterId, GameEvent, GameState } from '../../engine/src/types.js';

function giveTurn(s: GameState, c: CharacterId, ap = 3): GameState {
  return mut(s, (d) => {
    d.currentTurn = { character: c };
    d.characters[c]!.ap = ap;
  });
}

describe('TC-ER 侵蚀与失控状态机', () => {
  it('TC-ER-001 E=1,2 轻微：无负面影响【§6.4】【L168】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.erosion = 2;
    });
    s = passRound(s);
    expect(s.characters['xiaoyu']?.ap).toBe(3);
    expect(isBerserk(s)).toBe(false);
  });

  it('TC-ER-002 E=3 中度：常规 AP 3→2【§6.4】【L169】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
    });
    s = passRound(s);
    expect(s.characters['xiaoyu']?.ap).toBe(2);
  });

  it('TC-ER-003 决战中度侵蚀：AP 2→1【§6.4】【裁A-25】', () => {
    let s = toBattle(freshGame(), (d) => {
      d.characters['xiaoyu']!.erosion = 3;
    });
    const events: GameEvent[] = [];
    startTurn(s, events, 'xiaoyu');
    expect(s.characters['xiaoyu']?.ap).toBe(1);
  });

  it('TC-ER-004 E=4 失控：无法任何主动行动（含羁绊卡/装备主动）【§6.4】【L170】【裁A-24】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    s = giveTurn(s, 'xiaoyu');
    expect(isBerserk(s)).toBe(true);
    expect(() => applyCommand(s, { type: 'search', character: 'xiaoyu' })).toThrow(/失控/);
    expect(() => applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'dark_valley' })).toThrow(/失控/);
    expect(() =>
      applyCommand(s, { type: 'scene_action', character: 'xiaoyu', action: 'tree_heal' }),
    ).toThrow(/失控/);
    // 羁绊卡主动：失控小鱼不可发动（羁-02 仅莉雅可单方发动）
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-02'))!.cardUid!;
    expect(() => applyCommand(s, { type: 'bond_active', character: 'xiaoyu', bondUid })).toThrow(/失控|不可/);
    // 装备主动
    let s2 = setErosion(freshGame(), 4);
    s2 = mut(s2, (d) => {
      d.currentTurn = { character: 'xiaoyu' };
      d.characters['xiaoyu']!.equipment.push(d.equipmentDisplay.shift()!);
    });
    const eqUid = s2.characters['xiaoyu']!.equipment[0]!;
    expect(() => applyCommand(s2, { type: 'equipment_active', character: 'xiaoyu', equipmentUid: eqUid })).toThrow(/失控/);
  });

  it('TC-ER-005 失控后 E 不再增加（硬上限 4）【§6.4】【L65, L170】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    // T1：参与清除【暗】卡
    s = putCrisis(s, 'crisis-02', 'ancient_battlefield');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'ancient_battlefield';
    });
    const uid = crisisIn(s, 'ancient_battlefield', 'crisis-02')[0]!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 3, 'xiaoyu');
    expect(s.characters['xiaoyu']?.erosion).toBe(4);
  });

  it('TC-ER-006 失控 AoE：每回合结束对所在场景所有危机卡与所有友方各 1 点【§6.4】【L170】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    s = putCrisis(s, 'crisis-01', 'human_city');
    s = putCrisis(s, 'crisis-01', 'human_city');
    const [u1, u2] = crisisIn(s, 'human_city', 'crisis-01');
    const events: GameEvent[] = [];
    berserkAoE(s, events);
    expect(s.scenes['human_city'].crisisDamage[u1!]).toBe(1);
    expect(s.scenes['human_city'].crisisDamage[u2!]).toBe(1);
    expect(s.characters['baye']?.hp).toBe(4); // 同场景友方
    expect(s.characters['xiaoyu']?.hp).toBe(4); // "友方角色"含自己【L298】
    expect(s.characters['liya']?.hp).toBe(5); // 异场景不伤
  });

  it('TC-ER-007 失控 AoE 固定 1：屠龙者之血不加成【§6.4】【裁A-12】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    s = putCrisis(s, 'crisis-10', 'human_city'); // 危机度 6，观察固定 1 点
    const uid = crisisIn(s, 'human_city', 'crisis-10')[0]!;
    const events: GameEvent[] = [];
    berserkAoE(s, events);
    expect(s.scenes['human_city'].crisisDamage[uid]).toBe(1); // 非 2（屠龙者不加）
  });

  it('TC-ER-008 失控伤害与危机轮末独立、AoE 清【暗】卡不给小鱼加侵蚀【§6.4】【裁A-24】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    s = putCrisis(s, 'crisis-02', 'human_city'); // 【暗】
    s = mut(s, (d) => {
      const uid = d.scenes['human_city'].crisisCards.find((u) => d.cards[u]?.defId === 'crisis-02')!;
      d.scenes['human_city'].crisisDamage[uid] = 3; // AoE 1 点即清除（danger=4，总 3+1=4）
    });
    const uid = crisisIn(s, 'human_city', 'crisis-02')[0]!;
    const events: GameEvent[] = [];
    berserkAoE(s, events);
    expect(s.scenes['human_city'].crisisCards).not.toContain(uid); // 已清除
    expect(s.characters['xiaoyu']?.erosion).toBe(4); // 不加侵蚀（失控伤害独立）
    const cleared = events.find((e) => e.kind === 'crisis_cleared');
    expect(cleared && 'participants' in cleared ? cleared.participants : ['x']).toEqual([]);
  });

  it('TC-ER-009 失控伤害清除：小鱼与友方均不算参与、不获材料【§6.4】【L170】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    s = putCrisis(s, 'crisis-05', 'human_city');
    s = mut(s, (d) => {
      const uid = d.scenes['human_city'].crisisCards.find((u) => d.cards[u]?.defId === 'crisis-05')!;
      d.scenes['human_city'].crisisDamage[uid] = 3;
      d.crisisDamageLog[uid] = ['liya', 'baye']; // 此前莉雅/巴爷造成过伤害
    });
    const matL = s.characters['liya']!.materialTokens;
    const matB = s.characters['baye']!.materialTokens;
    const events: GameEvent[] = [];
    berserkAoE(s, events);
    expect(events.some((e) => e.kind === 'crisis_cleared')).toBe(true);
    expect(events.filter((e) => e.kind === 'material_gained')).toHaveLength(0);
    expect(s.characters['liya']?.materialTokens).toBe(matL);
    expect(s.characters['baye']?.materialTokens).toBe(matB);
  });

  it('TC-ER-010 失控被动客体化白名单【§6.4】【裁A-24】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    // a) 可被移动（凯-03 战术转移）
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-03');
    s = mut(s, (d) => {
      d.characters['kaier']!.scene = 'human_city';
    });
    s = playPassCopy(s, 'kaier', 'kai-03', { characters: ['xiaoyu'], scene: 'ancient_battlefield' });
    expect(s.characters['xiaoyu']?.scene).toBe('ancient_battlefield');
    // b) 可被治疗（雅-04）
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.hp = 2;
    });
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-04');
    s = playPassCopy(s, 'liya', 'ya-04', { characters: ['xiaoyu'] });
    expect(s.characters['xiaoyu']?.hp).toBe(4);
    expect(s.characters['xiaoyu']?.erosion).toBe(3); // 雅-04 对失控小鱼额外 -1
    // c) 可被援护/代受（决战友护 buff 直接摆）
    // d) 可被传书（暂存不翻开，见 TC-LT-005）
    // e) 羁-02 莉雅单方发动
    let e = freshGame();
    e = setErosion(e, 4);
    e = giveTurn(e, 'liya');
    const bondUid = e.bonds.find((b) => b.cardUid?.startsWith('bond-02'))!.cardUid!;
    e = applyCommand(e, { type: 'bond_active', character: 'liya', bondUid }).state;
    expect(e.characters['xiaoyu']?.erosion).toBe(3);
    // f) P4 手牌检查照常：失控小鱼手牌 6 → P4② 弃至 5
    let f = freshGame();
    f = setErosion(f, 4);
    f = mut(f, (d) => {
      const x = d.characters['xiaoyu']!;
      x.hand.push(x.deck.shift()!, x.deck.shift()!); // 手牌 6
    });
    f = passRound(f);
    expect(f.characters['xiaoyu']?.hand.length).toBe(5);
  });

  it('TC-ER-011 脱离失控：E≤3 即脱离；再失控计数重计【§6.4】【L172】【裁A-43】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    expect(isBerserk(s)).toBe(true);
    expect(s.flags.berserkCountdown).toBe(0);
    s = bumpErosion(s, -1); // 4→3 即脱离
    expect(isBerserk(s)).toBe(false);
    expect(s.flags.berserkCountdown).toBeNull();
    // 再次失控：计数从 0 重计
    s = bumpErosion(s, 1);
    expect(isBerserk(s)).toBe(true);
    expect(s.flags.berserkCountdown).toBe(0);
  });

  it('TC-ER-012 失控倒计时：进入=0；TURN_START +1；第 3 次 → F4【§6.4】【裁A-07】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    expect(s.flags.berserkCountdown).toBe(0);
    s = passRound(s); // 第 1 次 TURN_START → 1，不判
    expect(s.flags.berserkCountdown).toBe(1);
    expect(s.result).toBeNull();
    s = passRound(s); // 第 2 次 → 2，不判
    expect(s.flags.berserkCountdown).toBe(2);
    expect(s.result).toBeNull();
    s = passRound(s); // 第 3 次 → F4
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F4');
  });

  it('TC-ER-013 失控倒计时贯穿决战【§6.4】【裁A-37】', () => {
    let s = toBattle(freshGame(), (d) => {
      d.characters['xiaoyu']!.erosion = 4;
      d.flags.berserkCountdown = 2; // 常规局已计 2 次
    });
    const events: GameEvent[] = [];
    startTurn(s, events, 'xiaoyu'); // 决战中第 3 次
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F4');
  });

  it('TC-ER-014 E+1 触发源全枚举 T1-T5；T5 按事件计【§6.4】【L214】【裁A-35】', () => {
    // T1 参与清除【暗】卡（见 TC-CR-019）/ T3 鱼-05 / T4 危-04 轮末 / T2 【暗】效果伤害 / T5 决战人类反击
    // T3：鱼-05 结算后自放 1
    let t3 = freshGame();
    t3 = putCrisis(t3, 'crisis-10', 'human_city');
    t3 = ensureCard(t3, 'xiaoyu', 'yu-05');
    t3 = playCardById(t3, 'xiaoyu', 'yu-05', { crisisUids: [crisisIn(t3, 'human_city', 'crisis-10')[0]!] });
    expect(t3.characters['xiaoyu']?.erosion).toBe(1);
    // T4：危-04 轮末小鱼在场
    let t4 = freshGame();
    t4 = putCrisis(t4, 'crisis-04', 'human_city');
    t4 = passRound(t4);
    expect(t4.characters['xiaoyu']?.erosion).toBe(1);
    // T2：危-02 轮末【暗】伤害（见 TC-CR-010）；此处直接对小鱼造成黑暗伤害
    let t2 = freshGame();
    t2 = mut(t2, (d) => {
      const events: GameEvent[] = [];
      dealDamageToCharacter(d, events, {
        target: 'xiaoyu',
        damage: { base: 2, chain: [], source: 'crisis:crisis-02', dark: true, fromAttackCard: false },
      });
      d.log.push(...events);
    });
    expect(t2.characters['xiaoyu']?.erosion).toBe(1); // 一次事件 +1（虽 2 点伤害）
    // T5：决战 P2 人类反击（宝玉侵蚀下实受 2 点，仍 +1）
    let t5 = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    t5 = mut(t5, (d) => {
      d.boss!.hp = 15;
      d.boss!.maxHp = 15; // 保持 P2 不转阶段（12 > floor(15/2)=7）
    });
    const ev5: GameEvent[] = [];
    dealDamageToBoss(t5, ev5, 3, 'xiaoyu', true);
    expect(t5.characters['xiaoyu']?.hp).toBe(3); // 反击 1+宝玉侵蚀 1=2
    expect(t5.characters['xiaoyu']?.erosion).toBe(1); // 按事件 +1
  });

  it('TC-ER-015 E 减少源全枚举 R1-R7【§6.4】【L116】', () => {
    // R1 鱼-06（≤2）
    let r1 = freshGame();
    r1 = mut(r1, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
    });
    r1 = ensureCard(r1, 'xiaoyu', 'yu-06');
    r1 = playCardById(r1, 'xiaoyu', 'yu-06');
    expect(r1.characters['xiaoyu']?.erosion).toBe(1);
    // R2 鱼-09（1）
    let r2 = freshGame();
    r2 = mut(r2, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
      d.characters['liya']!.scene = 'human_city';
    });
    r2 = ensureCard(r2, 'xiaoyu', 'yu-09');
    r2 = playCardById(r2, 'xiaoyu', 'yu-09');
    expect(r2.characters['xiaoyu']?.erosion).toBe(2);
    // R3 雅-04（目标失控小鱼 1）
    let r3 = freshGame();
    r3 = setErosion(r3, 4);
    r3 = giveTurn(r3, 'liya');
    r3 = ensureCard(r3, 'liya', 'ya-04');
    r3 = playPassCopy(r3, 'liya', 'ya-04', { characters: ['xiaoyu'] });
    expect(r3.characters['xiaoyu']?.erosion).toBe(3);
    // R4 雅-05（清空）
    let r4 = freshGame();
    r4 = mut(r4, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
    });
    r4 = giveTurn(r4, 'liya');
    r4 = ensureCard(r4, 'liya', 'ya-05');
    r4 = mut(r4, (d) => {
      d.characters['liya']!.scene = 'human_city';
    });
    r4 = playPassCopy(r4, 'liya', 'ya-05');
    expect(r4.characters['xiaoyu']?.erosion).toBe(0);
    // R5 传书接收改 -1（见 TC-LT-007）/ R6 传-01 额外 -1（见 TC-LT-011）
    // R7 羁-02（≤3）
    let r7 = freshGame();
    r7 = setErosion(r7, 4);
    r7 = giveTurn(r7, 'liya');
    const bondUid = r7.bonds.find((b) => b.cardUid?.startsWith('bond-02'))!.cardUid!;
    r7 = applyCommand(r7, { type: 'bond_active', character: 'liya', bondUid }).state;
    expect(r7.characters['xiaoyu']?.erosion).toBe(3);
  });

  it('TC-ER-016 羁-02 莉雅代受黑暗伤害后小鱼不放侵蚀【§6.4】【§9.6】【裁A-29】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'liya', 'bond-02', { replaced: true });
    s = mut(s, (d) => {
      d.characters['kaier']!.scene = 'dark_valley'; // 排除公爵威严干扰，直观察代受数值
    });
    const d = structuredClone(s);
    const events: GameEvent[] = [];
    dealDamageToCharacter(d, events, {
      target: 'xiaoyu',
      damage: { base: 2, chain: [], source: 'boss_counter', dark: true, fromAttackCard: false },
    });
    expect(d.pendingDecision?.kind).toBe('choose_option'); // 莉雅代受询问
    const r = applyCommand(d, { type: 'resolve_decision', decisionId: d.pendingDecision!.id, choice: { option: 'intercept' } });
    expect(r.state.characters['liya']?.hp).toBe(3); // 莉雅代受 2
    expect(r.state.characters['xiaoyu']?.hp).toBe(5);
    expect(r.state.characters['xiaoyu']?.erosion).toBe(0); // 不放侵蚀
  });
});

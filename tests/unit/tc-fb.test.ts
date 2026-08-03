/**
 * TC-FB 最终决战 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import { dealDamageToBoss } from '../../engine/src/systems/combat.js';
import { runBossAction } from '../../engine/src/systems/boss.js';
import { startTurn } from '../../engine/src/phases.js';
import {
  answer,
  cfg1,
  cfg2,
  cfg3,
  cfg4,
  clearCrises,
  ensureCard,
  evs,
  freshGame,
  giveEquipment,
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
  sustain,
  toBattle,
} from '../helpers/regression-utils.js';
import type { CharacterId, GameEvent, GameState } from '../../engine/src/types.js';

function giveTurn(s: GameState, c: CharacterId, ap = 2): GameState {
  return mut(s, (d) => {
    d.currentTurn = { character: c };
    d.characters[c]!.ap = ap;
  });
}

/** 摆 boss 阶段（护盾清零、指定阶段） */
function bossStage(s: GameState, stage: 1 | 2 | 3, hp?: number): GameState {
  return mut(s, (d) => {
    d.boss!.shield = 0;
    d.boss!.stage = stage;
    if (hp !== undefined) d.boss!.hp = hp;
  });
}

function bossHit(s: GameState, amount: number, by: CharacterId, fromCard = true): GameState {
  const d = structuredClone(s);
  const events: GameEvent[] = [];
  dealDamageToBoss(d, events, amount, by, fromCard);
  d.log.push(...events);
  return d;
}

describe('TC-FB 最终决战', () => {
  it('TC-FB-001 BATTLE_PREP 触发于 R9 P4 结束后【§7.1】【L159】', () => {
    let s = freshGame();
    for (let r = 0; r < 9 && s.phase.kind !== 'final_battle'; r++) {
      s = passRound(s);
      s = sustain(s);
    }
    expect(s.phase.kind).toBe('final_battle');
    expect(s.boss?.round).toBe(1);
    expect(s.currentTurn?.character).toBe('xiaoyu');
    expect(s.characters['xiaoyu']?.ap).toBe(2); // 决战 2 AP
  });

  it('TC-FB-002 强制召唤黑暗山谷；出局不复活【§7.1】【L187】【裁A-06】', () => {
    const s = toBattle(freshGame(), (d) => {
      d.characters['xiaoyu']!.scene = 'human_city';
      d.characters['liya']!.scene = 'elf_kingdom';
      d.characters['baye']!.alive = false;
    });
    expect(s.characters['xiaoyu']?.scene).toBe('dark_valley');
    expect(s.characters['liya']?.scene).toBe('dark_valley');
    expect(s.characters['kaier']?.scene).toBe('dark_valley');
    expect(s.characters['baye']?.alive).toBe(false);
  });

  it('TC-FB-003 弃置所有场景残留危机卡【§7.1】【L189】', () => {
    let base = freshGame();
    base = putCrisis(base, 'crisis-01', 'human_city');
    base = putCrisis(base, 'crisis-02', 'ancient_battlefield');
    const s = toBattle(base);
    const total = Object.values(s.scenes).reduce((n, sc) => n + sc.crisisCards.length, 0);
    expect(total).toBe(0);
  });

  it('TC-FB-004 玫拉初始生命=26（4P）+危-10 +2+献祭各 +3（上限 34）【§7.1】【L427-428】【裁A-15】', () => {
    const a = toBattle(freshGame(), (d) => {
      d.flags.avatarCleared = true;
    });
    expect(a.boss?.maxHp).toBe(26);
    const b = toBattle(freshGame(), (d) => {
      d.flags.sacrifice = { 'crisis-09#0': 3 };
    });
    expect(b.boss?.maxHp).toBe(26 + 2 + 3); // 危-10 未清 +2、一张献祭 3
    const c = toBattle(freshGame(), (d) => {
      d.flags.sacrifice = { 'crisis-09#0': 3, 'crisis-09#1': 3 };
    });
    expect(c.boss?.maxHp).toBe(34); // 26+2+6
  });

  it('TC-FB-005 3P/2P/1P 玫拉=22/20/18/护盾 9【§7.1】【裁A-01】', () => {
    const s3 = toBattle(freshGame(cfg3), (d) => { d.flags.avatarCleared = true; });
    expect(s3.boss?.maxHp).toBe(22);
    expect(s3.boss?.shield).toBe(9);
    const s2 = toBattle(freshGame(cfg2), (d) => { d.flags.avatarCleared = true; });
    expect(s2.boss?.maxHp).toBe(20);
    expect(s2.boss?.shield).toBe(9);
    const s1 = toBattle(freshGame(cfg1), (d) => { d.flags.avatarCleared = true; });
    expect(s1.boss?.maxHp).toBe(18);
    expect(s1.boss?.shield).toBe(9);
  });

  it('TC-FB-006 女王获救 → 跳过首领 P1 直接 P2 + 存活角色回 2【§7.1】【L132, L209, L271】', () => {
    const s = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
      d.characters['liya']!.hp = 1;
      d.characters['baye']!.alive = false; // 出局不回
    });
    expect(s.boss?.stage).toBe(2);
    expect(s.boss?.shield).toBe(0);
    expect(s.characters['liya']?.hp).toBe(3);
  });

  it('TC-FB-007 护盾总池结算、层间溢出结转【§7.3】【L209】【裁A-11】', () => {
    let s = toBattle(freshGame()); // 护盾 12
    s = bossHit(s, 5, 'xiaoyu');
    expect(s.boss?.shield).toBe(7); // 总池扣 5（不受"每层 4"截断）
    expect(s.boss?.hp).toBe(s.boss?.maxHp); // 本体未伤
  });

  it('TC-FB-008 护盾存在期间对玫拉本体一切伤害无效【§7.3】【L209】', () => {
    let s = toBattle(freshGame());
    const hp0 = s.boss!.hp;
    s = bossHit(s, 99, 'xiaoyu'); // 巨量也全被护盾吸收
    expect(s.boss?.hp).toBe(hp0);
    expect(s.boss?.shield).toBe(0); // 12 全部吸收（溢出结转见 TC-FB-010）
  });

  it('TC-FB-009 P1 玫拉行动：暗影箭对生命最低者 1 点；并列者各 1 点【§7.3】【L210】【§7.4】【裁A-46】', () => {
    // a) 唯一最低
    let a = toBattle(freshGame());
    a = mut(a, (d) => {
      d.characters['liya']!.hp = 2;
      d.characters['kaier']!.scene = 'dark_valley'; // 决战同场景（公爵威严 -1 → 2-1=1? 此处验证暗影箭数值）
    });
    const eventsA: GameEvent[] = [];
    runBossAction(a, eventsA);
    a.log.push(...eventsA);
    expect(a.characters['liya']?.hp).toBe(2); // 1 点被公爵威严 -1 → 0？凯尔同场景 → 1-1=0
    // b)【裁A-46】并列最低 → 所有并列者各 1 点
    let b = toBattle(freshGame());
    b = mut(b, (d) => {
      d.characters['xiaoyu']!.hp = 2;
      d.characters['baye']!.hp = 2;
      d.characters['liya']!.hp = 4;
    });
    const eventsB: GameEvent[] = [];
    runBossAction(b, eventsB);
    b.log.push(...eventsB);
    expect(b.characters['xiaoyu']?.hp).toBe(1);
    expect(b.characters['baye']?.hp).toBe(1);
    expect(b.characters['liya']?.hp).toBe(4);
  });

  it('TC-FB-010 护盾清零 → 即时进 P2 + 存活角色回 2；溢出不扣本体【§7.3】【L211】', () => {
    let s = toBattle(freshGame());
    s = mut(s, (d) => {
      d.boss!.shield = 3;
      d.characters['liya']!.hp = 1;
    });
    const hp0 = s.boss!.hp;
    s = bossHit(s, 4, 'xiaoyu'); // 溢出 1
    expect(s.boss?.shield).toBe(0);
    expect(s.boss?.stage).toBe(2);
    expect(s.boss?.hp).toBe(hp0); // 溢出不按本体结算
    expect(s.characters['liya']?.hp).toBe(3); // 转换回 2
  });

  it('TC-FB-011 P2 反击人类：1 点黑暗伤害、宝玉侵蚀 +1 实为 2；小鱼受此 E+1（按事件）【§7.3】【L213-215】【裁A-35】', () => {
    let s = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    s = bossHit(s, 3, 'baye', true);
    expect(s.characters['baye']?.hp).toBe(3); // 5-2
    let s2 = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    s2 = bossHit(s2, 3, 'xiaoyu', true);
    expect(s2.characters['xiaoyu']?.hp).toBe(3);
    expect(s2.characters['xiaoyu']?.erosion).toBe(1); // 按事件 +1
  });

  it('TC-FB-012 P2 反击精灵：1 点伤害 + 弃 1 手牌【§7.3】【L215】', () => {
    let s = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    const hand0 = s.characters['liya']!.hand.length;
    const r = bossHit(s, 3, 'liya', true);
    // 公爵威严（凯尔同场景）减免 1 → 0；弃牌仍须
    const after = settle(r);
    expect(after.characters['liya']?.hand.length).toBe(hand0 - 1);
  });

  it('TC-FB-013 反击粒度：每张攻击卡一次；羁-01 合并按打出者种族计一次【§7.3】【裁A-35】', () => {
    // 两张攻击卡 → 两次反击
    let s = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    s = giveTurn(s, 'xiaoyu', 2);
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = playPassCopy(s, 'xiaoyu', 'yu-01');
    s = giveTurn(s, 'baye', 2);
    s = ensureCard(s, 'baye', 'ba-01');
    s = playPassCopy(s, 'baye', 'ba-01');
    expect(evs(s, 'counter_attack').length).toBe(2);
    // 非攻击卡来源不反击
    let b = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    b = bossHit(b, 3, 'xiaoyu', false);
    expect(evs(b, 'counter_attack').length).toBe(0);
    // 羁-01 合并口径见 TC-BD-020
  });

  it('TC-FB-014 P2 玫拉行动：本轮伤害最高者 2 点；并列各 1 点（窗口=本轮）【§7.3】【L216】【裁A-35】', () => {
    let a = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    a = mut(a, (d) => {
      d.boss!.damageThisRound = { xiaoyu: 7, liya: 3 };
      d.characters['xiaoyu']!.scene = 'dark_valley';
      d.characters['kaier']!.scene = 'elf_kingdom'; // 移除公爵威严干扰
    });
    const evA: GameEvent[] = [];
    runBossAction(a, evA);
    a.log.push(...evA);
    expect(a.characters['xiaoyu']?.hp).toBe(3); // 最高 2 点
    expect(a.characters['liya']?.hp).toBe(5);
    expect(a.boss?.damageThisRound).toEqual({}); // 窗口重置
    // 并列各 1
    let b = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    b = mut(b, (d) => {
      d.boss!.damageThisRound = { xiaoyu: 5, baye: 5 };
    });
    const evB: GameEvent[] = [];
    runBossAction(b, evB);
    b.log.push(...evB);
    expect(b.characters['xiaoyu']?.hp).toBe(4);
    expect(b.characters['baye']?.hp).toBe(4);
  });

  it('TC-FB-015 P2→P3 阈值：当前 ≤floor(max/2)（26→13、20→10）即时转换 + 存活回 1【§7.3】【L217】', () => {
    let a = toBattle(freshGame(), (d) => {
      d.flags.avatarCleared = true; // max=15
      d.flags.queenRescued = true;
    });
    a = mut(a, (d) => {
      d.boss!.hp = 8;
      d.characters['kaier']!.hp = 1;
    });
    a = bossHit(a, 1, 'xiaoyu'); // 8→7 ≤ 13
    expect(a.boss?.stage).toBe(3);
    expect(a.characters['kaier']?.hp).toBe(2); // 回 1
    let b = toBattle(freshGame(cfg2), (d) => {
      d.flags.avatarCleared = true;
      d.flags.queenRescued = true;
    });
    b = mut(b, (d) => {
      d.boss!.hp = 7;
    });
    b = bossHit(b, 1, 'xiaoyu'); // 7→6 ≤ 10（20 阈值）
    expect(b.boss?.stage).toBe(3);
  });

  it('TC-FB-016 转换当次攻击按转换前阶段完整结算、溢出不重算【§7.3】【裁A-34】', () => {
    let s = toBattle(freshGame(), (d) => {
      d.flags.avatarCleared = true; // max 26，阈值 13
      d.flags.queenRescued = true;
    });
    s = mut(s, (d) => {
      d.boss!.hp = 8;
    });
    s = bossHit(s, 5, 'xiaoyu'); // 全额 5 按 P2 结算 → 3；若按 P3 -1 重算则为 4
    expect(s.boss?.hp).toBe(3);
    expect(s.boss?.stage).toBe(3);
  });

  it('TC-FB-017 P3：玫拉受伤 -1 最低 1；宝玉侵蚀失效；轮末全员 2 点黑暗后回 1 不超最大值【§7.3】【L219-220】【裁A-34】', () => {
    // 减免在攻击效果链内（BOSS_P3 节点）：用真实打出驱动
    let s = toBattle(freshGame(), (d) => {
      d.flags.avatarCleared = true;
    });
    s = bossStage(s, 3, 10);
    s = giveTurn(s, 'baye', 2);
    s = ensureCard(s, 'baye', 'ba-07');
    s = playPassCopy(s, 'baye', 'ba-07'); // 基础 1 → P3 -1 → 钳 1
    expect(s.boss?.hp).toBe(9);
    s = giveTurn(s, 'xiaoyu', 2);
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = playPassCopy(s, 'xiaoyu', 'yu-01'); // 3+1(屠龙者)=4 → P3 -1 → 3
    expect(s.boss?.hp).toBe(6);
    // 轮末 AoE（2 黑暗，宝玉侵蚀已失效不加）+ 回 1（不超 max）
    s = mut(s, (d) => {
      d.boss!.hp = d.boss!.maxHp;
    });
    const ev: GameEvent[] = [];
    runBossAction(s, ev);
    s.log.push(...ev);
    expect(s.characters['xiaoyu']?.hp).toBe(3); // 2 点（无宝玉加成）
    expect(s.boss?.hp).toBe(s.boss?.maxHp); // 回 1 不超上限
  });

  it('TC-FB-018 宝玉侵蚀适用清单：仅 P2 人类反击 1→2；P1 暗影箭/P2 宝玉之力不加【§7.4】【L226】【裁A-35】', () => {
    // P1 暗影箭：非黑暗 → 固定 1（共鸣减）/不 +1
    let a = toBattle(freshGame());
    a = mut(a, (d) => {
      d.characters['baye']!.hp = 2;
      d.characters['xiaoyu']!.hp = 4;
    });
    const evA: GameEvent[] = [];
    runBossAction(a, evA);
    a.log.push(...evA);
    expect(a.characters['baye']?.hp).toBe(1); // 恰 1（无 +1）
    // P2 宝玉之力：非黑暗 → 2/1 不加（见 TC-FB-014）；P2 人类反击 = 2（见 TC-FB-011）
  });

  it('TC-FB-019 宝玉共鸣：莉雅 1 AP 放 ≤3；每个玫拉轮末效果 -1 最低 0；反击除外【§7.4】【L227】【裁A-36】', () => {
    let s = toBattle(freshGame(), (d) => {
      d.bonds = [{ pair: ['xiaoyu', 'liya'], status: 'active', cardUid: 'bond-01#0', replacedByBerserk: false, activeUsedRound: null }];
    });
    s = giveTurn(s, 'liya', 2);
    s = applyCommand(s, { type: 'gem_attune', character: 'liya' }).state;
    s = applyCommand(s, { type: 'gem_attune', character: 'liya' }).state;
    expect(s.boss?.gemPurify).toBe(2);
    // 上限 3
    s = mut(s, (d) => {
      d.boss!.gemPurify = 3;
      d.characters['liya']!.ap = 2;
    });
    expect(() => applyCommand(s, { type: 'gem_attune', character: 'liya' })).toThrow(/最多 3|限/);
    // P1 暗影箭 1-3 → 0（最低 0）
    let a = toBattle(freshGame());
    a = mut(a, (d) => {
      d.boss!.gemPurify = 3;
      d.characters['baye']!.hp = 2;
      d.characters['xiaoyu']!.hp = 4;
    });
    const evA: GameEvent[] = [];
    runBossAction(a, evA);
    a.log.push(...evA);
    expect(a.characters['baye']?.hp).toBe(2); // 0 伤
    // 反击（即时，非轮末）不减：P2 人类反击仍 2
    let b = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    b = mut(b, (d) => {
      d.boss!.gemPurify = 3;
    });
    b = bossHit(b, 3, 'baye', true);
    expect(b.characters['baye']?.hp).toBe(3); // 5-2（共鸣不减反击）
  });

  it('TC-FB-020 决战行动白名单：禁移动/锻造/传书；可打卡/搜索/羁绊/装备主动/治疗/援护/净化蓄能【§7.2】【L198-206】【裁A-10】', () => {
    let s = toBattle(freshGame());
    s = giveTurn(s, 'xiaoyu', 2);
    expect(() => applyCommand(s, { type: 'move', character: 'xiaoyu', to: 'human_city' })).toThrow(/决战/);
    expect(() =>
      applyCommand(s, { type: 'forge', character: 'xiaoyu', equipmentUid: s.equipmentDisplay[0]!, materialCardUids: [], useTokens: 0 }),
    ).toThrow(/决战/);
    expect(() => applyCommand(s, { type: 'send_letter', character: 'xiaoyu', cardUid: s.characters['xiaoyu']!.hand[0]! })).toThrow(/决战/);
    // 可用：搜索、打出、治疗、援护、净化蓄能
    s = applyCommand(s, { type: 'search', character: 'xiaoyu' }).state;
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.hp = 3;
      d.characters['xiaoyu']!.ap = 2;
    });
    const discardUid = s.characters['xiaoyu']!.hand[0]!;
    s = applyCommand(s, { type: 'heal', character: 'xiaoyu', discardUid, target: 'xiaoyu' }).state;
    expect(s.characters['xiaoyu']?.hp).toBe(5);
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.ap = 2;
    });
    s = applyCommand(s, { type: 'guard', character: 'xiaoyu', target: 'liya' }).state;
    expect(s.buffs.some((b) => b.kind === 'guard' && b.target === 'liya')).toBe(true);
    s = applyCommand(s, { type: 'purify_charge', character: 'xiaoyu' }).state;
    expect(s.characters['xiaoyu']?.purifyTokens).toBe(1);
  });

  it('TC-FB-021 凯-05 决战：仅 +2 伤、不翻危机卡【§7.2】【裁A-10】', () => {
    // 见 TC-CD-025 决战分支（同一断言）
    let b = toBattle(freshGame());
    b = giveTurn(b, 'kaier', 2);
    b = ensureCard(b, 'kaier', 'kai-05');
    b = playPassCopy(b, 'kaier', 'kai-05');
    expect(b.buffs.some((x) => x.source === 'kai-05' && x.value === 2)).toBe(true);
    expect(Object.values(b.scenes).reduce((n, sc) => n + sc.crisisCards.length, 0)).toBe(0);
  });

  it('TC-FB-022 P4′ 顺序：弃至 5 → 玫拉行动 → 计数 +1；>9 → F1【§7.2】【L194】', () => {
    let s = toBattle(freshGame());
    s = mut(s, (d) => {
      d.currentTurn = { character: 'xiaoyu' };
      d.characters['xiaoyu']!.ap = 2;
      const x = d.characters['xiaoyu']!;
      x.hand.push(x.deck.shift()!, x.deck.shift()!); // 手牌 6
      d.boss!.round = 9;
    });
    const before = s.log.length;
    s = passRound(s); // P4'：先弃至 5、再玫拉行动、再计数 → 10 → F1
    expect(s.characters['xiaoyu']?.hand.length).toBe(5);
    const slice = s.log.slice(before);
    const iDiscard = slice.findIndex((e) => e.kind === 'decision_required' && (e as { decision: { kind: string } }).decision.kind === 'choose_cards');
    const iBoss = slice.findIndex((e) => e.kind === 'boss_action');
    const iOver = slice.findIndex((e) => e.kind === 'game_over');
    expect(iDiscard).toBeGreaterThanOrEqual(0);
    expect(iBoss).toBeGreaterThan(iDiscard);
    expect(iOver).toBeGreaterThan(iBoss);
    expect(s.result?.reason).toContain('F1');
  });

  it('TC-FB-023 决战侵蚀照常、可失控且倒计时贯穿；生命宝玉决战不扣上限（一局 2 次共用）【§7.5】【L223, L276-277】【裁A-37】', () => {
    // 决战中失控倒计时照常判负（见 TC-ER-013）；雅-05 决战不扣上限（见 TC-CD-015）
    let s = toBattle(freshGame(), (d) => {
      d.characters['xiaoyu']!.erosion = 4;
      d.flags.berserkCountdown = 0;
    });
    const ev: GameEvent[] = [];
    startTurn(s, ev, 'xiaoyu');
    s.log.push(...ev);
    expect(s.flags.berserkCountdown).toBe(1); // 决战中照常计数
  });

  it('TC-FB-024 决战跳 P1/P3：BATTLE_LOOP 仅 P2′→P4′【§2.1】【§7.2】【裁A-10】', () => {
    let s = toBattle(freshGame());
    s = giveTurn(s, 'xiaoyu', 2);
    const before = s.log.length;
    s = passRound(s);
    const slice = s.log.slice(before);
    const kinds = slice.filter((e) => e.kind === 'phase_entered').map((e) => (e as { phase: string }).phase);
    expect(kinds).not.toContain('crisis');
    expect(kinds).not.toContain('prejudice');
    expect(slice.filter((e) => e.kind === 'crisis_flipped')).toHaveLength(0);
    expect(slice.filter((e) => e.kind === 'prejudice_flipped')).toHaveLength(0);
    expect(s.phase.kind).toBe('final_battle');
  });
});

/**
 * TC-WL 胜负判定与出局 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import { dealDamageToBoss } from '../../engine/src/systems/combat.js';
import { dealDamageToCharacter, eliminate } from '../../engine/src/systems/damage.js';
import {
  answer,
  cfg2,
  cfg4,
  clearCrises,
  evs,
  freshGame,
  mut,
  passRound,
  passTurn,
  putCrisisN,
  setErosion,
  sustain,
  toBattle,
} from '../helpers/regression-utils.js';
import type { CharacterId, GameEvent, GameState } from '../../engine/src/types.js';

function hit(s: GameState, target: CharacterId, base: number): GameState {
  const d = structuredClone(s);
  const events: GameEvent[] = [];
  dealDamageToCharacter(d, events, {
    target,
    damage: { base, chain: [], source: 'fixture', dark: false, fromAttackCard: false },
  });
  d.log.push(...events);
  return d;
}

describe('TC-WL 胜负判定与出局', () => {
  it('TC-WL-001 胜利：玫拉生命归零立即判胜【§2.3】【L6, L221】', () => {
    const s = toBattle(freshGame(), (d) => {
      d.flags.avatarCleared = true;
    });
    const draft = structuredClone(s);
    draft.boss!.shield = 0;
    draft.boss!.stage = 2;
    draft.boss!.hp = 2;
    const events: GameEvent[] = [];
    dealDamageToBoss(draft, events, 2, 'xiaoyu', true);
    expect(draft.result?.outcome).toBe('victory');
    expect(events.some((e) => e.kind === 'game_over')).toBe(true);
  });

  it('TC-WL-002 F1：打完第 9 决战轮未胜 → 判负（第 8 轮末不判）【§2.3】【L194】【§7.2】', () => {
    let s = toBattle(freshGame());
    s = mut(s, (d) => {
      d.currentTurn = { character: 'xiaoyu' };
      d.characters['xiaoyu']!.ap = 2;
      d.boss!.round = 8;
    });
    s = passRound(s); // 第 8 轮 → 计数 9，不判
    expect(s.result).toBeNull();
    expect(s.boss?.round).toBe(9);
    s = passRound(s); // 第 9 轮 → 计数 10 → F1
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F1');
  });

  it('TC-WL-003 F2：P4③ 任意场景危机卡 ≥4（4P）判负；=3 不判【§2.3】【L157】', () => {
    let s = freshGame();
    s = clearCrises(s);
    s = putCrisisN(s, 'crisis-01', 'elf_kingdom', 4);
    s = passRound(s);
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F2');
    let s2 = freshGame();
    s2 = clearCrises(s2);
    s2 = putCrisisN(s2, 'crisis-01', 'elf_kingdom', 3);
    s2 = passRound(s2);
    expect(s2.result).toBeNull();
  });

  it('TC-WL-004 F2 阈值变体：2P/1P=5（=4 不判）【§3.1】【裁A-19】', () => {
    let a = freshGame(cfg2);
    a = clearCrises(a);
    a = putCrisisN(a, 'crisis-01', 'elf_kingdom', 4);
    a = passRound(a);
    expect(a.result).toBeNull();
    let b = freshGame(cfg2);
    b = clearCrises(b);
    b = putCrisisN(b, 'crisis-01', 'elf_kingdom', 5);
    b = passRound(b);
    expect(b.result?.outcome).toBe('defeat');
    expect(b.result?.reason).toContain('F2');
  });

  it('TC-WL-005 F3：全员出局即时判负（持续检查，不等相位）【§2.3】【L10】【裁A-06】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.alive = false;
      d.characters['kaier']!.alive = false;
      d.characters['baye']!.alive = false;
      d.characters['liya']!.hp = 1;
    });
    // 伤害结算完毕即时判负（不经任何相位边界）
    s = hit(s, 'liya', 1);
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F3');
  });

  it('TC-WL-006 出局即终态：不占场景、不可被选为目标【§1.3】【裁A-06】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['kaier']!.hp = 1;
    });
    const events: GameEvent[] = [];
    const draft = structuredClone(s);
    eliminate(draft, events, 'kaier');
    expect(events.some((e) => e.kind === 'character_eliminated')).toBe(true);
    expect(draft.characters['kaier']?.alive).toBe(false);
    // 不可被选为伤害目标（直接调用亦静默跳过）
    const draft2 = structuredClone(draft);
    const ev2: GameEvent[] = [];
    dealDamageToCharacter(draft2, ev2, {
      target: 'kaier',
      damage: { base: 3, chain: [], source: 't', dark: false, fromAttackCard: false },
    });
    expect(ev2.filter((e) => e.kind === 'character_damaged')).toHaveLength(0);
  });

  it('TC-WL-007 出局角色不参与偏见检查与危机目标选择【§1.3】【裁A-06】', () => {
    // 巴爷出局后，人类王城仅剩小鱼（人类）→ 无触发对；P3 不翻卡
    let s = freshGame();
    s = clearCrises(s);
    s = mut(s, (d) => {
      d.characters['baye']!.alive = false;
      d.characters['liya']!.scene = 'human_city'; // 小鱼×莉雅 永不触发；若巴爷活则有 巴×莉
    });
    const before = s.log.length;
    s = passRound(s);
    const prej = s.log.slice(before).filter((e) => e.kind === 'prejudice_flipped');
    expect(prej).toHaveLength(0);
    // 轮末"一名角色"候选不含出局者（危-02 在精灵王国：凯尔出局 → 仅莉雅可选、自动命中）
    let s2 = freshGame();
    s2 = clearCrises(s2);
    s2 = mut(s2, (d) => {
      d.characters['kaier']!.alive = false;
    });
    s2 = putCrisisN(s2, 'crisis-02', 'elf_kingdom', 1);
    s2 = passTurn(s2); // 小鱼
    s2 = passTurn(s2); // 莉雅（凯尔出局跳过）
    s2 = applyCommand(s2, { type: 'end_turn', character: 'baye' }).state;
    // 精灵王国仅莉雅存活 → 自动命中、无选择决策；凯尔出局 → 公爵威严不存在 → 莉雅实受 1
    expect(s2.pendingDecision?.kind ?? 'none').not.toBe('choose_character');
    expect(s2.characters['liya']?.hp).toBe(4);
  });

  it('TC-WL-008 出局后：涉及双方羁绊卡不可用、向其传书不可发起【§1.3】【裁A-06】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['liya']!.alive = false;
    });
    // 传书不可发起（双方须均存活）
    const uid = s.characters['xiaoyu']!.hand[0]!;
    expect(() => applyCommand(s, { type: 'send_letter', character: 'xiaoyu', cardUid: uid })).toThrow(/存活/);
    // 涉及出局者的羁绊卡效果不可用：羁-07（凯尔×莉雅）主动应被拒绝
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-07'))!.cardUid!;
    s = mut(s, (d) => {
      d.currentTurn = { character: 'kaier' };
      d.characters['kaier']!.ap = 3;
    });
    expect(() => applyCommand(s, { type: 'bond_active', character: 'kaier', bondUid })).toThrow(/出局|不可用/);
  });

  it('TC-WL-009 F4：失控后第 3 次 TURN_START 仍失控 → 立即失败【§2.3】【L11】【裁A-07】', () => {
    let s = freshGame();
    s = setErosion(s, 4); // 经钩子：倒计时=0、羁-02 替换
    expect(s.flags.berserkCountdown).toBe(0);
    // 当前是小鱼回合（已开始，不计）；过 3 个完整轮 → 第 3 次 TURN_START 判负
    for (let i = 0; i < 3 && !s.result; i++) {
      s = passRound(s);
    }
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F4');
  });

  it('TC-WL-010 BATTLE_PREP 出局角色不复活【§7.1】【裁A-06】', () => {
    const s = toBattle(freshGame(), (d) => {
      d.characters['baye']!.alive = false;
    });
    expect(s.characters['baye']?.alive).toBe(false);
    expect(s.characters['baye']?.scene).not.toBe('dark_valley');
    expect(s.characters['xiaoyu']?.scene).toBe('dark_valley');
  });
});

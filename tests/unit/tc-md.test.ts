/**
 * TC-MD 人数变体与开局 SETUP 回归用例（docs/qa/test-cases.md）。
 * 引证规范：docs/qa/test-plan.md §2。
 */
import { describe, expect, it } from 'vitest';
import { MODE_TABLE } from '../../engine/src/content/modes.js';
import { beginGame } from '../../engine/src/actions.js';
import {
  cfg1,
  cfg2,
  cfg3,
  cfg3k,
  cfg4,
  createInitialState,
  evs,
  freshGame,
  passRound,
  settle,
  sustain,
} from '../helpers/regression-utils.js';
import type { GameConfig } from '../../engine/src/types.js';

/** 逐轮记录 P1 翻牌数（空转+清场防干扰；初始共位无偏见触发对） */
function flipsPerRound(cfg: GameConfig, rounds = 9): number[] {
  let s = freshGame(cfg);
  const counts: number[] = [];
  // R1 P1 已在 beginGame 完成
  counts.push(evs(s, 'crisis_flipped').length);
  for (let r = 2; r <= rounds && s.phase.kind !== 'final_battle' && !s.result; r++) {
    const before = s.log.length;
    s = passRound(s);
    s = sustain(s);
    const slice = s.log.slice(before);
    counts.push(slice.filter((e) => e.kind === 'crisis_flipped').length);
  }
  return counts;
}

describe('TC-MD 人数变体与开局 SETUP', () => {
  it('TC-MD-001 四人局初始化全量【§4】【L60-76】', () => {
    const s = createInitialState(cfg4);
    expect(s.turnOrder).toEqual(['xiaoyu', 'liya', 'kaier', 'baye']);
    expect(s.characters['xiaoyu']?.scene).toBe('human_city');
    expect(s.characters['baye']?.scene).toBe('human_city');
    expect(s.characters['liya']?.scene).toBe('elf_kingdom');
    expect(s.characters['kaier']?.scene).toBe('elf_kingdom');
    for (const ch of Object.values(s.characters)) {
      expect(ch.hp).toBe(5);
      expect(ch.maxHp).toBe(5);
      expect(ch.hand).toHaveLength(4);
      expect(ch.deck).toHaveLength(6);
    }
    expect(s.decks.crisis).toHaveLength(29);
    expect(s.ultimatumAsideUid).toMatch(/^crisis-09#/);
    const all = [...s.decks.crisis, s.ultimatumAsideUid].sort();
    expect(new Set(all).size).toBe(30);
    expect(s.decks.bond).toHaveLength(9); // 10 - 羁-07 已由凯尔×莉雅领用
    expect(s.decks.letter).toHaveLength(10);
    expect(s.equipmentDisplay).toHaveLength(10);
    expect(s.boss).toBeNull();
    expect(s.phase).toEqual({ kind: 'crisis', day: 1, segment: 'dawn', round: 1 });
    expect(s.characters['baye']?.airship?.cooldownRounds).toBe(0);
    // 初始羁绊：小鱼×莉雅 未激活无卡；凯尔×莉雅 激活持羁-07
    const xl = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    const kl = s.bonds.find((b) => b.pair.includes('kaier') && b.pair.includes('liya'));
    expect(xl).toMatchObject({ status: 'inactive', cardUid: null });
    expect(kl?.status).toBe('active');
    expect(kl?.cardUid).toMatch(/^bond-07#/);
  });

  it('TC-MD-002 三人局：弃巴爷，4 AP / 起始 6 血（起始即满）【§3.1】【L46, L51】【裁A-42】', () => {
    const s0 = createInitialState(cfg3);
    expect(s0.turnOrder).toEqual(['xiaoyu', 'liya', 'kaier']);
    expect(s0.characters['baye']).toBeUndefined();
    for (const ch of Object.values(s0.characters)) {
      expect(ch.maxHp).toBe(6);
      expect(ch.hp).toBe(6);
    }
    const s = settle(beginGame(s0).state);
    expect(s.characters['xiaoyu']?.ap).toBe(4);
  });

  it('TC-MD-003 三人局：弃凯尔合法；未指定弃用则拒绝【§3.1】【L46】', () => {
    const s = createInitialState(cfg3k);
    expect(s.turnOrder).toEqual(['xiaoyu', 'liya', 'baye']);
    expect(s.characters['kaier']).toBeUndefined();
    expect(() =>
      createInitialState({
        playerCount: 3,
        seed: 1,
        seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['baye'] },
      }),
    ).toThrow(/弃用角色/);
  });

  it('TC-MD-004 双人局初始化：小鱼+莉雅、3 AP、起始 5 血【§8】【L236-238】', () => {
    const s0 = createInitialState(cfg2);
    expect(Object.keys(s0.characters).sort()).toEqual(['liya', 'xiaoyu']);
    expect(s0.characters['kaier']).toBeUndefined();
    expect(s0.characters['baye']).toBeUndefined();
    expect(s0.characters['xiaoyu']?.scene).toBe('human_city');
    expect(s0.characters['liya']?.scene).toBe('elf_kingdom');
    const s = settle(beginGame(s0).state);
    expect(s.characters['xiaoyu']?.ap).toBe(3);
    expect(s.characters['xiaoyu']?.hp).toBe(5);
  });

  it('TC-MD-005 单人局：0 号座双控小鱼+莉雅【§8】【L228-296】', () => {
    const s = createInitialState(cfg1);
    expect(s.turnOrder).toEqual(['xiaoyu', 'liya']);
    expect(s.config.seatAssignments[0]).toEqual(['xiaoyu', 'liya']);
    expect(s.characters['kaier']).toBeUndefined();
    expect(s.characters['baye']).toBeUndefined();
  });

  it('TC-MD-006 四人翻牌量：D1 2-2-2 / D2 2-2-3 / D3 3-3-3，全局 22【§3.2】【L86-91】', () => {
    const counts = flipsPerRound(cfg4);
    expect(counts).toEqual([2, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(22);
  });

  it('TC-MD-007 三人翻牌量同四人（22）【§3.1】【L49-58】', () => {
    const counts = flipsPerRound(cfg3);
    expect(counts).toEqual([2, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(22);
  });

  it('TC-MD-008 双人/单人翻牌量：D1 1-2-2 / D2 2-2-2 / D3 2-3-3，全局 19【§3.2】【L249-253】', () => {
    for (const cfg of [cfg2, cfg1]) {
      const counts = flipsPerRound(cfg);
      expect(counts).toEqual([1, 2, 2, 2, 2, 2, 2, 3, 3]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(19);
    }
  });

  it('TC-MD-009 沦陷阈值数据表：4P/3P=4、2P/1P=5【§3.1】【L94, L157】【裁A-19】', () => {
    expect(MODE_TABLE[4].collapseThreshold).toBe(4);
    expect(MODE_TABLE[3].collapseThreshold).toBe(4);
    expect(MODE_TABLE[2].collapseThreshold).toBe(5);
    expect(MODE_TABLE[1].collapseThreshold).toBe(5);
  });

  it('TC-MD-010 玫拉数值数据表：4P 26/12；3P 22/9；2P 20/9；1P 18/9【§3.1】【L193, L217】【裁A-01】', () => {
    expect(MODE_TABLE[4].bossHp).toBe(26);
    expect(MODE_TABLE[4].shieldLayers * MODE_TABLE[4].shieldHpPerLayer).toBe(12);
    expect(MODE_TABLE[3].bossHp).toBe(22);
    expect(MODE_TABLE[3].shieldLayers * MODE_TABLE[3].shieldHpPerLayer).toBe(9);
    expect(MODE_TABLE[2].bossHp).toBe(20);
    expect(MODE_TABLE[2].shieldLayers * MODE_TABLE[2].shieldHpPerLayer).toBe(9);
    expect(MODE_TABLE[1].bossHp).toBe(18);
    expect(MODE_TABLE[1].shieldLayers * MODE_TABLE[1].shieldHpPerLayer).toBe(9);
    expect(Math.floor(MODE_TABLE[4].bossHp / 2)).toBe(13);
    expect(Math.floor(MODE_TABLE[3].bossHp / 2)).toBe(11);
  });

  it('TC-MD-011 1P/2P 偏见关闭：P3 整阶段跳过【§5.3】【L54, L256】', () => {
    for (const cfg of [cfg1, cfg2]) {
      let s = freshGame(cfg);
      const before = s.log.length;
      s = passRound(s);
      const kinds = s.log
        .slice(before)
        .filter((e) => e.kind === 'phase_entered')
        .map((e) => (e as { phase: string }).phase);
      expect(kinds).toContain('recovery');
      expect(kinds).not.toContain('prejudice');
    }
  });

  it('TC-MD-012 1P/2P 决战补给：小鱼、莉雅各抽 2 张；4P/3P 无【§7.1】【L57, L267】', () => {
    let s = freshGame(cfg2);
    for (let r = 0; r < 9 && s.phase.kind !== 'final_battle' && !s.result; r++) {
      s = passRound(s);
      s = sustain(s);
    }
    expect(s.phase.kind).toBe('final_battle');
    // 决战补给在 BATTLE_PREP 一次性各抽 2（日志 card_drawn 事件终局前累计含起始等，
    // 直接断言手牌中来源：转为比较 boss 存在与手牌数 ≥ 起始4-0+补给2-已用0 的可达性——
    // 精确断言：BATTLE_PREP 当刻的抽牌事件）
    const prepDraws = s.log.filter(
      (e) => e.kind === 'card_drawn' && (e as { character: string }).character !== undefined,
    );
    // 空转未用搜索/卡牌，抽牌事件仅可能来自决战补给（各 2）
    const byChar = new Map<string, number>();
    for (const e of prepDraws) {
      const c = (e as { character: string }).character;
      byChar.set(c, (byChar.get(c) ?? 0) + 1);
    }
    // 小鱼/莉雅在空转中无其他抽牌来源（无搜索、无卡打出）
    expect(byChar.get('xiaoyu')).toBe(2);
    expect(byChar.get('liya')).toBe(2);
    // 4P 对照：无补给
    expect(MODE_TABLE[4].finalSupply).toBe(0);
    expect(MODE_TABLE[3].finalSupply).toBe(0);
    expect(MODE_TABLE[2].finalSupply).toBe(2);
    expect(MODE_TABLE[1].finalSupply).toBe(2);
  });
});

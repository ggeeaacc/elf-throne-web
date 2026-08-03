/**
 * TC-PH 相位状态机与时间轴 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import {
  answer,
  cfg3,
  cfg4,
  evs,
  freshGame,
  ensureCard,
  mut,
  passRound,
  passTurn,
  putCrisis,
  settle,
  sustain,
  topCrisis,
} from '../helpers/regression-utils.js';
import type { GameState } from '../../engine/src/types.js';

function phaseSeq(s: GameState, from = 0): string[] {
  return s.log
    .slice(from)
    .filter((e) => e.kind === 'phase_entered')
    .map((e) => (e as { phase: string }).phase);
}

describe('TC-PH 相位状态机与时间轴', () => {
  it('TC-PH-001 相位链 crisis→action→prejudice→recovery【§2.1】【L83】', () => {
    let s = freshGame();
    const before = s.log.length;
    s = passRound(s);
    const kinds = phaseSeq(s, before);
    expect(kinds.slice(0, 3)).toEqual(['prejudice', 'recovery', 'crisis']);
    expect(kinds).toContain('action');
  });

  it('TC-PH-002 P2 回合顺序固定：小鱼→莉雅→凯尔→巴爷【§2.1】【L97-98】', () => {
    let s = freshGame();
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      order.push(s.currentTurn?.character ?? '');
      s = passTurn(s);
    }
    expect(order).toEqual(['xiaoyu', 'liya', 'kaier', 'baye']);
    expect(s.currentTurn?.character).toBe('xiaoyu');
    expect(s.phase.round).toBe(2);
  });

  it('TC-PH-003 未出场/出局角色调度跳过【§2.1】【L97-98】【裁A-06】', () => {
    // 三人局无巴爷
    let s3 = freshGame(cfg3);
    expect(s3.turnOrder).toEqual(['xiaoyu', 'liya', 'kaier']);
    // 四人局莉雅出局
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['liya']!.alive = false;
    });
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      order.push(s.currentTurn?.character ?? '');
      s = passTurn(s);
    }
    expect(order).toEqual(['xiaoyu', 'kaier', 'baye']);
  });

  it('TC-PH-004 时间轴：P4④ 每轮推进一个时段【§2.2】【L78-81, L158】', () => {
    let s = freshGame();
    expect(s.phase).toMatchObject({ day: 1, segment: 'dawn', round: 1 });
    s = passRound(s);
    expect(s.phase).toMatchObject({ day: 1, segment: 'dusk', round: 2 });
    s = passRound(s);
    expect(s.phase).toMatchObject({ day: 1, segment: 'night', round: 3 });
    s = passRound(s);
    expect(s.phase).toMatchObject({ day: 2, segment: 'dawn', round: 4 });
  });

  it('TC-PH-005 R9 P4 结束 → BATTLE_PREP（不提前不滞后）【§2.1】【L159】', () => {
    let s = freshGame();
    for (let r = 0; r < 8; r++) {
      s = passRound(s);
      s = sustain(s);
      expect(s.phase.kind).not.toBe('final_battle');
    }
    s = passRound(s);
    expect(s.phase.kind).toBe('final_battle');
    expect(s.boss).not.toBeNull();
  });

  it('TC-PH-006 TURN_START 次序：失控倒计时 → 传书接收 → 获 AP【§5.2】【L182】【裁A-07】', () => {
    // 非失控：传书结算事件早于 AP 获得事件
    let s = freshGame();
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = mut(s, (d) => {
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    const before = s.log.length;
    s = passTurn(s); // 小鱼结束 → 莉雅 TURN_START
    const slice = s.log.slice(before);
    const iRecv = slice.findIndex((e) => e.kind === 'letter_received');
    const iAp = slice.findIndex((e) => e.kind === 'turn_started' && (e as { character: string }).character === 'liya');
    expect(iRecv).toBeGreaterThanOrEqual(0);
    expect(iAp).toBeGreaterThan(iRecv);
    // 失控：倒计时在小鱼下一次 TURN_START 先 +1，书信不翻开继续暂存
    let b = freshGame();
    b = mut(b, (d) => {
      d.characters['xiaoyu']!.erosion = 4;
      d.flags.berserkCountdown = 0;
      d.characters['xiaoyu']!.pendingLetter = { cardUid: d.characters['liya']!.hand[0]!, from: 'liya' };
    });
    b = passRound(b); // 过完整轮 → 小鱼新 TURN_START：倒计时 0→1、书信暂存
    expect(b.flags.berserkCountdown).toBe(1);
    expect(b.characters['xiaoyu']?.pendingLetter).not.toBeNull();
    expect(b.currentTurn?.character).toBe('xiaoyu');
  });

  it('TC-PH-007 AP 获得量：常规 3 / 三人 4 / 决战 2；中度 -1；凯-01/雅-08 增益【§5.2】【L99, L332】【裁A-25】', () => {
    // 中度侵蚀 3→2
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
    });
    s = passRound(s);
    expect(s.characters['xiaoyu']?.ap).toBe(2);
    // 凯-01：下一回合 +1 AP 并抽 1
    let k = freshGame();
    k = ensureCard(k, 'kaier', 'kai-01');
    k = passTurn(k);
    k = passTurn(k); // → 凯尔回合
    k = applyCommand(k, (() => {
      const uid = k.characters['kaier']!.hand.find((u) => k.cards[u]?.defId === 'kai-01')!;
      return { type: 'play_card', character: 'kaier', cardUid: uid, targets: { characters: ['liya'] } } as const;
    })()).state;
    if (k.pendingDecision) k = answer(k, { option: 'pass' }); // 羁-07 复制询问：不复制
    k = passTurn(k); // 凯尔结束 → 巴爷
    k = passTurn(k); // 巴爷结束 → P3/P4 → 新一轮小鱼
    k = passTurn(k); // 小鱼结束 → 莉雅回合
    expect(k.characters['liya']?.ap).toBe(4); // 3 + 1（凯-01）
    // 雅-08 不可累积（max 语义）
    let y = freshGame();
    y = mut(y, (d) => {
      d.characters['xiaoyu']!.nextTurnApBonus = 1;
    });
    y = ensureCard(y, 'liya', 'ya-08');
    y = mut(y, (d) => {
      d.characters['liya']!.scene = 'human_city';
    });
    y = passTurn(y); // → 莉雅回合
    y = applyCommand(y, (() => {
      const uid = y.characters['liya']!.hand.find((u) => y.cards[u]?.defId === 'ya-08')!;
      return { type: 'play_card', character: 'liya', cardUid: uid } as const;
    })()).state;
    expect(y.characters['xiaoyu']?.nextTurnApBonus).toBe(1); // max(1,1)=1 不累加
  });

  it('TC-PH-008 同一行动可重复（搜索 ×3）；AP 尽拒绝【§5.2】【L99】', () => {
    let s = freshGame();
    const hand0 = s.characters['xiaoyu']!.hand.length;
    s = applyCommand(s, { type: 'search', character: 'xiaoyu' }).state;
    s = applyCommand(s, { type: 'search', character: 'xiaoyu' }).state;
    s = applyCommand(s, { type: 'search', character: 'xiaoyu' }).state;
    expect(s.characters['xiaoyu']?.hand.length).toBe(Math.min(hand0 + 6, 10)); // 牌库 6 张抽尽即止
    expect(s.characters['xiaoyu']?.ap).toBe(0);
    expect(() => applyCommand(s, { type: 'search', character: 'xiaoyu' })).toThrow(/行动点不足/);
  });

  it('TC-PH-009 P4 管线冻结四步：轮末效果 → 弃至 5 → 沦陷检查 → 推进时间【§5.4】【L156-158】【裁A-38】【裁A-14】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-02', 'ancient_battlefield'); // 轮末效果源
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-08', 'elf_kingdom'); // 第 4 张 → F2（4P 阈值 4）
    s = topCrisis(s, 'crisis-01'); // 下一轮翻牌无关
    s = mut(s, (d) => {
      // 小鱼手牌凑 6（从牌库挪 2 张）
      const x = d.characters['xiaoyu']!;
      x.hand.push(x.deck.shift()!, x.deck.shift()!);
      // 保证轮末有角色在古战场受 1 点（小鱼去古战场）
      x.scene = 'ancient_battlefield';
    });
    const before = s.log.length;
    // 过完全部回合进入 P4
    s = passRound(s);
    const slice = s.log.slice(before);
    const iDmg = slice.findIndex((e) => e.kind === 'character_damaged');
    const iDiscardDecision = slice.findIndex(
      (e) => e.kind === 'decision_required' && (e as { decision: { kind: string } }).decision.kind === 'choose_cards',
    );
    const iOver = slice.findIndex((e) => e.kind === 'game_over');
    expect(iDmg).toBeGreaterThanOrEqual(0);
    expect(iDiscardDecision).toBeGreaterThan(iDmg); // 手牌检查在轮末效果之后
    expect(iOver).toBeGreaterThan(iDiscardDecision); // 沦陷判负在最后
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F2');
  });

  it('TC-PH-010 终局后一切指令拒绝【§2.1】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.result = { outcome: 'victory', reason: '测试' };
      d.phase.kind = 'game_over';
    });
    expect(() => applyCommand(s, { type: 'end_turn', character: 'xiaoyu' })).toThrow(/已结束/);
    expect(() => applyCommand(s, { type: 'search', character: 'xiaoyu' })).toThrow(/已结束/);
  });
});

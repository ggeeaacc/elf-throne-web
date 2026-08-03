/**
 * 传书系统测试（§6.5 + 附录D + 羁-01 激活【裁A-21/22/23/44】）。
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state.js';
import { beginGame, applyCommand } from '../actions.js';
import { settle, passTurn } from '../test-utils.js';
import { receiveLetterIfAny } from './letters.js';
import type { GameConfig, GameState, GameEvent } from '../types.js';

const cfg2: GameConfig = {
  playerCount: 2,
  seed: 33,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'] },
};

function freshGame(): GameState {
  return settle(beginGame(createInitialState(cfg2)).state);
}

describe('传书流程（§6.5）', () => {
  it('发送：1 AP、不同场景、正面朝下待收（§6.5 前置）', () => {
    const s = freshGame();
    const uid = s.characters['xiaoyu']!.hand[0]!;
    const s1 = applyCommand(s, { type: 'send_letter', character: 'xiaoyu', cardUid: uid }).state;
    expect(s1.characters['xiaoyu']?.ap).toBe(2);
    expect(s1.characters['xiaoyu']?.hand).not.toContain(uid);
    expect(s1.characters['liya']?.pendingLetter).toEqual({ cardUid: uid, from: 'xiaoyu' });
    expect(s1.characters['xiaoyu']?.lettersSentThisRound).toBe(1);
  });

  it('每轮限发 1 封、暂存槽=1【裁A-21】', () => {
    let s = freshGame();
    const uid = s.characters['xiaoyu']!.hand[0]!;
    s = applyCommand(s, { type: 'send_letter', character: 'xiaoyu', cardUid: uid }).state;
    const uid2 = s.characters['xiaoyu']!.hand[0]!;
    expect(() => applyCommand(s, { type: 'send_letter', character: 'xiaoyu', cardUid: uid2 })).toThrow(/每轮|暂存|已有/);
  });

  it('接收：回合开始翻开入牌、回 1 血、抽传书卡、计数 +1（§6.5 接收）', () => {
    let s = freshGame();
    const draft = structuredClone(s);
    draft.characters['liya']!.hp = 3;
    const uid = draft.characters['xiaoyu']!.hand[0]!;
    s = applyCommand(draft, { type: 'send_letter', character: 'xiaoyu', cardUid: uid }).state;
    const lettersBefore = s.flags.xiaoyuLiyaLetters;
    s = passTurn(s); // 小鱼结束 → 莉雅回合开始收信
    expect(s.characters['liya']?.hand).toContain(uid);
    expect(s.characters['liya']?.hp).toBe(4);
    expect(s.characters['liya']?.pendingLetter).toBeNull();
    expect(s.flags.xiaoyuLiyaLetters).toBe(lettersBefore + 1);
  });

  it('小鱼收信可选改为移除 1 侵蚀【L116】', async () => {
    let s = freshGame();
    const draft = structuredClone(s);
    draft.characters['xiaoyu']!.erosion = 2;
    const uid = draft.characters['liya']!.hand[0]!;
    // 初始位置即不同场景（小鱼人类王城/莉雅精灵王国）；小鱼结束 → 莉雅发信 → 结束 → 小鱼收信
    s = settle(applyCommand(draft, { type: 'end_turn', character: 'xiaoyu' }).state);
    s = applyCommand(s, { type: 'send_letter', character: 'liya', cardUid: uid }).state;
    s = applyCommand(s, { type: 'end_turn', character: 'liya' }).state;
    // 逐项解决直至收信选择出现（P4/翻牌决策先答）
    let guard = 0;
    while (s.pendingDecision && s.pendingDecision.kind !== 'choose_option' && guard++ < 20) {
      const { defaultChoice } = await import('../test-utils.js');
      s = applyCommand(s, { type: 'resolve_decision', decisionId: s.pendingDecision.id, choice: defaultChoice(s.pendingDecision, s) }).state;
    }
    expect(s.pendingDecision?.kind).toBe('choose_option');
    s = settle(applyCommand(s, { type: 'resolve_decision', decisionId: s.pendingDecision!.id, choice: { option: 'erosion' } }).state);
    expect(s.characters['xiaoyu']?.erosion).toBe(1);
  });

  it('失控小鱼书信暂存不翻开【L185】', () => {
    const s = freshGame();
    const draft = structuredClone(s);
    draft.characters['xiaoyu']!.erosion = 4; // 失控
    draft.characters['xiaoyu']!.pendingLetter = { cardUid: draft.characters['xiaoyu']!.deck[0]!, from: 'liya' };
    const events: GameEvent[] = [];
    receiveLetterIfAny(draft, events, 'xiaoyu');
    expect(draft.characters['xiaoyu']?.pendingLetter).not.toBeNull(); // 仍暂存
    expect(events.filter((e) => e.kind === 'letter_received')).toHaveLength(0);
  });

  it('累计 2 次成功传书 → 激活羁-01（§6.3【裁A-23/44】）', () => {
    let s = freshGame();
    // 第一封：小鱼 → 莉雅（初始即不同场景）
    let uid = s.characters['xiaoyu']!.hand[0]!;
    s = applyCommand(s, { type: 'send_letter', character: 'xiaoyu', cardUid: uid }).state;
    s = passTurn(s); // 莉雅回合开始收信（计数 1）
    s = passTurn(s); // 小鱼回合
    s = passTurn(s); // 莉雅回合（round 2，计数器已重置）
    // 第二封：莉雅 → 小鱼（方向不限【裁A-44】）
    uid = s.characters['liya']!.hand[0]!;
    s = applyCommand(s, { type: 'send_letter', character: 'liya', cardUid: uid }).state;
    s = passTurn(s); // 小鱼回合开始收信（计数 2 → 激活）
    expect(s.flags.xiaoyuLiyaLetters).toBe(2);
    const bond = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(bond?.status).toBe('active');
    expect(bond?.cardUid).toMatch(/^bond-01#/);
  });
});

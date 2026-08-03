/**
 * TC-LT 传书 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import {
  answer,
  bumpErosion,
  ensureCard,
  evs,
  freshGame,
  mut,
  passRound,
  passTurn,
  settle,
  setErosion,
  sustain,
  topCrisis,
} from '../helpers/regression-utils.js';
import type { CharacterId, GameState } from '../../engine/src/types.js';

function giveTurn(s: GameState, c: CharacterId, ap = 3): GameState {
  return mut(s, (d) => {
    d.currentTurn = { character: c };
    d.characters[c]!.ap = ap;
  });
}

/** 小鱼→莉雅 发信（直接指令；返回 state） */
function sendXtoL(s: GameState): GameState {
  const uid = s.characters['xiaoyu']!.hand[0]!;
  return applyCommand(s, { type: 'send_letter', character: 'xiaoyu', cardUid: uid }).state;
}

describe('TC-LT 传书', () => {
  it('TC-LT-001 前置校验：仅小鱼/莉雅、双方不同场景、发送方回合 1 AP【§6.5】【L113-114】', () => {
    // a) 凯尔不可发起
    let a = freshGame();
    a = giveTurn(a, 'kaier');
    expect(() => applyCommand(a, { type: 'send_letter', character: 'kaier', cardUid: a.characters['kaier']!.hand[0]! })).toThrow(/仅小鱼和莉雅/);
    // b) 同场景拒绝
    let b = freshGame();
    b = mut(b, (d) => {
      d.characters['liya']!.scene = 'human_city';
    });
    expect(() => applyCommand(b, { type: 'send_letter', character: 'xiaoyu', cardUid: b.characters['xiaoyu']!.hand[0]! })).toThrow(/不同场景/);
    // c) AP=0 拒绝
    let c = freshGame();
    c = giveTurn(c, 'xiaoyu', 0);
    expect(() => applyCommand(c, { type: 'send_letter', character: 'xiaoyu', cardUid: c.characters['xiaoyu']!.hand[0]! })).toThrow(/行动点不足/);
    // d) 合法：AP-1、正面朝下置于对方角色卡旁
    let d = freshGame();
    const hand0 = d.characters['xiaoyu']!.hand.length;
    d = sendXtoL(d);
    expect(d.characters['xiaoyu']?.ap).toBe(2);
    expect(d.characters['xiaoyu']?.hand.length).toBe(hand0 - 1);
    expect(d.characters['liya']?.pendingLetter).not.toBeNull();
  });

  it('TC-LT-002 限额：每角色每轮发 ≤1 收 ≤1【§6.5】【L118】', () => {
    let s = freshGame();
    s = sendXtoL(s);
    expect(() => sendXtoL(s)).toThrow(/最多发出一封/);
    // 莉雅本轮可发（各自独立计）
    s = giveTurn(s, 'liya');
    const uid = s.characters['liya']!.hand[0]!;
    s = applyCommand(s, { type: 'send_letter', character: 'liya', cardUid: uid }).state;
    expect(s.characters['xiaoyu']?.pendingLetter).not.toBeNull();
  });

  it('TC-LT-003 暂存槽=1：对方有未翻开书信不可再发【§6.5】【裁A-21】', () => {
    // 莉雅→失控小鱼（暂存不翻开）；下一轮莉雅再发 → 暂存槽拦截
    let s = freshGame();
    s = setErosion(s, 4);
    s = giveTurn(s, 'liya');
    s = applyCommand(s, { type: 'send_letter', character: 'liya', cardUid: s.characters['liya']!.hand[0]! }).state;
    expect(s.characters['xiaoyu']?.pendingLetter).not.toBeNull();
    s = passRound(s); // 过一轮：失控小鱼书信仍暂存；发收限额已重置
    expect(s.characters['xiaoyu']?.pendingLetter).not.toBeNull();
    s = giveTurn(s, 'liya');
    expect(() =>
      applyCommand(s, { type: 'send_letter', character: 'liya', cardUid: s.characters['liya']!.hand[0]! }),
    ).toThrow(/暂存|未翻开/);
  });

  it('TC-LT-004 接收时点：接收方下一自己回合开始、获 AP 之前【§6.5】【L182】', () => {
    let s = freshGame();
    s = sendXtoL(s);
    const before = s.log.length;
    s = passTurn(s); // 小鱼结束 → 莉雅 TURN_START
    const slice = s.log.slice(before);
    const iRecv = slice.findIndex((e) => e.kind === 'letter_received');
    const iAp = slice.findIndex((e) => e.kind === 'turn_started' && (e as { character: string }).character === 'liya');
    expect(iRecv).toBeGreaterThanOrEqual(0);
    expect(iAp).toBeGreaterThan(iRecv); // 收信先于获 AP
  });

  it('TC-LT-005 失控/无法行动 → 不翻开继续暂存；恢复后第一个回合开始翻开【§6.5】【L185】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.pendingLetter = { cardUid: d.characters['liya']!.hand[0]!, from: 'liya' };
    });
    s = passRound(s); // 小鱼失控 TURN_START：书信不翻开
    expect(s.characters['xiaoyu']?.pendingLetter).not.toBeNull();
    expect(evs(s, 'letter_received')).toHaveLength(0);
    // 恢复（脱离失控）后第一个回合开始翻开
    s = bumpErosion(s, -1); // 4→3 脱离
    s = passRound(s);
    expect(s.characters['xiaoyu']?.pendingLetter).toBeNull();
    expect(evs(s, 'letter_received').length).toBeGreaterThanOrEqual(1);
  });

  it('TC-LT-006 接收满手 5 → 立即弃 1 再加入【§6.5】【L117】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      const l = d.characters['liya']!;
      l.hand.push(l.deck.shift()!); // 手牌 5
      l.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
      // 传书牌库顶摆传-02（无额外弃牌效果，隔离变量）
      const i = d.decks.letter.findIndex((u) => d.cards[u]?.defId === 'letter-02');
      const [lu] = d.decks.letter.splice(i, 1);
      d.decks.letter.unshift(lu!);
    });
    s = passTurn(s); // → 莉雅 TURN_START：满手弃牌决策（settle 默认弃首张）
    expect(s.characters['liya']?.hand.length).toBe(5); // 弃 1 后 4 + 书信 1 = 5
    expect(s.characters['liya']?.discard.length).toBe(1);
  });

  it('TC-LT-007 恢复选项：默认回 1；小鱼可选改 -1 侵蚀【§6.5】【L116】', () => {
    // a) 莉雅接收：默认回 1
    let a = freshGame();
    a = mut(a, (d) => {
      d.characters['liya']!.hp = 3;
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    a = passTurn(a);
    expect(a.characters['liya']?.hp).toBeGreaterThanOrEqual(4); // 回 1（另有传书卡效果可能再回）
    // b) 小鱼有侵蚀：可选改除侵蚀（手动回答选项）
    let c = freshGame();
    c = mut(c, (d) => {
      d.characters['xiaoyu']!.erosion = 2;
      d.characters['xiaoyu']!.pendingLetter = { cardUid: d.characters['liya']!.hand[0]!, from: 'liya' };
    });
    // 控制下一轮 P1 翻场景指定卡（避免放置决策截获）
    c = topCrisis(c, 'crisis-02');
    c = applyCommand(c, { type: 'end_turn', character: 'xiaoyu' }).state; // 小鱼直接结束（书信下一轮开始时结算）
    c = passTurn(c); // 莉雅
    c = passTurn(c); // 凯尔
    c = applyCommand(c, { type: 'end_turn', character: 'baye' }).state; // 巴爷结束 → P3/P4/R2P1 → 小鱼 TURN_START
    // D1 黄昏翻 2 张（可能有通用卡放置决策），先解决
    if (c.pendingDecision?.kind === 'place_crisis') c = answer(c, { scene: 'human_city' });
    expect(c.pendingDecision?.kind).toBe('choose_option'); // 回血/清侵蚀选择
    c = answer(c, { option: 'erosion' });
    expect(c.characters['xiaoyu']?.erosion).toBe(1);
  });

  it('TC-LT-008 接收后抽传书库顶 1 张结算后弃置；耗尽洗回【§6.5】【L184, L404】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    const letterDeck0 = s.decks.letter.length;
    s = passTurn(s);
    expect(s.decks.letter.length).toBe(letterDeck0 - 1);
    expect(s.decks.letterDiscard.length).toBe(1); // 结算后入弃牌堆
    expect(evs(s, 'letter_card_drawn').length).toBe(1);
    // 耗尽洗回
    let b = freshGame();
    b = mut(b, (d) => {
      d.decks.letterDiscard.push(...d.decks.letter.splice(0));
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    b = passTurn(b);
    expect(evs(b, 'letter_card_drawn').length).toBe(1); // 洗回后仍能抽
  });

  it('TC-LT-009 成功传书计数：翻开时计入、方向不限、累计 2 激活羁-01【§6.5】【裁A-23】【裁A-44】', () => {
    let s = freshGame();
    s = sendXtoL(s);
    expect(s.flags.xiaoyuLiyaLetters).toBe(0); // 发送时不计入
    s = passTurn(s); // 莉雅翻开 → 计数 1
    expect(s.flags.xiaoyuLiyaLetters).toBe(1);
    // 反向再来一次 → 2 → 激活羁-01
    s = giveTurn(s, 'liya');
    s = applyCommand(s, { type: 'send_letter', character: 'liya', cardUid: s.characters['liya']!.hand[0]! }).state;
    s = passRound(s); // 到小鱼 TURN_START 翻开
    expect(s.flags.xiaoyuLiyaLetters).toBe(2);
    const bond = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(bond?.status).toBe('active');
    expect(s.cards[bond!.cardUid!]?.defId).toBe('bond-01');
  });

  it('TC-LT-010 传-04 反向传递：满 5 立即弃 1；不占限额；不触发书信效果【§6.5】【§9.7】【裁A-22】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      // 传书牌库顶摆上传-04
      const i = d.decks.letter.findIndex((u) => d.cards[u]?.defId === 'letter-04');
      const [uid] = d.decks.letter.splice(i, 1);
      d.decks.letter.unshift(uid!);
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
      // 发送方（小鱼）手牌凑 5
      const x = d.characters['xiaoyu']!;
      x.hand.push(x.deck.shift()!);
    });
    const count0 = s.flags.xiaoyuLiyaLetters;
    s = passTurn(s); // 莉雅接收 → 抽传-04 → 选 1 张传给小鱼（settle 默认首张）
    expect(s.characters['xiaoyu']?.pendingReverseLetter).not.toBeNull();
    expect(s.flags.xiaoyuLiyaLetters).toBe(count0 + 1); // 本次正常计数
    // 到小鱼 TURN_START：反向收卡（满 5 弃 1），不回血/不清侵蚀/不抽传书卡/不计数
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.erosion = 1;
      d.characters['xiaoyu']!.hp = 3;
    });
    const letterDeckBefore = s.decks.letter.length + s.decks.letterDiscard.length;
    s = passRound(s);
    expect(s.characters['xiaoyu']?.hand.length).toBe(5); // 弃 1 收 1
    expect(s.characters['xiaoyu']?.hp).toBe(3); // 不回血
    expect(s.characters['xiaoyu']?.erosion).toBe(1); // 不清侵蚀
    expect(s.flags.xiaoyuLiyaLetters).toBe(count0 + 1); // 不计数
    expect(s.decks.letter.length + s.decks.letterDiscard.length).toBe(letterDeckBefore); // 不抽传书卡
    expect(s.characters['xiaoyu']?.pendingReverseLetter).toBeNull();
  });

  it('TC-LT-011 传-01：接收方回 2 抽 1；小鱼额外 -1 侵蚀；莉雅额外抽 1【§9.7】', () => {
    // a) 小鱼接收
    let a = freshGame();
    a = mut(a, (d) => {
      const i = d.decks.letter.findIndex((u) => d.cards[u]?.defId === 'letter-01');
      const [uid] = d.decks.letter.splice(i, 1);
      d.decks.letter.unshift(uid!);
      d.characters['xiaoyu']!.erosion = 1;
      d.characters['xiaoyu']!.hp = 2;
      d.characters['xiaoyu']!.pendingLetter = { cardUid: d.characters['liya']!.hand[0]!, from: 'liya' };
    });
    a = passRound(a); // 到小鱼 TURN_START（settle 默认 heal 选项）
    expect(a.characters['xiaoyu']?.erosion).toBe(0); // 传-01 额外 -1
    expect(a.characters['xiaoyu']?.hp).toBe(5); // 收信回 1 + 传-01 回 2（上限 5）
    // b) 莉雅接收：额外抽 1
    let b = freshGame();
    b = mut(b, (d) => {
      const i = d.decks.letter.findIndex((u) => d.cards[u]?.defId === 'letter-01');
      const [uid] = d.decks.letter.splice(i, 1);
      d.decks.letter.unshift(uid!);
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    const hand0 = b.characters['liya']!.hand.length;
    b = passTurn(b);
    expect(b.characters['liya']?.hand.length).toBe(hand0 + 1 + 2); // 书信 1 + 抽 1 + 额外抽 1
  });

  it('TC-LT-012 传-02：1 材料 + 1 信物（可叠加不过期）【§9.7】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      const i = d.decks.letter.findIndex((u) => d.cards[u]?.defId === 'letter-02');
      const [uid] = d.decks.letter.splice(i, 1);
      d.decks.letter.unshift(uid!);
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    s = passTurn(s);
    expect(s.characters['liya']?.materialTokens).toBe(1);
    expect(s.characters['liya']?.charms).toBe(1);
  });

  it('TC-LT-013 传-03：双方各抽 1；本轮两人各下一次伤害 -1（跨场景）【§9.7】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      const i = d.decks.letter.findIndex((u) => d.cards[u]?.defId === 'letter-03');
      const [uid] = d.decks.letter.splice(i, 1);
      d.decks.letter.unshift(uid!);
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    const xh0 = s.characters['xiaoyu']!.hand.length;
    const lh0 = s.characters['liya']!.hand.length;
    s = passTurn(s);
    expect(s.characters['xiaoyu']?.hand.length).toBe(xh0 + 1);
    expect(s.characters['liya']?.hand.length).toBe(lh0 + 1 + 1); // 书信 + 抽 1
    // 双方各下一次伤害 -1
    expect(s.buffs.some((b) => b.kind === 'first_damage_reduce' && b.target === 'xiaoyu')).toBe(true);
    expect(s.buffs.some((b) => b.kind === 'first_damage_reduce' && b.target === 'liya')).toBe(true);
  });

  it('TC-LT-014 传-05：双方各回 1；互看手牌；各可弃 1 抽 1【§9.7】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      const i = d.decks.letter.findIndex((u) => d.cards[u]?.defId === 'letter-05');
      const [uid] = d.decks.letter.splice(i, 1);
      d.decks.letter.unshift(uid!);
      d.characters['xiaoyu']!.hp = 3;
      d.characters['liya']!.hp = 2;
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    s = passTurn(s); // settle 自动回答双方换牌询问（默认第一项=替换）
    expect(s.characters['xiaoyu']?.hp).toBe(4);
    expect(s.characters['liya']?.hp).toBe(4); // 2 + 收信回 1 + 传-05 回 1
  });

  it('TC-LT-015 其他获得不即时检查手牌，P4② 统一弃至 5【§6.5】【L156】', () => {
    let s = freshGame();
    // 搜索 +2 → 手牌 6：获得瞬间不检查
    s = applyCommand(s, { type: 'search', character: 'xiaoyu' }).state;
    expect(s.characters['xiaoyu']?.hand.length).toBe(6);
    expect(s.pendingDecision).toBeNull(); // 获得瞬间无弃牌决策
    s = passRound(s); // P4② 统一弃至 5
    expect(s.characters['xiaoyu']?.hand.length).toBe(5);
  });
});

/**
 * 最终决战测试（§7：备战/三阶段/反击/宝玉/决战行动【裁A-01/10/34/35/36】）。
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state.js';
import { beginGame, applyCommand } from '../actions.js';
import { settle } from '../test-utils.js';
import { enterFinalBattle, runBossAction, battleHeal, battleGuard, purifyCharge, gemAttune } from './boss.js';
import { dealDamageToBoss } from './combat.js';
import type { GameConfig, GameState, GameEvent } from '../types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 55,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};

function freshGame(): GameState {
  return settle(beginGame(createInitialState(cfg4)).state);
}

function toBattle(s: GameState, prep?: (d: GameState) => void): GameState {
  const draft = structuredClone(s);
  prep?.(draft);
  const events: GameEvent[] = [];
  enterFinalBattle(draft, events);
  return settle(draft);
}

describe('BATTLE_PREP（§7.1）', () => {
  it('四人局：26 血 / 护盾 12 / 阶段 1；危-10 未清除 +2', () => {
    const s = toBattle(freshGame());
    expect(s.boss).toMatchObject({ hp: 28, maxHp: 28, shield: 12, stage: 1, round: 1, gemPurify: 0 });
  });

  it('危-10 已清除则不加；献祭进度 ≥3 每张 +3【裁A-15】', () => {
    const s = toBattle(freshGame(), (d) => {
      d.flags.avatarCleared = true;
      d.flags.sacrifice = { 'crisis-09#0': 3, 'crisis-09#1': 2 };
    });
    expect(s.boss?.maxHp).toBe(26 + 3); // 仅一张达 3
  });

  it('女王获救：跳过 P1 直接 P2 且存活角色回 2【L271】', () => {
    const s = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
      d.characters['liya']!.hp = 3;
    });
    expect(s.boss).toMatchObject({ shield: 0, stage: 2 });
    expect(s.characters['liya']?.hp).toBe(5);
  });

  it('全员集结黑暗山谷，场景危机弃置（§7.1-1/2/3）', () => {
    const base = freshGame();
    const s = toBattle(base, (d) => {
      d.scenes['human_city'].crisisCards.push(d.decks.crisis[0]!);
    });
    for (const ch of Object.values(s.characters)) expect(ch.scene).toBe('dark_valley');
    expect(s.scenes['human_city'].crisisCards).toHaveLength(0);
  });
});

describe('首领阶段与转换（§7.3）', () => {
  it('P1 护盾吸收伤害；破盾即时进 P2 且全体回 2【裁A-11/34】', () => {
    let s = toBattle(freshGame());
    const events: GameEvent[] = [];
    dealDamageToBoss(s, events, 5, 'xiaoyu', true);
    expect(s.boss).toMatchObject({ shield: 7, hp: s.boss!.maxHp, stage: 1 });
    s = structuredClone(s);
    s.characters['liya']!.hp = 1;
    dealDamageToBoss(s, events, 10, 'xiaoyu', true); // 溢出结转
    expect(s.boss?.shield).toBe(0);
    expect(s.boss?.stage).toBe(2);
    expect(s.characters['liya']?.hp).toBe(3);
  });

  it('P2 反击：人类攻击者受 2 点黑暗伤害（宝玉侵蚀【裁A-35】），小鱼 E+1', () => {
    const s = toBattle(freshGame(), (d) => {
      d.boss = null;
    });
    const draft = structuredClone(s);
    draft.boss!.shield = 0;
    draft.boss!.stage = 2;
    const events: GameEvent[] = [];
    dealDamageToBoss(draft, events, 3, 'baye', true);
    expect(draft.characters['baye']?.hp).toBe(3); // 5 - 2
    expect(draft.pendingDecision?.kind ?? null).toBeNull();
    // 小鱼：2 点黑暗 + 侵蚀 +1
    const d2 = structuredClone(s);
    d2.boss!.shield = 0;
    d2.boss!.stage = 2;
    const ev2: GameEvent[] = [];
    dealDamageToBoss(d2, ev2, 3, 'xiaoyu', true);
    expect(d2.characters['xiaoyu']?.hp).toBe(3);
    expect(d2.characters['xiaoyu']?.erosion).toBe(1);
  });

  it('P2 反击：精灵攻击者 1 伤 + 弃 1 手牌（公爵威严减免伤害但仍须弃牌【C8】）', () => {
    let s = toBattle(freshGame());
    s = structuredClone(s);
    s.boss!.shield = 0;
    s.boss!.stage = 2;
    const events: GameEvent[] = [];
    const handBefore = s.characters['liya']!.hand.length;
    dealDamageToBoss(s, events, 3, 'liya', true);
    // 凯尔同场景：莉雅受伤害 -1 → 1-1=0（规则正确：减免适用于一切伤害）
    expect(s.characters['liya']?.hp).toBe(5);
    expect(s.pendingDecision?.kind).toBe('choose_cards'); // 弃牌不受影响
    s = settle(s);
    expect(s.characters['liya']?.hand.length).toBe(handBefore - 1);
  });

  it('P2→P3 即时转换：hp ≤ floor(max/2)，全体回 1【裁A-34】', () => {
    let s = toBattle(freshGame()); // max 28 → 阈值 14
    s = structuredClone(s);
    s.boss!.shield = 0;
    s.boss!.stage = 2;
    s.characters['kaier']!.hp = 1;
    const events: GameEvent[] = [];
    dealDamageToBoss(s, events, 14, 'kaier', true); // 28-14=14 ≤ 14
    expect(s.boss?.stage).toBe(3);
    expect(s.characters['kaier']?.hp).toBe(2);
  });

  it('P3 减伤 -1 钳 1 在效果链构建侧生效（§7.3）；暴走 AoE 全体 2 黑暗 + 回 1', () => {
    let s = toBattle(freshGame());
    s = structuredClone(s);
    s.boss!.shield = 0;
    s.boss!.stage = 3;
    s.boss!.hp = 5;
    const events: GameEvent[] = [];
    runBossAction(s, events);
    s = settle(s);
    expect(s.characters['xiaoyu']?.hp).toBe(3);
    expect(s.boss?.hp).toBe(6);
  });

  it('玫拉生命归零 → 胜利（§7.3）', () => {
    const s = toBattle(freshGame());
    const draft = structuredClone(s);
    draft.boss!.shield = 0;
    const events: GameEvent[] = [];
    dealDamageToBoss(draft, events, 99, 'xiaoyu', true);
    expect(draft.result?.outcome).toBe('victory');
  });
});

describe('玫拉轮末行动与宝玉共鸣（§7.3/7.4【裁A-36】）', () => {
  it('P1 暗影箭打生命最低者；共鸣减伤最低 0', () => {
    let s = toBattle(freshGame());
    s = structuredClone(s);
    s.characters['baye']!.hp = 2;
    s.characters['xiaoyu']!.hp = 4;
    s.boss!.gemPurify = 1;
    const events: GameEvent[] = [];
    runBossAction(s, events);
    s = settle(s);
    expect(s.characters['baye']?.hp).toBe(2); // 1-1共鸣=0
  });

  it('P2 宝玉之力：本轮伤害最高者 2 点；并列各 1【裁A-35】', () => {
    let s = toBattle(freshGame());
    s = structuredClone(s);
    s.boss!.shield = 0;
    s.boss!.stage = 2;
    s.boss!.damageThisRound = { xiaoyu: 5, liya: 5, kaier: 2 };
    const events: GameEvent[] = [];
    runBossAction(s, events);
    s = settle(s);
    expect(s.characters['xiaoyu']?.hp).toBe(4); // 并列 → 各 1
    expect(s.characters['liya']?.hp).toBe(5); // 凯尔被动 -1 → 0 伤
    expect(s.characters['kaier']?.hp).toBe(5);
    expect(s.boss?.damageThisRound).toEqual({}); // 窗口重置
  });
});

describe('决战行动（§7.2）', () => {
  it('治疗：1 AP 弃 1 手牌回 2', () => {
    let s = toBattle(freshGame());
    s = structuredClone(s);
    s.characters['xiaoyu']!.hp = 1;
    s.characters['xiaoyu']!.ap = 2;
    const events: GameEvent[] = [];
    const uid = s.characters['xiaoyu']!.hand[0]!;
    battleHeal(s, events, 'xiaoyu', uid, 'xiaoyu');
    expect(s.characters['xiaoyu']?.hp).toBe(3);
    expect(s.characters['xiaoyu']?.ap).toBe(1);
  });

  it('援护：下一次伤害代受，代受一次后 buff 消耗（§7.2【裁A-46】）', () => {
    let s = toBattle(freshGame());
    s = structuredClone(s);
    s.characters['kaier']!.ap = 2;
    const events: GameEvent[] = [];
    battleGuard(s, events, 'kaier', 'liya');
    // P1 暗影箭：全体 5 血并列 → 对并列者各 1 点【裁A-46】；莉雅那份由凯尔援护代受
    runBossAction(s, events);
    s = settle(s);
    // 代受生效：伤害落在凯尔身上，莉雅无伤
    expect(events.some((e) => e.kind === 'redirected' && e.from === 'liya' && e.to === 'kaier')).toBe(true);
    expect(s.characters['liya']?.hp).toBe(5);
    expect(s.characters['kaier']?.hp).toBe(3); // 5-1（代受莉雅份额）-1（自己那份暗影箭）
    expect(s.characters['xiaoyu']?.hp).toBe(4);
    expect(s.characters['baye']?.hp).toBe(4);
    // 援护为一次性（"下一次伤害"）：代受后即消耗移除，正确终态是不再存在 guard buff
    expect(s.buffs.some((b) => b.kind === 'guard')).toBe(false);
  });

  it('净化蓄能 + 宝玉共鸣（§7.4：已激活羁绊才可）', () => {
    let s = toBattle(freshGame(), (d) => {
      d.bonds = [{ pair: ['xiaoyu', 'liya'], status: 'active', cardUid: 'bond-01#0', replacedByBerserk: false, activeUsedRound: null }];
    });
    s = structuredClone(s);
    s.characters['liya']!.ap = 2;
    const events: GameEvent[] = [];
    purifyCharge(s, events, 'liya');
    expect(s.characters['liya']?.purifyTokens).toBe(1);
    gemAttune(s, events, 'liya');
    expect(s.boss?.gemPurify).toBe(1);
    expect(s.characters['liya']?.ap).toBe(0);
  });

  it('未激活羁绊时宝玉共鸣拒绝', () => {
    let s = toBattle(freshGame());
    s = structuredClone(s);
    s.characters['liya']!.ap = 2;
    const events: GameEvent[] = [];
    expect(() => gemAttune(s, events, 'liya')).toThrow(/羁绊/);
  });
});

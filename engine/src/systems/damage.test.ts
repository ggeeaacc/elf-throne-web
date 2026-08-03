/**
 * 伤害效果链与终端结算测试（§11【裁A-08/29/30】+ 出局【裁A-06】）。
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state.js';
import { beginGame, applyCommand } from '../actions.js';
import { settle } from '../test-utils.js';
import { foldChain, dealDamageToCharacter, addBuff } from './damage.js';
import type { GameConfig, GameState, GameEvent } from '../types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 5,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};

function freshGame(): GameState {
  return settle(beginGame(createInitialState(cfg4)).state);
}

function dmg(n: number) {
  return { base: n, chain: [] as never[], source: 'test', dark: false, fromAttackCard: false };
}

describe('效果链折叠（§11【裁A-08】）', () => {
  it('按声明顺序折叠：后项作用于前项结果', () => {
    // (3+1)×2-2 = 6
    expect(
      foldChain({
        base: 3,
        chain: [
          { op: 'ADD', value: 1, source: 'a' },
          { op: 'MULT', value: 2, source: 'b' },
          { op: 'REDUCE', value: 2, source: 'c' },
        ],
        source: 't',
        dark: false,
        fromAttackCard: true,
      }),
    ).toBe(6);
    // 顺序调换：(3-2)×2+1 = 3（减半节点各自钳 0：(3-5 钳 0)×2+1 = 1）
    expect(
      foldChain({
        base: 3,
        chain: [
          { op: 'REDUCE', value: 5, source: 'c' },
          { op: 'MULT', value: 2, source: 'b' },
          { op: 'ADD', value: 1, source: 'a' },
        ],
        source: 't',
        dark: false,
        fromAttackCard: true,
      }),
    ).toBe(1);
  });

  it('玫拉 P3 节点钳 1（最低为 1【L219】）', () => {
    expect(foldChain({ base: 1, chain: [{ op: 'BOSS_P3', value: 1, source: 'p3' }], source: 't', dark: false, fromAttackCard: true })).toBe(1);
  });
});

describe('角色伤害终端', () => {
  it('代受：单一援护直接转移并按承受者减免【裁A-29】', () => {
    const s = freshGame();
    const events: GameEvent[] = [];
    addBuff(s, { source: 'guard', kind: 'guard', value: 0, target: 'liya', partner: 'kaier', scope: 'round' });
    dealDamageToCharacter(s, events, { target: 'liya', damage: dmg(2) });
    expect(s.characters['liya']?.hp).toBe(5);
    expect(s.characters['kaier']?.hp).toBe(3); // 凯尔承 2
    expect(events.some((e) => e.kind === 'redirected')).toBe(true);
  });

  it('分摊：奇数伤害询问高份归属，总额守恒；羁-01 回血按伤害事件触发一次【裁A-30】【裁A-47】', () => {
    let s = freshGame();
    const draft = structuredClone(s);
    // 激活羁-01 且同场景
    draft.bonds.push({ pair: ['xiaoyu', 'liya'], status: 'active', cardUid: 'bond-01#0', replacedByBerserk: false, activeUsedRound: null });
    draft.characters['liya']!.scene = 'human_city';
    const events: GameEvent[] = [];
    dealDamageToCharacter(draft, events, { target: 'xiaoyu', damage: dmg(3) });
    // 3 = ceil 2 + floor 1，询问高份
    expect(draft.pendingDecision?.kind).toBe('choose_share_high');
    s = settle(draft); // 默认高份给第一个候选（小鱼 2，莉雅 1）
    // 羁-01：一次被击（含分摊与各自减免）为一个伤害事件，事件结算完毕后至少一方实承 >0
    // → 触发一次，两人各回 1（每事件合计 2，未受伤一方同样恢复）【裁A-47】
    // 小鱼 5-2+1=4；莉雅 5-1+1=5（不超上限）
    expect(s.characters['xiaoyu']?.hp).toBe(4);
    expect(s.characters['liya']?.hp).toBe(5);
  });

  it('分摊：偶数伤害免询问各半', () => {
    const s = freshGame();
    const draft = structuredClone(s);
    draft.bonds.push({ pair: ['xiaoyu', 'liya'], status: 'active', cardUid: 'bond-01#0', replacedByBerserk: false, activeUsedRound: null });
    draft.characters['liya']!.scene = 'human_city';
    const events: GameEvent[] = [];
    dealDamageToCharacter(draft, events, { target: 'xiaoyu', damage: dmg(4) });
    expect(draft.pendingDecision).toBeNull();
    expect(events.some((e) => e.kind === 'shared')).toBe(true);
    // 羁-01 事件级回血一次【裁A-47】：各 5-2+1=4
    expect(draft.characters['xiaoyu']?.hp).toBe(4);
    expect(draft.characters['liya']?.hp).toBe(4);
  });

  it('减免节点各自钳 0（守护之姿 -2 对 1 点伤害 → 0）', () => {
    const s = freshGame();
    const events: GameEvent[] = [];
    addBuff(s, { source: 'yu-04', kind: 'damage_reduce', value: 2, scene: 'human_city', scope: 'round' });
    dealDamageToCharacter(s, events, { target: 'xiaoyu', damage: dmg(1) });
    expect(s.characters['xiaoyu']?.hp).toBe(5);
  });

  it('出局：生命归零立即出局，全员出局判负 F3【裁A-06】', () => {
    const s = freshGame();
    const events: GameEvent[] = [];
    dealDamageToCharacter(s, events, { target: 'baye', damage: dmg(99) });
    expect(s.characters['baye']?.alive).toBe(false);
    expect(s.result).toBeNull();
    for (const c of ['xiaoyu', 'liya', 'kaier'] as const) {
      dealDamageToCharacter(s, events, { target: c, damage: dmg(99) });
    }
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('归零');
  });

  it('出局角色不可被选为伤害目标', () => {
    const s = freshGame();
    const events: GameEvent[] = [];
    dealDamageToCharacter(s, events, { target: 'baye', damage: dmg(99) });
    const hp = s.characters['baye']?.hp;
    dealDamageToCharacter(s, events, { target: 'baye', damage: dmg(1) });
    expect(s.characters['baye']?.hp).toBe(hp); // 不再结算
  });

  it('黑暗伤害触发小鱼侵蚀 T2（按事件计【裁A-35】）；非黑暗不触发', () => {
    const s = freshGame();
    const events: GameEvent[] = [];
    dealDamageToCharacter(s, events, { target: 'xiaoyu', damage: { base: 2, chain: [], source: 'crisis:test', dark: true, fromAttackCard: false } });
    expect(s.characters['xiaoyu']?.erosion).toBe(1);
    dealDamageToCharacter(s, events, { target: 'xiaoyu', damage: { base: 3, chain: [], source: 'test', dark: true, fromAttackCard: false } });
    expect(s.characters['xiaoyu']?.erosion).toBe(2); // 3 点伤害仍只 +1（按事件）
    dealDamageToCharacter(s, events, { target: 'xiaoyu', damage: dmg(1) });
    expect(s.characters['xiaoyu']?.erosion).toBe(2); // 非黑暗不加
  });
});

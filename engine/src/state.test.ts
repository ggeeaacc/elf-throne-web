import { describe, expect, it } from 'vitest';
import { createInitialState } from './state.js';
import type { GameConfig } from './types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 12345,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};

describe('createInitialState（§四 游戏准备）', () => {
  it('四人局：阵容/起始位置/血量/手牌（§四.第二/三步）', () => {
    const s = createInitialState(cfg4);
    expect(s.turnOrder).toEqual(['xiaoyu', 'liya', 'kaier', 'baye']);
    expect(s.characters['xiaoyu']?.scene).toBe('human_city');
    expect(s.characters['baye']?.scene).toBe('human_city');
    expect(s.characters['liya']?.scene).toBe('elf_kingdom');
    expect(s.characters['kaier']?.scene).toBe('elf_kingdom');
    for (const ch of Object.values(s.characters)) {
      expect(ch.hp).toBe(5);
      expect(ch.maxHp).toBe(5);
      expect(ch.hand).toHaveLength(4); // §四.第四步：起始手牌 4 张
      expect(ch.deck).toHaveLength(6); // 10 张专属牌库 - 4 手牌
    }
    // 巴爷飞空艇标记（位置恒随巴爷【裁A-13】，仅记可用/冷却）
    expect(s.characters['baye']?.airship).toEqual({ cooldownRounds: 0 });
  });

  it('四人局：公共牌库与通牒卡（§四.第四步）', () => {
    const s = createInitialState(cfg4);
    expect(s.decks.crisis).toHaveLength(29); // 30 - 1 张通牒垂置
    expect(s.ultimatumAsideUid).toMatch(/^crisis-09#/);
    expect(s.decks.bond).toHaveLength(9); // 10 - 凯尔×莉雅开局领取羁-07（§5.3）
    expect(s.decks.letter).toHaveLength(10);
    expect(s.equipmentDisplay).toHaveLength(10);
    // 危机牌库恰含全部 30 张（29 + 垂置 1）
    const all = [...s.decks.crisis, s.ultimatumAsideUid].sort();
    expect(new Set(all).size).toBe(30);
  });

  it('初始羁绊：小鱼×莉雅未激活无卡；凯尔×莉雅激活持羁-07（§5.3【裁A-18】）', () => {
    const s = createInitialState(cfg4);
    const xy = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    const kl = s.bonds.find((b) => b.pair.includes('kaier') && b.pair.includes('liya'));
    expect(xy).toMatchObject({ status: 'inactive', cardUid: null });
    expect(kl?.status).toBe('active');
    expect(kl?.cardUid).toMatch(/^bond-07#/);
  });

  it('初始相位与时间轴（§四.第五步）', () => {
    const s = createInitialState(cfg4);
    expect(s.phase).toEqual({ kind: 'crisis', day: 1, segment: 'dawn', round: 1 });
    expect(s.boss).toBeNull();
    expect(s.result).toBeNull();
  });

  it('确定性：同种子逐字节同态，异种子牌库序不同', () => {
    const a = createInitialState(cfg4);
    const b = createInitialState(cfg4);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = createInitialState({ ...cfg4, seed: 999 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('三人局：弃巴爷，4 AP / 6 血（§四.人数差异总表）', () => {
    const s = createInitialState({
      playerCount: 3,
      seed: 1,
      benchCharacter: 'baye',
      seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'] },
    });
    expect(s.turnOrder).toEqual(['xiaoyu', 'liya', 'kaier']);
    expect(s.characters['baye']).toBeUndefined();
    expect(s.characters['xiaoyu']?.maxHp).toBe(6);
  });

  it('三人局未指定弃用角色则拒绝', () => {
    expect(() =>
      createInitialState({
        playerCount: 3,
        seed: 1,
        seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'] },
      }),
    ).toThrow(/弃用角色/);
  });

  it('单人局：0 号座双控小鱼+莉雅（§八）', () => {
    const s = createInitialState({
      playerCount: 1,
      seed: 1,
      seatAssignments: { 0: ['xiaoyu', 'liya'] },
    });
    expect(s.turnOrder).toEqual(['xiaoyu', 'liya']);
    expect(s.characters['kaier']).toBeUndefined();
    expect(s.characters['baye']).toBeUndefined();
  });

  it('未分配的出场角色会被拒绝', () => {
    expect(() =>
      createInitialState({
        playerCount: 4,
        seed: 1,
        seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: [] },
      }),
    ).toThrow(/未分配/);
  });
});

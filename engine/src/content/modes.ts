import type { ModeRules, PlayerCount } from '../types.js';

/**
 * 人数变体唯一出处（control-manifest §4）。
 * 数据源：规则书 §四.「人数差异总表」、§五.第一阶段翻牌表、§七、§八。
 *
 * R1 歧义记录：单人玫拉血量——人数总表与 §八单人规则为 12，§七写 10；
 * 此处取 12（两处口径对一处），可由 GameConfig.soloBossHpOverride 覆盖。
 */
export const MODE_TABLE: Record<PlayerCount, ModeRules> = {
  4: {
    apPerTurn: 3,
    maxHp: 5,
    prejudice: true,
    collapseThreshold: 4,
    bossHp: 26,
    shieldLayers: 3,
    shieldHpPerLayer: 4,
    crisisFlips: { 1: [2, 2, 2], 2: [2, 2, 3], 3: [3, 3, 3] },
    finalSupply: 0,
  },
  3: {
    apPerTurn: 4,
    maxHp: 6,
    prejudice: true,
    collapseThreshold: 4,
    bossHp: 22,
    shieldLayers: 3,
    shieldHpPerLayer: 3,
    crisisFlips: { 1: [2, 2, 2], 2: [2, 2, 3], 3: [3, 3, 3] },
    finalSupply: 0,
  },
  2: {
    apPerTurn: 3,
    maxHp: 5,
    prejudice: false,
    collapseThreshold: 5,
    bossHp: 20,
    shieldLayers: 3,
    shieldHpPerLayer: 3,
    crisisFlips: { 1: [1, 2, 2], 2: [2, 2, 2], 3: [2, 3, 3] },
    finalSupply: 2,
  },
  1: {
    apPerTurn: 3,
    maxHp: 5,
    prejudice: false,
    collapseThreshold: 5,
    bossHp: 18,
    shieldLayers: 3,
    shieldHpPerLayer: 3,
    crisisFlips: { 1: [1, 2, 2], 2: [2, 2, 2], 3: [2, 3, 3] },
    finalSupply: 2,
  },
};

/** 各人数出场角色（规则书 §四.第二步、§八） */
export function activeCharactersFor(playerCount: PlayerCount, bench?: 'kaier' | 'baye'): Array<'xiaoyu' | 'liya' | 'kaier' | 'baye'> {
  switch (playerCount) {
    case 4:
      return ['xiaoyu', 'liya', 'kaier', 'baye'];
    case 3:
      if (!bench) throw new Error('三人局必须指定弃用角色（kaier 或 baye）');
      return bench === 'baye' ? ['xiaoyu', 'liya', 'kaier'] : ['xiaoyu', 'liya', 'baye'];
    case 2:
    case 1:
      return ['xiaoyu', 'liya'];
  }
}

import type { SceneId } from '../types.js';

/** 场景静态定义（规则书 §四.第一步 + §五.场景行动） */
export interface SceneDef {
  id: SceneId;
  name: string;
  /** 相邻场景（移动只能沿相邻路径） */
  adjacent: SceneId[];
  /** 场景专属机制原文 */
  text: string;
}

export const SCENES: Record<SceneId, SceneDef> = {
  human_city: {
    id: 'human_city',
    name: '人类王城',
    adjacent: ['dark_valley', 'ancient_battlefield'],
    text: '专属增益：在此场景执行【锻造】行动时，所需的行动点和材料消耗都-1。',
  },
  elf_kingdom: {
    id: 'elf_kingdom',
    name: '精灵王国',
    adjacent: ['ancient_battlefield', 'dark_valley'],
    text: '专属行动（1行动点）：生命树的治愈。恢复自身或同场景一名角色1点生命值，并获得一个绿色净化指示物。每名角色每轮限执行一次。',
  },
  ancient_battlefield: {
    id: 'ancient_battlefield',
    name: '古战场废墟',
    adjacent: ['human_city', 'elf_kingdom'],
    text: '专属行动（1行动点）：侦查敌情。查看危机牌库顶的两张卡，将其中一张放置于牌库底，另一张放回牌库顶。',
  },
  dark_valley: {
    id: 'dark_valley',
    name: '黑暗山谷',
    adjacent: ['human_city', 'elf_kingdom'],
    text: '专属行动（3行动点）：营救女王（额外支付2净化指示物，一局一次）。专属行动（1行动点）：寻找宠物（一局一次）。',
  },
};

export function isAdjacent(from: SceneId, to: SceneId): boolean {
  return SCENES[from].adjacent.includes(to);
}

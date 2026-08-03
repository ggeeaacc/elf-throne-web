import type { CharacterId, Race, SceneId } from '../types.js';

/** 角色静态定义（规则书 §四.第二步 + 附录A） */
export interface CharacterDef {
  id: CharacterId;
  name: string;
  race: Race;
  startScene: SceneId;
  /** 被动技能原文（效果结算属 Task #1 systems） */
  passiveText: string;
}

export const CHARACTERS: Record<CharacterId, CharacterDef> = {
  xiaoyu: {
    id: 'xiaoyu',
    name: '小鱼',
    race: 'human',
    startScene: 'human_city',
    passiveText: '屠龙者之血：小鱼对玫拉造成的伤害+1。',
  },
  liya: {
    id: 'liya',
    name: '莉雅',
    race: 'elf',
    startScene: 'elf_kingdom',
    passiveText: '精灵神射：莉雅的攻击卡可以指定相邻场景的危机卡为目标；指定相邻场景时伤害+1。',
  },
  kaier: {
    id: 'kaier',
    name: '凯尔',
    race: 'elf',
    startScene: 'elf_kingdom',
    passiveText: '公爵威严：凯尔在场时，同场景的精灵角色（莉雅）受到的伤害-1；若该精灵已与人类结成羁绊并拥有羁绊卡，此效果翻倍（-2）。',
  },
  baye: {
    id: 'baye',
    name: '巴爷',
    race: 'human',
    startScene: 'human_city',
    passiveText: '小鱼号：每两轮一次，巴爷可不消耗行动点进行飞空艇移动至任意场景，并可携带同场景一名友方角色同行。',
  },
};

/** 回合固定顺序（规则书 §五.第二阶段） */
export const TURN_ORDER_FULL: CharacterId[] = ['xiaoyu', 'liya', 'kaier', 'baye'];

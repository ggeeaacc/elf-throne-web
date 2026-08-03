import type { CrisisCardDef } from '../types.js';

/**
 * 30 张危机卡（规则书 附录E）。
 * scene 'any' = 通用，落点由玩家协商（PendingDecision.place_generic_crisis）。
 */
export const CRISIS_CARDS: CrisisCardDef[] = [
  { id: 'crisis-01', code: '危-01', name: '黑暗突袭', copies: 5, scene: 'any', crisisValue: 4, dark: false, text: '无。' },
  { id: 'crisis-02', code: '危-02', name: '精灵亡魂', copies: 3, scene: 'ancient_battlefield', crisisValue: 4, dark: true, text: '每轮结束时，此卡所在场景的一名角色受到1点伤害。清除此卡时，此场景的一名角色抽一张牌并获得一个材料指示物。' },
  { id: 'crisis-03', code: '危-03', name: '精灵亡魂', copies: 2, scene: 'dark_valley', crisisValue: 4, dark: true, text: '每轮结束时，此卡所在场景的一名角色受到1点伤害。清除此卡时，此场景的一名角色抽一张牌并获得一个材料指示物。' },
  { id: 'crisis-04', code: '危-04', name: '黑暗宝玉侵蚀', copies: 4, scene: 'any', crisisValue: 4, dark: true, text: '每轮结束时，如果小鱼在此场景，小鱼获得一个黑色侵蚀指示物；如果小鱼不在此场景，此场景所有角色受到1点伤害。清除此卡时，此场景的一名角色获得一个绿色净化指示物并抽一张牌。' },
  { id: 'crisis-05', code: '危-05', name: '火山喷发', copies: 4, scene: 'dark_valley', crisisValue: 4, dark: false, text: '每轮结束时，此场景所有角色受到1点伤害。清除此卡时，所有参与清除的角色各获得两个材料指示物。' },
  { id: 'crisis-06', code: '危-06', name: '黑暗战船', copies: 3, scene: 'dark_valley', crisisValue: 4, dark: false, text: '此卡所在场景的角色无法执行锻造行动。清除此卡时，可立即免费从锻造展示区取一张装备卡。' },
  { id: 'crisis-07', code: '危-07', name: '黑暗迷雾', copies: 4, scene: 'any', crisisValue: 4, dark: false, text: '此卡所在场景内，所有远程攻击效果失效，且该场景内角色的手牌上限-1。清除此卡时，此场景的一名角色抽一张牌，并使此场景所有角色恢复1点生命值。' },
  { id: 'crisis-08', code: '危-08', name: '族群隔阂', copies: 2, scene: 'any', crisisValue: 1, dark: false, text: '无持续效果。清除此卡时，获得一个绿色净化指示物。' },
  { id: 'crisis-09', code: '危-09', name: '三日通牒', copies: 2, scene: 'ancient_battlefield', crisisValue: 4, dark: true, text: '若尚未翻出，此卡在第2天黄昏自动翻出。每轮结束时，玫拉的献祭进度+1。如果献祭进度达到3，决战阶段玫拉的初始生命值+3。清除此卡时，获得三个绿色净化指示物。' },
  { id: 'crisis-10', code: '危-10', name: '玫拉的化身', copies: 1, scene: 'ancient_battlefield', crisisValue: 6, dark: true, text: '此卡被清除后，所有角色恢复至满生命值。如果此卡在第三天深夜前未被清除，决战中玫拉初始生命值+2。' },
];

export const CRISIS_CARD_BY_ID: ReadonlyMap<string, CrisisCardDef> = new Map(CRISIS_CARDS.map((c) => [c.id, c]));

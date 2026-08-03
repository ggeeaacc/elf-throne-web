import type { ActionCardDef } from '../types.js';

/**
 * 40 张专属行动卡（规则书 附录A）。
 * 本表只落元数据与卡面原文；效果结算在 systems（Task #1）注册。
 */
export const ACTION_CARDS: ActionCardDef[] = [
  // ── A.1 小鱼 ──
  { id: 'yu-01', code: '鱼-01', name: '横斩', character: 'xiaoyu', tags: ['attack'], material: false, costAP: 1, remote: false, text: '对当前场景一张危机卡造成3点伤害。' },
  { id: 'yu-02', code: '鱼-02', name: '铁匠锻造', character: 'xiaoyu', tags: ['resource'], material: true, costAP: 1, remote: false, text: '获得两个材料指示物。本卡带有【材】标记。' },
  { id: 'yu-03', code: '鱼-03', name: '纵斩突进', character: 'xiaoyu', tags: ['attack', 'move'], material: false, costAP: 1, remote: false, text: '移动到一个相邻场景，并对该场景一张危机卡造成2点伤害。如果该场景已有巴爷在场，伤害+1。' },
  { id: 'yu-04', code: '鱼-04', name: '守护之姿', character: 'xiaoyu', tags: ['defense'], material: true, costAP: 1, remote: false, text: '本轮内，你所在场景的所有友方角色受到的伤害-2（最低减至0）。本卡带有【材】标记。' },
  { id: 'yu-05', code: '鱼-05', name: '十字剑气', character: 'xiaoyu', tags: ['attack'], material: false, costAP: 1, remote: false, text: '对一张危机卡造成4点伤害。结算后自己在角色卡上放置一个黑色侵蚀指示物。' },
  { id: 'yu-06', code: '鱼-06', name: '意志抵抗', character: 'xiaoyu', tags: ['heal'], material: false, costAP: 1, remote: false, text: '移除自己角色卡上的至多两个黑色侵蚀指示物。如果当前无侵蚀指示物，改为恢复2点生命值。' },
  { id: 'yu-07', code: '鱼-07', name: '像鸟一样飞！', character: 'xiaoyu', tags: ['move'], material: false, costAP: 1, remote: false, text: '移动至任意一张有莉雅在场的场景。如果此举使你与莉雅同处一地，双方各抽一张牌。' },
  { id: 'yu-08', code: '鱼-08', name: '多节变形弓', character: 'xiaoyu', tags: ['attack'], material: false, costAP: 1, remote: 'conditional', text: '对当前场景或一个相邻场景中的至多两张危机卡各造成1点伤害。' },
  { id: 'yu-09', code: '鱼-09', name: '并肩而立', character: 'xiaoyu', tags: ['special'], material: true, costAP: 1, remote: false, text: '仅当与莉雅处于同一场景时可打出。双方各恢复2点生命值，且小鱼移除一个黑色侵蚀指示物。本卡带有【材】标记。' },
  { id: 'yu-10', code: '鱼-10', name: '为爱而战', character: 'xiaoyu', tags: ['attack'], material: false, costAP: 1, remote: false, text: '对一张危机卡造成X点伤害，X等于当前小鱼角色卡上的黑色侵蚀指示物数量+1。如果莉雅本轮已受过伤害，X再+2。' },
  // ── A.2 莉雅 ──
  { id: 'ya-01', code: '雅-01', name: '精灵箭', character: 'liya', tags: ['attack'], material: false, costAP: 1, remote: 'conditional', text: '对一张危机卡造成3点伤害。该危机必须位于你当前场景或相邻场景。如果此攻击导致该危机卡被清除，本卡在结算后收回手牌，不进入弃牌堆。' },
  { id: 'ya-02', code: '雅-02', name: '滞空跳跃', character: 'liya', tags: ['move'], material: true, costAP: 1, remote: false, text: '移动至多两个场景（可以跨越不相邻的场景，无需沿路径）。本卡带有【材】标记。' },
  { id: 'ya-03', code: '雅-03', name: '精灵地图', character: 'liya', tags: ['support'], material: false, costAP: 1, remote: false, text: '查看危机牌库顶三张卡，按任意顺序放回。如果其中有黑暗标记【暗】的卡，将其置于牌库底。' },
  { id: 'ya-04', code: '雅-04', name: '治愈之矢', character: 'liya', tags: ['heal'], material: false, costAP: 1, remote: false, text: '恢复任意一名角色2点生命值。如果目标为小鱼且小鱼处于失控状态，额外移除一个黑色侵蚀指示物。' },
  { id: 'ya-05', code: '雅-05', name: '生命宝玉', character: 'liya', tags: ['special'], material: false, costAP: 1, remote: false, text: '仅当与小鱼处于同一场景且小鱼拥有至少一个黑色侵蚀指示物时可打出。清空小鱼所有黑色侵蚀指示物，恢复小鱼至满生命值。自身永久扣除1点生命值上限。本效果一局最多使用两次。' },
  { id: 'ya-06', code: '雅-06', name: '箭雨', character: 'liya', tags: ['attack'], material: false, costAP: 1, remote: false, text: '对当前场景至多2张危机卡各造成2点伤害。' },
  { id: 'ya-07', code: '雅-07', name: '风之加护', character: 'liya', tags: ['support'], material: false, costAP: 1, remote: false, text: '本轮内，指定一名同场景的友方角色，其下一次攻击伤害+2。' },
  { id: 'ya-08', code: '雅-08', name: '精灵誓约', character: 'liya', tags: ['support'], material: false, costAP: 1, remote: false, text: '仅当与小鱼同处一地时可打出。双方各抽一张牌，且小鱼获得1点额外行动点（仅限小鱼的下一个回合使用，不可累积）。' },
  { id: 'ya-09', code: '雅-09', name: '追踪箭', character: 'liya', tags: ['attack'], material: false, costAP: 1, remote: true, text: '对任意场景的一张危机卡造成3点伤害。' },
  { id: 'ya-10', code: '雅-10', name: '为你而来', character: 'liya', tags: ['move', 'special'], material: true, costAP: 1, remote: false, text: '移动至小鱼所在场景。如果途中经过的场景存在未解决的危机，可对其中一张造成1点伤害。本卡带有【材】标记。' },
  // ── A.3 凯尔 ──
  { id: 'kai-01', code: '凯-01', name: '公爵之令', character: 'kaier', tags: ['support'], material: false, costAP: 1, remote: false, text: '指定一名友方角色，其下一个回合额外获得1个行动点并抽1张牌。' },
  { id: 'kai-02', code: '凯-02', name: '精灵剑术', character: 'kaier', tags: ['attack'], material: false, costAP: 1, remote: false, text: '对当前场景一张危机卡造成4点伤害。如果本轮你已使用过"偏见"，此伤害+1。' },
  { id: 'kai-03', code: '凯-03', name: '战术转移', character: 'kaier', tags: ['move'], material: false, costAP: 1, remote: false, text: '将自身与同场景的一名友方角色一同移动至一个相邻场景。两名角色均不消耗各自的行动点。' },
  { id: 'kai-04', code: '凯-04', name: '王夫之怒', character: 'kaier', tags: ['attack'], material: true, costAP: 1, remote: false, text: '对一张危机卡造成伤害，数值等于当前古战场废墟场景下方的危机卡数量+2。本卡带有【材】标记。' },
  { id: 'kai-05', code: '凯-05', name: '偏见', character: 'kaier', tags: ['special'], material: false, costAP: 0, remote: false, text: '主动在当前场景触发一次偏见效果（从危机牌库顶翻一张危机卡放置于此），并使你本轮造成的伤害+2。使用此卡不消耗行动点，每轮限用一次。' },
  { id: 'kai-06', code: '凯-06', name: '贵族决断', character: 'kaier', tags: ['support'], material: false, costAP: 1, remote: false, text: '弃置手中任意两张卡牌，从个人牌库中抽取三张卡加入手牌。' },
  { id: 'kai-07', code: '凯-07', name: '护卫誓言', character: 'kaier', tags: ['defense'], material: false, costAP: 1, remote: false, text: '本轮内，指定一名同场景友方角色受到的下一次伤害由你代为承受。如果代为承受的伤害来源于带有黑暗标记的危机，你获得一个材料指示物。' },
  { id: 'kai-08', code: '凯-08', name: '破晓冲锋', character: 'kaier', tags: ['attack'], material: false, costAP: 1, remote: false, text: '对当前场景至多两张危机卡各造成2点伤害。结算后，本轮剩余行动点归零，无法再进行任何行动。' },
  { id: 'kai-09', code: '凯-09', name: '精灵荣光', character: 'kaier', tags: ['support'], material: false, costAP: 1, remote: false, text: '本轮内，你所在场景的所有友方角色攻击伤害+2。如果你已与巴爷结成羁绊，本效果额外持续至下一轮。' },
  { id: 'kai-10', code: '凯-10', name: '为妻而战', character: 'kaier', tags: ['attack'], material: false, costAP: 1, remote: true, text: '仅当古战场废墟场景下方存在危机卡时可打出。对任意场景的一张危机卡造成4点伤害。如果古战场废墟下方已无危机卡，改为造成6点伤害。' },
  // ── A.4 巴爷 ──
  { id: 'ba-01', code: '巴-01', name: '舰炮轰击', character: 'baye', tags: ['attack'], material: false, costAP: 1, remote: true, text: '消耗1个行动点。对任意场景的一张危机卡造成3点伤害。' },
  { id: 'ba-02', code: '巴-02', name: '侠盗直觉', character: 'baye', tags: ['resource'], material: true, costAP: 1, remote: false, text: '从个人牌库抽三张卡，选择其中两张加入手牌，剩余一张弃置，并获得1个【材】标记。本卡带有【材】标记。' },
  { id: 'ba-03', code: '巴-03', name: '老练格挡', character: 'baye', tags: ['defense'], material: false, costAP: 1, remote: false, text: '本轮内，你受到的所有伤害-2（最低减至0）。结算后抽一张卡。' },
  { id: 'ba-04', code: '巴-04', name: '弩炮掩护', character: 'baye', tags: ['support'], material: false, costAP: 1, remote: false, text: '本轮内，所有与你在同一场景或相邻场景的友方角色，攻击伤害+1。' },
  { id: 'ba-05', code: '巴-05', name: '紧急融资', character: 'baye', tags: ['resource'], material: false, costAP: 1, remote: false, text: '弃置一张装备卡，本轮获得3个额外行动点。这些额外行动点仅可在当前回合使用，未用完即消失。如果无装备可弃置，改为失去1点生命值，获得2个额外行动点。' },
  { id: 'ba-06', code: '巴-06', name: '孤胆英雄', character: 'baye', tags: ['attack'], material: false, costAP: 1, remote: false, text: '对当前场景一张危机卡造成3点伤害。如果你当前所在场景没有其他友方角色，造成伤害翻倍。' },
  { id: 'ba-07', code: '巴-07', name: '战地抢修', character: 'baye', tags: ['support', 'attack'], material: false, costAP: 1, remote: false, text: '对当前场景一张危机卡造成1点伤害。选择锻造展示区中的一张装备卡，在下一次锻造时，该装备的锻造所需行动点和材料-1。' },
  { id: 'ba-08', code: '巴-08', name: '王牌驾驶员', character: 'baye', tags: ['move', 'attack'], material: false, costAP: 1, remote: false, text: '使用飞空艇移动至任意场景（不消耗本轮飞空艇次数），并对目标场景一张危机卡造成2点伤害。' },
  { id: 'ba-09', code: '巴-09', name: '生死之交', character: 'baye', tags: ['defense', 'special'], material: false, costAP: 1, remote: false, text: '仅当与凯尔处于同一场景时可打出。巴爷与凯尔共同承担本轮所有伤害，每人受到伤害减半（向上取整）。如果两人已结成羁绊，则双方各恢复1点生命值。' },
  { id: 'ba-10', code: '巴-10', name: '最终航班', character: 'baye', tags: ['move'], material: false, costAP: 1, remote: false, text: '一局游戏限用一次。所有友方角色（无论身处哪个场景）移动至你当前所在场景。此移动不消耗任何角色的行动点。使用后本卡移出游戏。' },
];

export const ACTION_CARD_BY_ID: ReadonlyMap<string, ActionCardDef> = new Map(ACTION_CARDS.map((c) => [c.id, c]));

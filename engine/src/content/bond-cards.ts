import type { BondCardDef, LetterCardDef, EquipmentCardDef } from '../types.js';

/** 10 张羁绊卡（规则书 附录C） */
export const BOND_CARDS: BondCardDef[] = [
  { id: 'bond-01', code: '羁-01', name: '异世界同生死', pair: ['xiaoyu', 'liya'], requiresMixedRace: false, text: '被动：两人处于同一场景时，双方生命值共享，任意一方受到伤害时两人各承担一半（向上取整），每次承受伤害后两人各恢复1点生命值。主动：双方立即各恢复2点生命值，并从各自牌库各抽一张牌。' },
  { id: 'bond-02', code: '羁-02', name: '碧眼含泪箭无情，赤眼无情箭无锋', pair: ['xiaoyu', 'liya'], requiresMixedRace: false, text: '被动：小鱼受到带有黑暗标记的伤害时，莉雅可选择代为承受。主动：移除小鱼至多1个黑色侵蚀指示物。' },
  { id: 'bond-03', code: '羁-03', name: '并肩作战', pair: 'any', requiresMixedRace: false, text: '被动：双方处于同一场景时，各获得攻击伤害+1。主动：双方立即各对当前场景一张危机卡造成2点伤害。' },
  { id: 'bond-04', code: '羁-04', name: '托付后背', pair: 'any', requiresMixedRace: false, text: '被动：双方处于不同场景时，每人每轮受到的第一次伤害-1。主动：立刻交换双方所在位置。' },
  { id: 'bond-05', code: '羁-05', name: '偏见破除', pair: 'any', requiresMixedRace: true, text: '被动：双方处于同一场景时，不再因任何原因触发偏见；双方清除危机时额外获得一个材料指示物。主动：在任意场景放置一个绿色净化指示物——该场景下次被放置危机卡时，改为弃置该危机卡并移除净化指示物。' },
  { id: 'bond-06', code: '羁-06', name: '殊途同归', pair: ['kaier', 'baye'], requiresMixedRace: false, text: '被动：双方处于同一场景时，凯尔的防御效果同时作用于巴爷，巴爷的攻击加成同时作用于凯尔。主动：双方立即各对一个危机卡造成3点伤害。' },
  { id: 'bond-07', code: '羁-07', name: '兄妹同心', pair: ['kaier', 'liya'], requiresMixedRace: false, text: '被动：处于同一场景时，任意一方打出卡牌时，另一方可以弃置一张同类型卡牌来复制其效果（攻击复制攻击，防御复制防御，辅助复制辅助）。复制出的效果减半（伤害值、恢复值、行动点数均减半，向下取整）。主动：双方共同从各自牌库中各抽取两张卡。' },
  { id: 'bond-08', code: '羁-08', name: '师父与徒弟', pair: ['xiaoyu', 'baye'], requiresMixedRace: false, text: '被动：双方处于同一场景时，每次合力清除一张危机卡后，各恢复1点生命值。主动：本轮内，两人攻击伤害各+2，且可任意分配伤害给当前场景的多个目标。' },
  { id: 'bond-09', code: '羁-09', name: '游侠之风', pair: ['liya', 'baye'], requiresMixedRace: false, text: '被动：巴爷每轮一次的飞空艇移动若携带莉雅同行，莉雅可在到达后立刻免费进行一次远程攻击（伤害2点）。主动：巴爷替莉雅承受下一次伤害，且该伤害-2。' },
  { id: 'bond-10', code: '羁-10', name: '公爵的认可', pair: ['xiaoyu', 'kaier'], requiresMixedRace: false, text: '被动：两人首次共同清除一张危机卡后，各获得一件免费锻造（仅触发一次）。主动：本轮内，两人无论身处哪个场景，均可为对方分担一半伤害。' },
];

/** 传书卡：5 种 ×2（规则书 附录D） */
export const LETTER_CARDS: LetterCardDef[] = [
  { id: 'letter-01', code: '传-01', name: '思念成疾', copies: 2, text: '接收方恢复2点生命值并抽一张牌。如果是小鱼，额外移除一个黑色侵蚀指示物。如果是莉雅，额外抽一张牌。' },
  { id: 'letter-02', code: '传-02', name: '信物·飞箭', copies: 2, text: '接收方获得一个材料指示物，并获得一张"信物"标记。在后续任意一次攻击中，可弃置此标记使该次攻击伤害+2。' },
  { id: 'letter-03', code: '传-03', name: '遥远的拥抱', copies: 2, text: '发送方与接收方各自从牌库中抽取一张卡。两人即使身处不同场景，本轮内各受到的下一次伤害-1。' },
  { id: 'letter-04', code: '传-04', name: '誓约之言', copies: 2, text: '接收方将一张手牌传给发送方。此传递在下一次发送方回合开始时生效。' },
  { id: 'letter-05', code: '传-05', name: '见字如面', copies: 2, text: '发送方与接收方各自恢复1点生命值。双方各查看对方的手牌（不交换），然后各自可以弃置手中一张卡并从牌库中抽一张替换。' },
];

/** 装备卡：5 种 ×2（规则书 附录B） */
export const EQUIPMENT_CARDS: EquipmentCardDef[] = [
  { id: 'equip-01', code: '装-01', name: '龙鳞护甲', copies: 2, text: '被动：持有者受到的伤害-1（最低减至0）。主动（1行动点）：本轮受到的伤害再-1（最低减至0）。' },
  { id: 'equip-02', code: '装-02', name: '精灵长弓', copies: 2, text: '被动：持有者的攻击伤害+1。主动（0行动点）：本次攻击被视为远程攻击。' },
  { id: 'equip-03', code: '装-03', name: '精铸阔刃剑', copies: 2, text: '被动：持有者清除一张危机卡时，对同场景另一张危机卡造成1点伤害。主动（1行动点）：本轮对玫拉（决战中）的攻击伤害+2。' },
  { id: 'equip-04', code: '装-04', name: '守护之戒', copies: 2, text: '被动：持有者的生命值上限+2，并立即恢复2点生命值。主动（1行动点）：恢复同场景一名角色1点生命值。' },
  { id: 'equip-05', code: '装-05', name: '飞行滑板', copies: 2, text: '被动：持有者每次移动可以额外移动一个场景；若持有者为小鱼，其每回合第一次移动不消耗行动点。主动（1行动点）：移动至任意场景。' },
];

export const BOND_CARD_BY_ID: ReadonlyMap<string, BondCardDef> = new Map(BOND_CARDS.map((c) => [c.id, c]));
export const LETTER_CARD_BY_ID: ReadonlyMap<string, LetterCardDef> = new Map(LETTER_CARDS.map((c) => [c.id, c]));
export const EQUIPMENT_CARD_BY_ID: ReadonlyMap<string, EquipmentCardDef> = new Map(EQUIPMENT_CARDS.map((c) => [c.id, c]));

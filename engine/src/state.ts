/**
 * createInitialState：完整实现规则书 §四「游戏准备」（含人数变体）。
 * 确定性：所有洗牌经 state.rng（mulberry32 游标），同种子逐字节同态。
 */
import { createRng } from './rng.js';
import { CHARACTERS, TURN_ORDER_FULL } from './content/characters.js';
import { SCENES } from './content/scenes.js';
import { MODE_TABLE, activeCharactersFor } from './content/modes.js';
import { ACTION_CARDS } from './content/action-cards.js';
import { CRISIS_CARDS } from './content/crisis-cards.js';
import { BOND_CARDS, LETTER_CARDS, EQUIPMENT_CARDS } from './content/bond-cards.js';
import type {
  CardInstance,
  CharacterId,
  CharacterState,
  GameConfig,
  GameState,
  SceneId,
  SceneState,
} from './types.js';

function makeInstances(defId: string, kind: CardInstance['kind'], copies: number, registry: Record<string, CardInstance>): string[] {
  const uids: string[] = [];
  for (let i = 0; i < copies; i++) {
    const uid = `${defId}#${i}`;
    registry[uid] = { uid, defId, kind };
    uids.push(uid);
  }
  return uids;
}

export function createInitialState(config: GameConfig): GameState {
  validateConfig(config);
  const mode = MODE_TABLE[config.playerCount];
  const rng = createRng(config.seed);
  const cards: Record<string, CardInstance> = {};

  // §四.第一步：版图（场景相邻关系为静态数据，此处只建空场景状态）
  const scenes = {} as Record<SceneId, SceneState>;
  for (const id of Object.keys(SCENES) as SceneId[]) {
    scenes[id] = { id, crisisCards: [], crisisDamage: {} };
  }

  // §四.第四步：公共牌库
  const allCrisisUids = CRISIS_CARDS.flatMap((d) => makeInstances(d.id, 'crisis', d.copies, cards));
  // 两张「三日通牒」：一张置于一旁作为通牒卡，另一张洗回牌库
  const ultimatumUid = allCrisisUids.find((u) => u.startsWith('crisis-09#')) ?? null;
  const crisisDeck = rng.shuffle(allCrisisUids.filter((u) => u !== ultimatumUid));
  const bondDeck = rng.shuffle(BOND_CARDS.flatMap((d) => makeInstances(d.id, 'bond', 1, cards)));
  const letterDeck = rng.shuffle(LETTER_CARDS.flatMap((d) => makeInstances(d.id, 'letter', d.copies, cards)));
  // 装备卡正面朝上排列于锻造展示区（不洗牌，按定义顺序）
  const equipmentDisplay = EQUIPMENT_CARDS.flatMap((d) => makeInstances(d.id, 'equipment', d.copies, cards));

  // §四.第二/三步：角色、起始位置、生命、专属牌库与起始手牌
  const active = activeCharactersFor(config.playerCount, config.benchCharacter);
  const characters: Record<string, CharacterState> = {};
  for (const cid of TURN_ORDER_FULL) {
    if (!active.includes(cid)) continue;
    const def = CHARACTERS[cid];
    const deck = rng.shuffle(
      ACTION_CARDS.filter((c) => c.character === cid).flatMap((c) => makeInstances(c.id, 'action', 1, cards)),
    );
    const hand = deck.splice(0, 4); // 起始手牌 4 张
    characters[cid] = {
      id: cid,
      scene: def.startScene,
      hp: mode.maxHp,
      maxHp: mode.maxHp,
      erosion: 0,
      hand,
      deck,
      discard: [],
      equipment: [],
      materialTokens: 0,
      purifyTokens: 0,
      bondTokens: 0,
      charms: 0,
      hasPet: false,
      pendingLetter: null,
      pendingReverseLetter: null,
      lettersSentThisRound: 0,
      lettersReceivedThisRound: 0,
      nextTurnApBonus: 0,
      nextTurnDraw: 0,
      freeMoveUsedThisTurn: false,
      damagedThisRound: false,
      ap: 0,
      alive: true,
    };
  }
  // 巴爷飞空艇标记（位置恒随巴爷【裁A-13】）
  const baye = characters['baye'] as CharacterState | undefined;
  if (baye) baye.airship = { cooldownRounds: 0 };

  // §5.3 初始羁绊【裁A-04, A-18】：
  //   小鱼×莉雅 已结成未激活（无卡）；凯尔×莉雅 默认激活并直接领取羁-07（从牌库取出）
  const bonds: GameState['bonds'] = [];
  if (active.includes('xiaoyu') && active.includes('liya')) {
    bonds.push({ pair: ['xiaoyu', 'liya'], status: 'inactive', cardUid: null, replacedByBerserk: false, activeUsedRound: null });
  }
  if (active.includes('kaier') && active.includes('liya')) {
    const uid = bondDeck.find((u) => cards[u]?.defId === 'bond-07') ?? null;
    if (uid) {
      bondDeck.splice(bondDeck.indexOf(uid), 1);
      bonds.push({ pair: ['liya', 'kaier'], status: 'active', cardUid: uid, replacedByBerserk: false, activeUsedRound: null });
    }
  }

  // 回合顺序：按座位顺时针排列（非固定角色ID顺序），使选角不影响行动顺序
  const turnOrder: CharacterId[] = [];
  for (let seat = 0; seat < config.playerCount; seat++) {
    for (const c of config.seatAssignments[seat] ?? []) {
      if (active.includes(c) && !turnOrder.includes(c)) turnOrder.push(c);
    }
  }
  // 安全兜底：未被 seatAssignments 覆盖的激活角色追加到末尾（防御性，正常不触发）
  for (const c of active) {
    if (!turnOrder.includes(c)) turnOrder.push(c);
  }

  const state: GameState = {
    schemaVersion: 1,
    config,
    rng: { seed: config.seed, cursor: rng.cursor() },
    phase: { kind: 'crisis', day: 1, segment: 'dawn', round: 1 },
    turnOrder,
    turnPointer: 0,
    characters,
    scenes,
    currentTurn: null,
    cards,
    decks: { crisis: crisisDeck, crisisDiscard: [], bond: bondDeck, letter: letterDeck, letterDiscard: [] },
    ultimatumAsideUid: ultimatumUid,
    equipmentDisplay,
    flags: {
      queenRescued: false,
      petFound: false,
      sacrifice: {},
      xiaoyuLiyaLetters: 0,
      berserkCountdown: null,
      lifeGemUsed: 0,
      oneShotUsed: {},
      avatarCleared: false,
    },
    boss: null,
    bonds,
    bondLeads: [],
    buffs: [],
    orderCounter: 0,
    roundUsage: {},
    crisisDamageLog: {},
    sceneWards: {},
    pendingDecision: null,
    resumeStack: [],
    log: [{ kind: 'game_created', config }],
    result: null,
  };
  return state;
}

function validateConfig(config: GameConfig): void {
  const seats = Object.values(config.seatAssignments);
  const assigned = seats.flat();
  const active = activeCharactersFor(config.playerCount, config.benchCharacter);
  if (seats.length !== config.playerCount) {
    throw new Error(`座位数(${seats.length})与人数(${config.playerCount})不符`);
  }
  for (const cid of active) {
    if (!assigned.includes(cid)) throw new Error(`出场角色 ${cid} 未分配给任何座位`);
  }
  for (const cid of assigned) {
    if (!active.includes(cid)) throw new Error(`角色 ${cid} 在 ${config.playerCount} 人局不出场`);
  }
}

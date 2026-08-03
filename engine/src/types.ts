/**
 * 《精灵王座：破晓之契》规则引擎 — 核心 schema v2（对照 rules-spec v1.0 冻结版）
 *
 * 本文件只定义数据结构，不含行为逻辑。
 * GameState 必须是可 JSON.stringify 的 plain data（control-manifest §3）。
 * 命名与 design/spec/rules-spec.md 共享词汇表；注释引用规格章节（§x.y）与裁定（裁A-xx）。
 */

// ── 基础标识 ────────────────────────────────────────────────────────────────

export type PlayerCount = 1 | 2 | 3 | 4;
export type CharacterId = 'xiaoyu' | 'liya' | 'kaier' | 'baye';
export type SceneId = 'human_city' | 'elf_kingdom' | 'ancient_battlefield' | 'dark_valley';
export type DaySegment = 'dawn' | 'dusk' | 'night';
export type GamePhaseKind =
  | 'crisis'      // P1 危机蔓延
  | 'action'      // P2 破晓行动
  | 'prejudice'   // P3 偏见与羁绊
  | 'recovery'    // P4 休整与倒数
  | 'final_battle'// 决战（P2' → P4' 循环【裁A-10】）
  | 'game_over';
export type Race = 'human' | 'elf';

// ── 卡牌定义 ────────────────────────────────────────────────────────────────

export type ActionCardTag = 'attack' | 'move' | 'defense' | 'resource' | 'support' | 'heal' | 'special';

export interface ActionCardDef {
  id: string;
  code: string;
  name: string;
  character: CharacterId;
  tags: ActionCardTag[];
  material: boolean;
  costAP: number;
  /** 远程标签（§9.8 危-07 迷雾校验用【裁A-20】）；'conditional' = 指定相邻/非当前场景时算远程 */
  remote: boolean | 'conditional';
  text: string;
}

export interface CrisisCardDef {
  id: string;
  code: string;
  name: string;
  copies: number;
  scene: SceneId | 'any';
  crisisValue: number;
  dark: boolean;
  text: string;
}

export interface BondCardDef {
  id: string;
  code: string;
  name: string;
  pair: 'any' | [CharacterId, CharacterId];
  requiresMixedRace: boolean;
  text: string;
}

export interface LetterCardDef {
  id: string;
  code: string;
  name: string;
  copies: number;
  text: string;
}

export interface EquipmentCardDef {
  id: string;
  code: string;
  name: string;
  copies: number;
  text: string;
}

export interface CardInstance {
  uid: string;
  defId: string;
  kind: 'action' | 'crisis' | 'bond' | 'letter' | 'equipment';
}

// ── 对局配置 ────────────────────────────────────────────────────────────────

export interface GameConfig {
  playerCount: PlayerCount;
  seed: number;
  benchCharacter?: 'kaier' | 'baye';
  seatAssignments: Record<number, CharacterId[]>;
}

export interface ModeRules {
  apPerTurn: number;
  maxHp: number;
  prejudice: boolean;
  collapseThreshold: number;
  bossHp: number;
  shieldLayers: number;
  shieldHpPerLayer: number;
  crisisFlips: Record<1 | 2 | 3, [number, number, number]>;
  finalSupply: number;
}

// ── Buff / 修饰（效果链节点来源，§11【裁A-08】）────────────────────────────────

/**
 * 持续效果统一模型。createdOrder 为全局单调序号：
 * 伤害链中静态修饰的排序 = 各效果实际打出/声明顺序（§11 裁定 A-08 的数字化映射）。
 */
export interface Buff {
  id: string;
  source: string;              // 来源卡/规则 id
  kind:
    | 'attack_add'             // 攻击伤害 +n（场景/自身）
    | 'next_attack_add'        // 下一次攻击 +n（雅-07，消耗）
    | 'damage_reduce'          // 受到伤害 -n（守护之姿/巴-03/装-01主动，每节点钳 0）
    | 'guard'                  // 下一次伤害由声明者代受（援护/凯-07/羁-09主动）
    | 'share'                  // 与伙伴分摊（羁-01被动外；巴-09/羁-10主动，本轮）
    | 'first_damage_reduce'    // 每轮第一次受伤 -n（羁-04/传-03，传-03为一次性）
    | 'attack_mult'            // 攻击伤害 ×n（预留）
    | 'no_prejudice';          // 羁-05 被动：同场景不触发偏见
  value: number;
  /** 作用对象（不设 = 视 kind 而定） */
  target?: CharacterId;
  /** 场景作用域（守护之姿/精灵荣光/巴-04） */
  scene?: SceneId;
  /** 代受声明者（guard）/ 分摊伙伴（share） */
  partner?: CharacterId;
  /** 'round' 本轮 P4 清除；'rounds:N' 剩余 N 轮（凯-09）；'consumed' 用后即焚 */
  scope: 'round' | 'rounds' | 'consumed' | 'permanent';
  roundsLeft?: number;
  createdOrder: number;
}

// ── 对局状态 ────────────────────────────────────────────────────────────────

export interface CharacterState {
  id: CharacterId;
  scene: SceneId;
  hp: number;
  maxHp: number;
  erosion: number;             // §6.4 E ∈ 0..4（小鱼）
  hand: string[];
  deck: string[];
  discard: string[];
  equipment: string[];         // ≤2
  materialTokens: number;      // ≤4【裁A-28】
  purifyTokens: number;        // ≤3
  bondTokens: number;
  /** 信物标记（传-02，可叠加不过期【裁A-38】） */
  charms: number;
  /** 小剑与小盾（§5.2 黑暗山谷） */
  hasPet: boolean;
  pendingLetter: { cardUid: string; from: CharacterId } | null;
  /** 传-04 反向传递：下一次自己回合开始时收卡【裁A-22】 */
  pendingReverseLetter: { cardUid: string; from: CharacterId } | null;
  lettersSentThisRound: number;
  lettersReceivedThisRound: number;
  /** 下一回合增益（凯-01/雅-08【裁A-38 不可累积】） */
  nextTurnApBonus: number;
  nextTurnDraw: number;
  /** 本回合已用装-05 小鱼免费首移 */
  freeMoveUsedThisTurn: boolean;
  /** 本轮是否已受过伤害（鱼-10 窗口【裁A-41】） */
  damagedThisRound: boolean;
  airship?: { cooldownRounds: number };  // 【裁A-13】位置恒随巴爷
  ap: number;
  alive: boolean;              // 【裁A-06】出局为终态
}

export interface SceneState {
  id: SceneId;
  crisisCards: string[];
  crisisDamage: Record<string, number>;   // uid → 已扣除危机度（§6.1 黑色指示物标记）
}

/** 羁绊对状态（§6.3） */
export interface PairBond {
  pair: [CharacterId, CharacterId];       // 按回合顺序排序
  status: 'inactive' | 'active';
  cardUid: string | null;                 // inactive 时为 null
  /** 羁-02 失控替换终态【裁A-04】 */
  replacedByBerserk: boolean;
  /** 主动效果最近使用轮次（每轮限 1） */
  activeUsedRound: number | null;
}

/** 偏见关联（§6.3 bondLead【裁A-16】，跨轮有效） */
export interface BondLead {
  pair: [CharacterId, CharacterId];
  crisisUid: string;
}

export interface BossState {
  hp: number;
  maxHp: number;
  shield: number;
  shieldMax: number;
  stage: 1 | 2 | 3;
  round: number;                          // 决战轮计数 1..9
  /** 宝玉共鸣净化指示物 0..3（§7.4） */
  gemPurify: number;
  /** 本轮各角色对玫拉造成的伤害（P2 宝玉之力统计窗口【裁A-35】） */
  damageThisRound: Record<string, number>;
}

export interface PhaseState {
  kind: GamePhaseKind;
  day: 1 | 2 | 3;
  segment: DaySegment;
  round: number;                          // 常规 1..9
}

export interface GameFlags {
  queenRescued: boolean;
  petFound: boolean;
  /** 危-09 每张独立献祭进度【裁A-15】：uid → 0..3 */
  sacrifice: Record<string, number>;
  xiaoyuLiyaLetters: number;
  /** 失控倒计时：进入失控=0，小鱼 TURN_START +1，达 3 判负（F4【裁A-07】） */
  berserkCountdown: number | null;
  lifeGemUsed: number;                    // ≤2
  oneShotUsed: Record<string, boolean>;   // 巴-10/营救女王/寻找宠物/羁-10免费锻造
  /** 危-10 是否已被清除（决战 +2 判定） */
  avatarCleared: boolean;
}

// ── 中断式决策 ──────────────────────────────────────────────────────────────

export type DecisionKind =
  | 'place_crisis'          // 通用危机卡落点（§5.1-c）
  | 'choose_character'      // “一名角色”选择【L298】
  | 'choose_crisis'         // 选择一张危机卡
  | 'choose_cards'          // 从一组牌中选（弃牌/巴-02/凯-06/传-04）
  | 'choose_bond_card'      // 结成羁绊选卡（§5.3）
  | 'choose_option'         // 二选一（小鱼收信/羁-02代受等）
  | 'order_effects'         // 危机卡轮末效果定序【裁A-14】
  | 'reorder_cards'         // 雅-03/侦查敌情 牌库顶重排
  | 'choose_share_high'     // 分摊高份归属【裁A-30】
  | 'choose_redirect'       // 多代受承受者【裁A-29】
  | 'choose_equipment';     // 危-06 装备归属【裁A-40】/满 2 弃装备

/** 续算描述（state 仅存数据；函数在 decisions.ts 注册表） */
export interface ResumeRef {
  sys: 'crisis' | 'letter' | 'bond' | 'combat' | 'boss' | 'phase' | 'card' | 'damage';
  op: string;
  data: unknown;
}

export interface PendingDecision {
  id: string;
  kind: DecisionKind;
  /** 决策人：具体角色（其控制座位作答）；'all' = 任意座位可答（桌面协商映射） */
  decider: CharacterId | 'all';
  options: unknown;
  resume: ResumeRef;
}

// ── 事件 ────────────────────────────────────────────────────────────────────

export type GameEvent =
  | { kind: 'game_created'; config: GameConfig }
  | { kind: 'phase_entered'; phase: GamePhaseKind; day: number; segment: DaySegment; round: number }
  | { kind: 'turn_started'; character: CharacterId; ap: number }
  | { kind: 'turn_ended'; character: CharacterId }
  | { kind: 'card_drawn'; character: CharacterId; cardUid: string; cardDefId: string }
  | { kind: 'deck_reshuffled'; character: CharacterId }
  | { kind: 'crisis_deck_reshuffled' }
  | { kind: 'moved'; character: CharacterId; from: SceneId; to: SceneId; via: string }
  | { kind: 'card_played'; character: CharacterId; cardUid: string; cardDefId: string }
  | { kind: 'crisis_flipped'; cardUid: string; cardDefId: string; scene: SceneId }
  | { kind: 'crisis_damaged'; cardUid: string; amount: number; remaining: number; by: CharacterId }
  | { kind: 'crisis_cleared'; cardUid: string; cardDefId: string; scene: SceneId; participants: CharacterId[] }
  | { kind: 'character_damaged'; character: CharacterId; amount: number; source: string; dark: boolean }
  | { kind: 'character_healed'; character: CharacterId; amount: number }
  | { kind: 'character_eliminated'; character: CharacterId }
  | { kind: 'redirected'; from: CharacterId; to: CharacterId }
  | { kind: 'shared'; a: CharacterId; b: CharacterId; amountA: number; amountB: number }
  | { kind: 'erosion_changed'; amount: number }
  | { kind: 'berserk_started' }
  | { kind: 'berserk_ended' }
  | { kind: 'material_gained'; character: CharacterId; count: number }
  | { kind: 'purify_gained'; character: CharacterId; count: number }
  | { kind: 'bond_formed'; pair: [CharacterId, CharacterId]; cardUid: string; cardDefId: string }
  | { kind: 'bond_replaced'; cardUid: string; cardDefId: string }
  | { kind: 'prejudice_flipped'; scene: SceneId; cardUid: string; pair: [CharacterId, CharacterId] | null }
  | { kind: 'letter_sent'; from: CharacterId; to: CharacterId }
  | { kind: 'letter_received'; character: CharacterId; cardUid: string }
  | { kind: 'letter_card_drawn'; character: CharacterId; cardUid: string; cardDefId: string }
  | { kind: 'forged'; character: CharacterId; equipmentUid: string }
  | { kind: 'equipment_dropped'; character: CharacterId; equipmentUid: string }
  | { kind: 'flag_set'; flag: string; value: unknown }
  | { kind: 'boss_stage_changed'; stage: number }
  | { kind: 'boss_damaged'; amount: number; shielded: boolean; by: CharacterId }
  | { kind: 'boss_action'; action: string; detail: string }
  | { kind: 'counter_attack'; target: CharacterId; race: Race }
  | { kind: 'final_battle_started'; bossHp: number; shield: number; stage: number }
  | { kind: 'decision_required'; decision: PendingDecision }
  | { kind: 'game_over'; result: 'victory' | 'defeat'; reason: string };

// ── 根状态 ──────────────────────────────────────────────────────────────────

export interface GameState {
  schemaVersion: 1;
  config: GameConfig;
  rng: { seed: number; cursor: number };
  phase: PhaseState;
  turnOrder: CharacterId[];
  characters: Record<string, CharacterState>;
  scenes: Record<SceneId, SceneState>;
  currentTurn: { character: CharacterId } | null;
  /** 当前回合在 turnOrder 中的下标（当前回合角色出局后依此自动顺延） */
  turnPointer: number;
  cards: Record<string, CardInstance>;
  decks: {
    crisis: string[];
    crisisDiscard: string[];
    bond: string[];
    letter: string[];
    letterDiscard: string[];
  };
  ultimatumAsideUid: string | null;
  equipmentDisplay: string[];
  flags: GameFlags;
  boss: BossState | null;
  /** 羁绊对状态（§6.3） */
  bonds: PairBond[];
  /** 偏见关联（§6.3 bondLead） */
  bondLeads: BondLead[];
  /** 持续效果（§11 效果链节点池） */
  buffs: Buff[];
  /** 全局效果声明序号（裁A-08 链序） */
  orderCounter: number;
  /** 本轮使用计数（命名空间键：'prejudice:human_city' / 'treeHeal:liya' / 'kai05' / 'petAtk:xiaoyu' ...） */
  roundUsage: Record<string, true>;
  /** 危机卡伤害轨迹（参与清除判定【裁A-09】）：uid → 造成过伤害的角色 */
  crisisDamageLog: Record<string, CharacterId[]>;
  /** 羁-05 主动：场景净化守护（该场景下次放危机改为弃置） */
  sceneWards: Record<string, number>;
  pendingDecision: PendingDecision | null;
  /**
   * 续算栈（LIFO）：外层流程被内层决策打断时的Continuation。
   * 决策解决后若 pendingDecision 为空，引擎逐个弹出执行直至再次挂起。
   * 仅含数据（ResumeRef），不含函数（纯 JSON 约束）。
   */
  resumeStack: ResumeRef[];
  log: GameEvent[];
  result: { outcome: 'victory' | 'defeat'; reason: string } | null;
}

// ── 指令 ────────────────────────────────────────────────────────────────────

/** play_card 的目标载荷（按卡面需要取用） */
export interface PlayCardTargets {
  crisisUids?: string[];
  characters?: CharacterId[];
  scene?: SceneId;
  choice?: string;
}

export type Command =
  | { type: 'move'; character: CharacterId; to: SceneId; via?: 'walk' | 'airship' | 'skate'; carry?: CharacterId }
  | { type: 'search'; character: CharacterId }
  | {
      type: 'play_card';
      character: CharacterId;
      cardUid: string;
      targets?: PlayCardTargets;
      /** 声明消耗品（效果链末段，顺序固定：净化→信物→小剑【§11】） */
      usePurify?: number;
      useCharm?: boolean;
      usePetAttack?: boolean;
      usePetDefend?: boolean;
    }
  | { type: 'forge'; character: CharacterId; equipmentUid: string; materialCardUids: string[]; useTokens: number }
  | { type: 'send_letter'; character: CharacterId; cardUid: string }
  | { type: 'scene_action'; character: CharacterId; action: 'tree_heal' | 'scout' | 'rescue_queen' | 'find_pet'; params?: { target?: CharacterId } }
  | { type: 'bond_active'; character: CharacterId; bondUid: string; params?: PlayCardTargets }
  | { type: 'equipment_active'; character: CharacterId; equipmentUid: string; params?: PlayCardTargets }
  | { type: 'transfer_material'; character: CharacterId; to: CharacterId; count: number }
  | { type: 'heal'; character: CharacterId; discardUid: string; target: CharacterId }
  | { type: 'guard'; character: CharacterId; target: CharacterId }
  | { type: 'purify_charge'; character: CharacterId }
  | { type: 'gem_attune'; character: CharacterId }
  | { type: 'end_turn'; character: CharacterId }
  | { type: 'resolve_decision'; decisionId: string; choice: unknown };

export interface ApplyResult {
  state: GameState;
  events: GameEvent[];
}

// ── 引擎错误 ────────────────────────────────────────────────────────────────

export type EngineErrorCode =
  | 'not_your_turn'
  | 'wrong_phase'
  | 'insufficient_ap'
  | 'insufficient_cost'
  | 'invalid_target'
  | 'not_adjacent'
  | 'card_not_in_hand'
  | 'condition_not_met'
  | 'usage_limit'
  | 'decision_pending'
  | 'no_such_decision'
  | 'invalid_choice'
  | 'game_over'
  | 'not_implemented'
  | 'invalid_command';

export class EngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

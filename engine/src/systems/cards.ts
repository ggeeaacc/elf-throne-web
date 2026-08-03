/**
 * 40 张专属行动卡结算器（§9.1–9.4，冻结）。
 *
 * 设计：每卡一个 handler（纯函数操作 draft）；数值统一经 ctx.N()（羁-07 复制减半挂钩点）；
 * 攻击统一经 attackOnCrisis/attackOnBoss（§11 效果链）；移动效果决战一律不触发【L200】。
 */
import { ACTION_CARD_BY_ID } from '../content/action-cards.js';
import { isAdjacent } from '../content/scenes.js';
import type {
  CharacterId,
  GameEvent,
  GameState,
  PlayCardTargets,
  SceneId,
} from '../types.js';
import { EngineError } from '../types.js';
import { drawCards, drawToTemp, emitEv, suspendDecision } from './common.js';
import {
  addBuff,
  changeErosion,
  dealDamageToCharacter,
  gainMaterial,
  gainPurify,
  healCharacter,
  hasActiveBond,
} from './damage.js';
import type { ChainNode } from './damage.js';
import {
  assertRemoteLegal,
  buildAttackChain,
  crisisSceneOf,
  damageValue,
  dealDamageToBoss,
  dealDamageToCrisis,
} from './combat.js';
import { flipPrejudiceCard } from './crisis.js';
import { pairKey } from './bonds.js';

// ── 结算上下文 ────────────────────────────────────────────────────────────────

export interface CardContext {
  state: GameState;
  events: GameEvent[];
  character: CharacterId;
  cardUid: string;
  targets: PlayCardTargets;
  usePurify?: number;
  useCharm?: boolean;
  usePetAttack?: boolean;
  usePetDefend?: boolean;
  /** 羁-07 复制：数值减半（向下取整【裁A-32】） */
  half: boolean;
  /** 决战模式：一切移动效果不触发【L200】 */
  inBattle: boolean;
  /** 数值缩放（羁-07 复制） */
  N(n: number): number;
}

type Handler = (ctx: CardContext) => void;

function ch(ctx: CardContext) {
  return ctx.state.characters[ctx.character]!;
}

/** 装-02 主动：本次攻击视为远程（消耗标记并允许选择非当前场景目标） */
function takeRangedBuff(ctx: CardContext): boolean {
  const b = ctx.state.buffs.find((x) => x.kind === 'next_attack_add' && x.source === 'equip-02-active' && x.target === ctx.character);
  if (!b) return false;
  ctx.state.buffs = ctx.state.buffs.filter((x) => x.id !== b.id);
  return true;
}

/** 当前场景；若持装-02 远程标记则放开到全部场景 */
function curOrRanged(ctx: CardContext): SceneId[] {
  if (ctx.state.buffs.some((x) => x.kind === 'next_attack_add' && x.source === 'equip-02-active' && x.target === ctx.character)) {
    return ['human_city', 'elf_kingdom', 'ancient_battlefield', 'dark_valley'];
  }
  return [ch(ctx).scene];
}

/** 攻击目标校验 + 效果链结算（对危机卡） */
function attackOnCrisis(ctx: CardContext, opts: { base: number; crisisUid: string; remote: boolean; cardMods?: ChainNode[] }): void {
  const st = ctx.state;
  const attacker = ch(ctx);
  const scene = crisisSceneOf(st, opts.crisisUid);
  if (!scene) throw new EngineError('invalid_target', '目标危机卡不在场上');
  let remote = opts.remote;
  if (!remote) remote = takeRangedBuff(ctx);
  assertRemoteLegal(st, attacker.scene, scene, remote);
  const inst = buildAttackChain(st, {
    attacker: ctx.character,
    base: ctx.N(opts.base),
    cardDefId: st.cards[ctx.cardUid]?.defId ?? null,
    ...(opts.cardMods ? { cardMods: opts.cardMods } : {}),
    remote,
    ...(ctx.usePurify ? { usePurify: ctx.usePurify } : {}),
    ...(ctx.useCharm ? { useCharm: ctx.useCharm } : {}),
    ...(ctx.usePetAttack ? { usePetAttack: ctx.usePetAttack } : {}),
  }, scene);
  ctx.usePurify = 0;
  ctx.useCharm = false;
  ctx.usePetAttack = false;
  dealDamageToCrisis(st, ctx.events, opts.crisisUid, damageValue(inst), ctx.character);
}

/** 多目标攻击：效果链（含净化/信物等消耗）构建一次、逐目标应用【裁A-39 每个目标各+1】 */
function attackMulti(ctx: CardContext, opts: { base: number; uids: string[]; cardMods?: ChainNode[] }): void {
  const st = ctx.state;
  const attacker = ch(ctx);
  let remoteAny = false;
  for (const uid of opts.uids) {
    const scene = crisisSceneOf(st, uid);
    if (!scene) throw new EngineError('invalid_target', '目标危机卡不在场上');
    if (scene !== attacker.scene) remoteAny = true;
  }
  const inst = buildAttackChain(st, {
    attacker: ctx.character,
    base: ctx.N(opts.base),
    cardDefId: st.cards[ctx.cardUid]?.defId ?? null,
    ...(opts.cardMods ? { cardMods: opts.cardMods } : {}),
    remote: remoteAny,
    ...(ctx.usePurify ? { usePurify: ctx.usePurify } : {}),
    ...(ctx.useCharm ? { useCharm: ctx.useCharm } : {}),
    ...(ctx.usePetAttack ? { usePetAttack: ctx.usePetAttack } : {}),
  }, attacker.scene);
  ctx.usePurify = 0;
  ctx.useCharm = false;
  ctx.usePetAttack = false;
  const v = damageValue(inst);
  for (const uid of opts.uids) {
    const scene = crisisSceneOf(st, uid)!;
    assertRemoteLegal(st, attacker.scene, scene, scene !== attacker.scene);
    dealDamageToCrisis(st, ctx.events, uid, v, ctx.character);
  }
}

/** 决战攻击（对玫拉） */
function attackOnBoss(ctx: CardContext, opts: { base: number; cardMods?: ChainNode[] }): void {
  const st = ctx.state;
  const inst = buildAttackChain(st, {
    attacker: ctx.character,
    base: ctx.N(opts.base),
    cardDefId: st.cards[ctx.cardUid]?.defId ?? null,
    ...(opts.cardMods ? { cardMods: opts.cardMods } : {}),
    remote: false,
    ...(ctx.usePurify ? { usePurify: ctx.usePurify } : {}),
    ...(ctx.useCharm ? { useCharm: ctx.useCharm } : {}),
    ...(ctx.usePetAttack ? { usePetAttack: ctx.usePetAttack } : {}),
    vsBoss: true,
  }, 'dark_valley');
  ctx.usePurify = 0;
  ctx.useCharm = false;
  ctx.usePetAttack = false;
  dealDamageToBoss(st, ctx.events, damageValue(inst), ctx.character, true);
}

/** 移动效果（决战静默忽略【L200】） */
function moveEffect(ctx: CardContext, who: CharacterId, to: SceneId, via: string): void {
  if (ctx.inBattle) return;
  const c = ctx.state.characters[who];
  if (!c?.alive) return;
  const from = c.scene;
  if (from === to) return;
  c.scene = to;
  emitEv(ctx.events, { kind: 'moved', character: who, from, to, via });
}

function targetCrisisIn(ctx: CardContext, scenes: SceneId[], what: string): string {
  const uid = ctx.targets.crisisUids?.[0];
  if (!uid) throw new EngineError('invalid_target', `须选择${what}`);
  const scene = crisisSceneOf(ctx.state, uid);
  if (!scene || !scenes.includes(scene)) {
    throw new EngineError('invalid_target', `${what}须位于合法场景`);
  }
  return uid;
}

function sameScene(scene: SceneId, ctx: CardContext): boolean {
  return ch(ctx).scene === scene;
}

function otherChar(ctx: CardContext, what: string, pred?: (c: CharacterId) => boolean): CharacterId {
  const t = ctx.targets.characters?.[0];
  if (!t || !ctx.state.characters[t]?.alive || (pred && !pred(t))) {
    throw new EngineError('invalid_target', `须选择${what}`);
  }
  return t;
}

// ── 小鱼（§9.1）───────────────────────────────────────────────────────────────

const yu: Record<string, Handler> = {
  'yu-01': (ctx) => {
    // 横斩：当前场景 1 危机卡 3 伤
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 3 });
    attackOnCrisis(ctx, { base: 3, crisisUid: targetCrisisIn(ctx, curOrRanged(ctx), '当前场景危机卡'), remote: false });
  },
  'yu-02': (ctx) => gainMaterial(ctx.state, ctx.events, ctx.character, ctx.N(2)),
  'yu-03': (ctx) => {
    // 纵斩突进：移至相邻场景并对该场景 1 危机卡 2 伤（巴爷在场 +1）
    const to = ctx.targets.scene;
    if (!ctx.inBattle) {
      if (!to || !isAdjacent(ch(ctx).scene, to)) throw new EngineError('not_adjacent', '须移至相邻场景');
      moveEffect(ctx, ctx.character, to, 'yu-03');
    }
    const dest = to ?? ch(ctx).scene;
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 2 });
    const bayeThere = ctx.state.characters['baye']?.alive && ctx.state.characters['baye']?.scene === dest;
    attackOnCrisis(ctx, {
      base: 2,
      crisisUid: targetCrisisIn(ctx, [dest], '目标场景危机卡'),
      remote: false,
      ...(bayeThere ? { cardMods: [{ op: 'ADD', value: ctx.N(1), source: 'yu-03-baye' } as ChainNode] } : {}),
    });
  },
  'yu-04': (ctx) => {
    addBuff(ctx.state, { source: 'yu-04', kind: 'damage_reduce', value: ctx.N(2), scene: ch(ctx).scene, scope: 'round' });
  },
  'yu-05': (ctx) => {
    // 十字剑气：4 伤（默认当前场景；卡面无场景限制——按基础规则攻击卡默认当前场景【L106】）
    if (ctx.inBattle) attackOnBoss(ctx, { base: 4 });
    else attackOnCrisis(ctx, { base: 4, crisisUid: targetCrisisIn(ctx, curOrRanged(ctx), '当前场景危机卡'), remote: false });
    changeErosion(ctx.state, ctx.events, ctx.N(1), 'T3');
  },
  'yu-06': (ctx) => {
    const x = ch(ctx);
    if (x.erosion > 0) changeErosion(ctx.state, ctx.events, -Math.min(ctx.N(2), x.erosion), 'R1');
    else healCharacter(ctx.state, ctx.events, ctx.character, ctx.N(2));
  },
  'yu-07': (ctx) => {
    // 像鸟一样飞：移至莉雅场景；同处一地 → 双方各抽 1
    const liya = ctx.state.characters['liya'];
    if (!liya?.alive) throw new EngineError('invalid_target', '莉雅不在场');
    if (!ctx.inBattle) moveEffect(ctx, ctx.character, liya.scene, 'yu-07');
    if (ch(ctx).scene === liya.scene) {
      drawCards(ctx.state, ctx.events, ctx.character, 1);
      drawCards(ctx.state, ctx.events, 'liya', 1);
    }
  },
  'yu-08': (ctx) => {
    // 多节变形弓：当前或 1 个相邻场景至多 2 张各 1 伤
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 1 });
    const uids = (ctx.targets.crisisUids ?? []).slice(0, 2);
    if (uids.length === 0) throw new EngineError('invalid_target', '至多选择 2 张危机卡');
    for (const uid of uids) {
      const scene = crisisSceneOf(ctx.state, uid)!;
      if (scene !== ch(ctx).scene && !isAdjacent(ch(ctx).scene, scene)) {
        throw new EngineError('invalid_target', '目标须在当前或相邻场景');
      }
    }
    attackMulti(ctx, { base: 1, uids });
  },
  'yu-09': (ctx) => {
    // 并肩而立：与莉雅同场景；双方各回 2，小鱼 -1 侵蚀
    const liya = ctx.state.characters['liya'];
    if (!liya?.alive || liya.scene !== ch(ctx).scene) throw new EngineError('condition_not_met', '须与莉雅同场景');
    healCharacter(ctx.state, ctx.events, ctx.character, ctx.N(2));
    healCharacter(ctx.state, ctx.events, 'liya', ctx.N(2));
    changeErosion(ctx.state, ctx.events, -ctx.N(1), 'R2');
  },
  'yu-10': (ctx) => {
    // 为爱而战：X = 侵蚀数+1（莉雅本轮已受伤 +2【裁A-41】）
    const x = ch(ctx).erosion + 1 + (ctx.state.characters['liya']?.damagedThisRound ? 2 : 0);
    if (ctx.inBattle) return attackOnBoss(ctx, { base: x });
    attackOnCrisis(ctx, { base: x, crisisUid: targetCrisisIn(ctx, curOrRanged(ctx), '当前场景危机卡'), remote: false });
  },
};

// ── 莉雅（§9.2）───────────────────────────────────────────────────────────────

const ya: Record<string, Handler> = {
  'ya-01': (ctx) => {
    // 精灵箭：当前或相邻 1 危机卡 3 伤；若清除 → 收回手牌
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 3 });
    const uid = targetCrisisIn(ctx, [ch(ctx).scene, ...adj(ctx)], '当前或相邻场景危机卡');
    const remote = crisisSceneOf(ctx.state, uid)! !== ch(ctx).scene;
    const before = ctx.state.scenes[crisisSceneOf(ctx.state, uid)!].crisisDamage[uid] ?? 0;
    void before;
    attackOnCrisis(ctx, { base: 3, crisisUid: uid, remote });
    // 清除则收回（hooks 在 playCard 尾部统一判断 returnedToHand）
  },
  'ya-02': (ctx) => {
    const to = ctx.targets.scene;
    if (!to || !(to in ctx.state.scenes)) throw new EngineError('invalid_target', '须选择目标场景');
    moveEffect(ctx, ctx.character, to, 'ya-02');
  },
  'ya-03': (ctx) => {
    // 精灵地图：看危机牌库顶 3 张重排；【暗】置底【裁A-38】
    const top3 = ctx.state.decks.crisis.slice(0, 3);
    if (top3.length === 0) return;
    suspendDecision(ctx.state, ctx.events, {
      kind: 'reorder_cards',
      decider: ctx.character,
      options: { prompt: '精灵地图：重排牌库顶（【暗】卡将置底）', cardUids: top3 },
      resume: { sys: 'card', op: 'ya03_reorder', data: { top3 } },
    });
  },
  'ya-04': (ctx) => {
    const t = otherChar(ctx, '任意一名角色');
    healCharacter(ctx.state, ctx.events, t, ctx.N(2));
    const tc = ctx.state.characters[t]!;
    if (t === 'xiaoyu' && tc.erosion >= 4) changeErosion(ctx.state, ctx.events, -ctx.N(1), 'R3');
  },
  'ya-05': (ctx) => {
    // 生命宝玉：与小鱼同场景且其侵蚀 ≥1；清空侵蚀+满血；一局 ≤2 次
    const x = ctx.state.characters['xiaoyu'];
    if (ctx.state.flags.lifeGemUsed >= 2) throw new EngineError('usage_limit', '生命宝玉一局最多使用两次');
    if (!x?.alive || x.scene !== ch(ctx).scene) throw new EngineError('condition_not_met', '须与小鱼同场景');
    if (x.erosion < 1) throw new EngineError('condition_not_met', '小鱼无侵蚀指示物');
    x.erosion = 0;
    emitEv(ctx.events, { kind: 'erosion_changed', amount: 0 });
    emitEv(ctx.events, { kind: 'berserk_ended' });
    ctx.state.flags.berserkCountdown = null;
    healCharacter(ctx.state, ctx.events, 'xiaoyu', 99);
    ctx.state.flags.lifeGemUsed += 1;
    if (!ctx.inBattle) {
      // 自身永久 -1 生命上限【L176】（决战中不扣【L223】）
      const me = ch(ctx);
      me.maxHp = Math.max(1, me.maxHp - ctx.N(1));
      me.hp = Math.min(me.hp, me.maxHp);
    }
  },
  'ya-06': (ctx) => {
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 2 });
    const uids = (ctx.targets.crisisUids ?? []).slice(0, 2);
    if (uids.length === 0) throw new EngineError('invalid_target', '至多选择 2 张危机卡');
    // 精灵神射被动：莉雅的攻击卡可指定相邻场景的危机卡
    const validScenes = new Set([ch(ctx).scene, ...adj(ctx)]);
    for (const uid of uids) {
      const sc = crisisSceneOf(ctx.state, uid);
      if (!sc || !validScenes.has(sc)) throw new EngineError('invalid_target', '危机卡须在当前或相邻场景');
    }
    attackMulti(ctx, { base: 2, uids });
  },
  'ya-07': (ctx) => {
    const t = otherChar(ctx, '同场景友方角色', (c) => ctx.state.characters[c]?.scene === ch(ctx).scene);
    addBuff(ctx.state, { source: 'ya-07', kind: 'next_attack_add', value: ctx.N(2), target: t, scope: 'consumed' });
  },
  'ya-08': (ctx) => {
    const x = ctx.state.characters['xiaoyu'];
    if (!x?.alive || x.scene !== ch(ctx).scene) throw new EngineError('condition_not_met', '须与小鱼同处一地');
    drawCards(ctx.state, ctx.events, ctx.character, 1);
    drawCards(ctx.state, ctx.events, 'xiaoyu', 1);
    x.nextTurnApBonus = Math.max(x.nextTurnApBonus, ctx.N(1)); // 不可累积【L332】
  },
  'ya-09': (ctx) => {
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 3 });
    const uid = ctx.targets.crisisUids?.[0];
    if (!uid || !crisisSceneOf(ctx.state, uid)) throw new EngineError('invalid_target', '须选择任意场景 1 张危机卡');
    attackOnCrisis(ctx, { base: 3, crisisUid: uid, remote: crisisSceneOf(ctx.state, uid) !== ch(ctx).scene });
  },
  'ya-10': (ctx) => {
    // 为你而来：移至小鱼场景；途中经过场景的 1 张未解决危机可受 1 伤（路径玩家自选合法相邻路径）
    const x = ctx.state.characters['xiaoyu'];
    if (!x?.alive) throw new EngineError('invalid_target', '小鱼不在场');
    const via = ctx.targets.scene;
    if (!ctx.inBattle) {
      if (via && via !== ch(ctx).scene && via !== x.scene) {
        if (!isAdjacent(ch(ctx).scene, via) || !isAdjacent(via, x.scene)) {
          throw new EngineError('invalid_target', '经过场景须构成合法相邻路径');
        }
      }
      moveEffect(ctx, ctx.character, x.scene, 'ya-10');
      const hitUid = ctx.targets.crisisUids?.[0];
      if (hitUid && via && crisisSceneOf(ctx.state, hitUid) === via) {
        dealDamageToCrisis(ctx.state, ctx.events, hitUid, ctx.N(1), ctx.character);
      }
    }
  },
};

function adj(ctx: CardContext): SceneId[] {
  const m: Record<SceneId, SceneId[]> = {
    human_city: ['dark_valley', 'ancient_battlefield'],
    elf_kingdom: ['ancient_battlefield', 'dark_valley'],
    ancient_battlefield: ['human_city', 'elf_kingdom'],
    dark_valley: ['human_city', 'elf_kingdom'],
  };
  return m[ch(ctx).scene];
}

// ── 凯尔（§9.3）───────────────────────────────────────────────────────────────

const kai: Record<string, Handler> = {
  'kai-01': (ctx) => {
    const t = otherChar(ctx, '一名友方角色');
    const tc = ctx.state.characters[t]!;
    tc.nextTurnApBonus += ctx.N(1);
    tc.nextTurnDraw += 1;
  },
  'kai-02': (ctx) => {
    const used = !!ctx.state.roundUsage['kai05'];
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 4, ...(used ? { cardMods: [{ op: 'ADD', value: ctx.N(1), source: 'kai-02' } as ChainNode] } : {}) });
    attackOnCrisis(ctx, {
      base: 4,
      crisisUid: targetCrisisIn(ctx, curOrRanged(ctx), '当前场景危机卡'),
      remote: false,
      ...(used ? { cardMods: [{ op: 'ADD', value: ctx.N(1), source: 'kai-02' } as ChainNode] } : {}),
    });
  },
  'kai-03': (ctx) => {
    // 战术转移：自身与同场景 1 友方同移至相邻场景（可移失控小鱼【裁A-24】）
    const t = otherChar(ctx, '同场景一名友方角色', (c) => c !== ctx.character && ctx.state.characters[c]?.scene === ch(ctx).scene);
    const to = ctx.targets.scene;
    if (!to || !isAdjacent(ch(ctx).scene, to)) throw new EngineError('not_adjacent', '须移至相邻场景');
    moveEffect(ctx, ctx.character, to, 'kai-03');
    moveEffect(ctx, t, to, 'kai-03');
  },
  'kai-04': (ctx) => {
    const n = ctx.state.scenes['ancient_battlefield'].crisisCards.length + 2;
    if (ctx.inBattle) return attackOnBoss(ctx, { base: n });
    attackOnCrisis(ctx, { base: n, crisisUid: targetCrisisIn(ctx, curOrRanged(ctx), '当前场景危机卡'), remote: false });
  },
  'kai-05': (ctx) => {
    // 偏见：0 AP 每轮限 1；常规局翻 1 张危机卡置于当前场景（占该场景本轮限额，记为偏见卡）；决战仅 +2【裁A-10】
    if (ctx.state.roundUsage['kai05']) throw new EngineError('usage_limit', '偏见每轮限用一次');
    ctx.state.roundUsage['kai05'] = true;
    addBuff(ctx.state, { source: 'kai-05', kind: 'attack_add', value: ctx.N(2), target: ctx.character, scope: 'round' });
    if (!ctx.inBattle) {
      const scene = ch(ctx).scene;
      // 【A-45】凯-05 与 P3 偏见为两条独立限额：本卡只记自身计数，不占用 P3 场景限额
      // （场景每轮最多因此产生 2 张额外危机：凯-05 一张 + P3 一张）
      const uid = flipPrejudiceCard(ctx.state, ctx.events, scene);
      if (uid) {
        // 记为偏见卡：凯尔与同场景未结羁绊人类可共同清除结成【裁A-17】
        const humans = (['xiaoyu', 'baye'] as CharacterId[]).filter(
          (h) => ctx.state.characters[h]?.alive && ctx.state.characters[h]?.scene === scene && !hasActiveBond(ctx.state, h, 'kaier'),
        );
        if (humans[0]) ctx.state.bondLeads.push({ pair: pairKey(humans[0], 'kaier'), crisisUid: uid });
      }
    }
  },
  'kai-06': (ctx) => {
    // 贵族决断：弃 2 抽 3（弃牌选择随指令上送）
    const uids = ctx.targets.crisisUids ?? [];
    void uids;
    const discards = (ctx.targets as { cardUids?: string[] }).cardUids ?? [];
    if (discards.length !== 2) throw new EngineError('invalid_target', '须选择 2 张手牌弃置');
    const me = ch(ctx);
    for (const uid of discards) {
      if (!me.hand.includes(uid)) throw new EngineError('card_not_in_hand', '弃置卡不在手牌');
      me.hand.splice(me.hand.indexOf(uid), 1);
      me.discard.push(uid);
    }
    drawCards(ctx.state, ctx.events, ctx.character, 3);
  },
  'kai-07': (ctx) => {
    const t = otherChar(ctx, '同场景友方角色', (c) => c !== ctx.character && ctx.state.characters[c]?.scene === ch(ctx).scene);
    addBuff(ctx.state, { source: 'kai-07', kind: 'guard', value: 0, target: t, partner: ctx.character, scope: 'consumed' });
  },
  'kai-08': (ctx) => {
    if (ctx.inBattle) {
      attackOnBoss(ctx, { base: 2 });
    } else {
      const uids = (ctx.targets.crisisUids ?? []).slice(0, 2);
      if (uids.length === 0) throw new EngineError('invalid_target', '至多选择 2 张危机卡');
      for (const uid of uids) {
        if (crisisSceneOf(ctx.state, uid) !== ch(ctx).scene) throw new EngineError('invalid_target', '破晓冲锋限当前场景');
      }
      attackMulti(ctx, { base: 2, uids });
    }
    ch(ctx).ap = 0; // 结算后剩余 AP 归零
  },
  'kai-09': (ctx) => {
    const bonded = hasActiveBond(ctx.state, 'kaier', 'baye');
    addBuff(ctx.state, {
      source: 'kai-09',
      kind: 'attack_add',
      value: ctx.N(2),
      scene: ch(ctx).scene,
      scope: bonded ? 'rounds' : 'round',
      ...(bonded ? { roundsLeft: 2 } : {}),
    });
  },
  'kai-10': (ctx) => {
    // 为妻而战【裁A-02】：古战场有危机才可打出；其他三场景均无危机 → 6 伤否则 4
    const ab = ctx.state.scenes['ancient_battlefield'].crisisCards.length;
    if (ab === 0) throw new EngineError('condition_not_met', '须古战场废墟下方存在危机卡');
    const othersEmpty = (['human_city', 'elf_kingdom', 'dark_valley'] as SceneId[]).every((s) => ctx.state.scenes[s].crisisCards.length === 0);
    const dmg = othersEmpty ? 6 : 4;
    if (ctx.inBattle) return attackOnBoss(ctx, { base: dmg });
    const uid = ctx.targets.crisisUids?.[0];
    if (!uid || !crisisSceneOf(ctx.state, uid)) throw new EngineError('invalid_target', '须选择任意场景 1 张危机卡');
    attackOnCrisis(ctx, { base: dmg, crisisUid: uid, remote: crisisSceneOf(ctx.state, uid) !== ch(ctx).scene });
  },
};

// ── 巴爷（§9.4）───────────────────────────────────────────────────────────────

const ba: Record<string, Handler> = {
  'ba-01': (ctx) => {
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 3 });
    const uid = ctx.targets.crisisUids?.[0];
    if (!uid || !crisisSceneOf(ctx.state, uid)) throw new EngineError('invalid_target', '须选择任意场景 1 张危机卡');
    attackOnCrisis(ctx, { base: 3, crisisUid: uid, remote: crisisSceneOf(ctx.state, uid) !== ch(ctx).scene });
  },
  'ba-02': (ctx) => {
    // 侠盗直觉：抽 3 选 2 入 1 弃 + 1 材料（牌库抽空→弃牌堆洗混重建→补足【A-Minor】）
    const me = ch(ctx);
    const drawn = drawToTemp(ctx.state, ctx.events, ctx.character, 3);
    if (drawn.length <= 2) {
      me.hand.push(...drawn);
    } else {
      suspendDecision(ctx.state, ctx.events, {
        kind: 'choose_cards',
        decider: ctx.character,
        options: { prompt: '侠盗直觉：选择 2 张加入手牌（其余弃置）', cardUids: drawn, min: 2, max: 2 },
        resume: { sys: 'card', op: 'ba02_pick', data: { character: ctx.character, drawn } },
      });
    }
    gainMaterial(ctx.state, ctx.events, ctx.character, ctx.N(1));
  },
  'ba-03': (ctx) => {
    addBuff(ctx.state, { source: 'ba-03', kind: 'damage_reduce', value: ctx.N(2), target: ctx.character, scope: 'round' });
    drawCards(ctx.state, ctx.events, ctx.character, 1);
  },
  'ba-04': (ctx) => {
    addBuff(ctx.state, { source: 'ba-04', kind: 'attack_add', value: ctx.N(1), scene: ch(ctx).scene, scope: 'round' });
    for (const s of adj(ctx)) addBuff(ctx.state, { source: 'ba-04', kind: 'attack_add', value: ctx.N(1), scene: s, scope: 'round' });
  },
  'ba-05': (ctx) => {
    // 紧急融资：弃 1 装备 +3 AP；无装备 → 失去 1 血（不入链【裁A-29】）+2 AP
    const me = ch(ctx);
    if (me.equipment.length > 0) {
      const uid = (ctx.targets as { cardUids?: string[] }).cardUids?.[0] ?? me.equipment[0]!;
      if (!me.equipment.includes(uid)) throw new EngineError('invalid_target', '须选择弃置的装备');
      me.equipment.splice(me.equipment.indexOf(uid), 1);
      ctx.state.equipmentDisplay.push(uid);
      emitEv(ctx.events, { kind: 'equipment_dropped', character: ctx.character, equipmentUid: uid });
      me.ap += ctx.N(3);
    } else {
      me.hp = Math.max(0, me.hp - ctx.N(1)); // 失去生命：不可代受不可减免
      emitEv(ctx.events, { kind: 'character_damaged', character: ctx.character, amount: ctx.N(1), source: 'ba-05', dark: false });
      me.ap += ctx.N(2);
      if (me.hp <= 0) {
        const { eliminate } = require_damage();
        eliminate(ctx.state, ctx.events, ctx.character);
      }
    }
  },
  'ba-06': (ctx) => {
    const alone = !ctx.state.turnOrder.some((c) => c !== ctx.character && ctx.state.characters[c]?.alive && ctx.state.characters[c]?.scene === ch(ctx).scene);
    const mods: ChainNode[] = alone ? [{ op: 'MULT', value: 2, source: 'ba-06' }] : [];
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 3, cardMods: mods });
    attackOnCrisis(ctx, { base: 3, crisisUid: targetCrisisIn(ctx, curOrRanged(ctx), '当前场景危机卡'), remote: false, cardMods: mods });
  },
  'ba-07': (ctx) => {
    // 战地抢修：当前场景 1 伤 + 选展示区 1 装备下次锻造 -1/-1（任何人可享【裁A-38】）
    if (!ctx.inBattle) {
      const uid = targetCrisisIn(ctx, curOrRanged(ctx), '当前场景危机卡');
      attackOnCrisis(ctx, { base: 1, crisisUid: uid, remote: false });
    } else attackOnBoss(ctx, { base: 1 });
    const eq = (ctx.targets as { cardUids?: string[] }).cardUids?.[0];
    if (eq && ctx.state.equipmentDisplay.includes(eq)) {
      ctx.state.flags.oneShotUsed[`ba07:${eq}`] = true;
    }
  },
  'ba-08': (ctx) => {
    // 王牌驾驶员：飞空艇移至任意场景（不耗次数）+ 目标场景 1 危机卡 2 伤
    const to = ctx.targets.scene;
    if (!ctx.inBattle) {
      if (!to || !(to in ctx.state.scenes)) throw new EngineError('invalid_target', '须选择目标场景');
      moveEffect(ctx, ctx.character, to, 'ba-08');
    }
    if (ctx.inBattle) return attackOnBoss(ctx, { base: 2 });
    attackOnCrisis(ctx, { base: 2, crisisUid: targetCrisisIn(ctx, [ch(ctx).scene], '目标场景危机卡'), remote: false });
  },
  'ba-09': (ctx) => {
    const k = ctx.state.characters['kaier'];
    if (!k?.alive || k.scene !== ch(ctx).scene) throw new EngineError('condition_not_met', '须与凯尔同场景');
    addBuff(ctx.state, { source: 'ba-09', kind: 'share', value: 0, target: ctx.character, partner: 'kaier', scope: 'round' });
    addBuff(ctx.state, { source: 'ba-09', kind: 'share', value: 0, target: 'kaier', partner: ctx.character, scope: 'round' });
    if (hasActiveBond(ctx.state, 'kaier', 'baye')) {
      healCharacter(ctx.state, ctx.events, ctx.character, ctx.N(1));
      healCharacter(ctx.state, ctx.events, 'kaier', ctx.N(1));
    }
  },
  'ba-10': (ctx) => {
    // 最终航班：一局限 1 次，用后移出游戏；所有友方移至你当前场景
    if (ctx.state.flags.oneShotUsed['ba-10']) throw new EngineError('usage_limit', '最终航班一局限用一次');
    ctx.state.flags.oneShotUsed['ba-10'] = true;
    if (!ctx.inBattle) {
      for (const c of ctx.state.turnOrder) {
        if (c !== ctx.character) moveEffect(ctx, c, ch(ctx).scene, 'ba-10');
      }
    }
  },
};

import { eliminate as _eliminate } from './damage.js';
function require_damage() {
  return { eliminate: _eliminate };
}

// ── 注册表与打出入口 ───────────────────────────────────────────────────────────

const HANDLERS: Record<string, Handler> = { ...yu, ...ya, ...kai, ...ba };

export function supportsCard(defId: string): boolean {
  return defId in HANDLERS;
}

/**
 * 打出卡牌（B2，1 AP/卡面费用）。
 * 前置（回合/手牌/AP）由 actions.ts 校验；此处做卡面条件与效果结算。
 * 返回 'return_to_hand'（雅-01 清除回收）/ 'remove_from_game'（巴-10）/ null（入弃牌堆）。
 */
export function resolveCard(ctx: CardContext): 'return_to_hand' | 'remove_from_game' | null {
  const defId = ctx.state.cards[ctx.cardUid]?.defId ?? '';
  const handler = HANDLERS[defId];
  if (!handler) throw new EngineError('invalid_command', `卡牌 ${defId} 无结算器`);
  const beforeClearCheck = defId === 'ya-01' ? ctx.targets.crisisUids?.[0] : null;
  handler(ctx);
  emitEv(ctx.events, { kind: 'card_played', character: ctx.character, cardUid: ctx.cardUid, cardDefId: defId });
  if (defId === 'ba-10') return 'remove_from_game';
  if (defId === 'ya-01' && beforeClearCheck) {
    // 若此攻击导致该危机被清除 → 收回手牌不进弃牌堆【L325】
    if (!crisisSceneOf(ctx.state, beforeClearCheck) && !ctx.state.pendingDecision) return 'return_to_hand';
    // 清除后若挂起了决策（如羁绊结成），仍视为已清除
    if (!crisisSceneOf(ctx.state, beforeClearCheck)) return 'return_to_hand';
  }
  return null;
}

/** resume 'card:ya03_reorder'（精灵地图重排） */
export function resumeYa03Reorder(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const top3 = data['top3'] as string[];
  const order = ((choice as Record<string, unknown>)?.['order'] as string[] | undefined) ?? top3;
  const valid = [...order].filter((u) => top3.includes(u));
  for (const u of top3) if (!valid.includes(u)) valid.push(u);
  // 【暗】全部置【整个牌库底】【A-38】（保持所选相对顺序；非暗卡在所选顺序后置顶）
  const dark = valid.filter((u) => state.cards[u] && isDark(state, u));
  const normal = valid.filter((u) => !isDark(state, u));
  const rest = state.decks.crisis.slice(top3.length);
  state.decks.crisis = [...normal, ...rest, ...dark];
  emitEv(events, { kind: 'flag_set', flag: 'deck_top_reordered', value: { count: top3.length } });
}

function isDark(state: GameState, uid: string): boolean {
  const defId = state.cards[uid]?.defId;
  return defId === 'crisis-02' || defId === 'crisis-03' || defId === 'crisis-04' || defId === 'crisis-09' || defId === 'crisis-10';
}

/** resume 'card:ba02_pick'（侠盗直觉选牌） */
export function resumeBa02Pick(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const character = data['character'] as CharacterId;
  const drawn = data['drawn'] as string[];
  const pick = ((choice as Record<string, unknown>)?.['cardUids'] as string[] | undefined) ?? [];
  if (pick.length !== 2 || pick.some((u) => !drawn.includes(u))) throw new EngineError('invalid_choice', '须从所抽 3 张中选 2 张');
  const me = state.characters[character]!;
  for (const u of drawn) {
    if (pick.includes(u)) {
      me.hand.push(u);
      emitEv(events, { kind: 'card_drawn', character, cardUid: u, cardDefId: state.cards[u]?.defId ?? '' });
    } else {
      me.discard.push(u);
    }
  }
}

export { ACTION_CARD_BY_ID };

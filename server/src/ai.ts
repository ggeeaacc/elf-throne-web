/**
 * AI 托管驱动（ADR-004 扩展）：AI 座位无真实 ws 连接，由服务端按启发式自动应答决策/执行行动。
 * 原则：合法性一律由引擎裁决——AI 只按优先级产出候选指令，applyCommand 拒绝即换下一个；
 *      每回合尝试上限 + 微延迟逐步执行（真人可观战），杜绝同步递归与死循环。
 *
 * AI 决策优先级（行动阶段）：
 *   1. 本场景有危机 → 先用 Buff 卡（仅当剩余 AP 够攻击时）→ 再攻击（最高伤害优先）
 *   2. 主动移动到危机更多的相邻场景（本场景无危机，或相邻场景比本地多 ≥2 且有余裕 AP）
 *   3. 任意队友 HP < 50% → 治疗最残血队友（治疗卡 / 生命树 / 通用治疗）
 *   4. 远程攻击异场景危机
 *   5. 锻造（材料 ≥ 2）
 *   6. 搜索（每回合最多 1 次）
 *   7. end_turn（兜底）
 *
 * 决战阶段：
 *   1. 任意队友 HP < 50% → 治疗最残血队友
 *   2. Buff（仅当剩余 AP 够攻击）→ 攻击 Boss
 *   3. 援护残血队友
 *   4. 净化蓄能
 *   5. 搜索（兜底抽牌）
 *   6. end_turn（兜底）
 */
import {
  ACTION_CARD_BY_ID,
  CHARACTERS,
  CRISIS_CARD_BY_ID,
  EQUIPMENT_CARD_BY_ID,
  SCENES,
  applyCommand,
} from '@elf-throne/engine';
import type {
  ActionCardDef,
  CharacterId,
  Command,
  GameEvent,
  GameState,
  PendingDecision,
  SceneId,
} from '@elf-throne/engine';
import type { Room } from './rooms.js';

const AI_DELAY_MIN = 300;
const AI_DELAY_MAX = 600;
/** 每回合最大候选尝试次数，超限直接结束回合（防死循环保险丝） */
const MAX_ATTEMPTS = 12;

/** 决策类型中文短标签（AI 日志用） */
const DECISION_LABELS: Record<string, string> = {
  place_crisis: '放置危机',
  choose_character: '选择角色',
  choose_crisis: '选择危机卡',
  choose_bond_card: '选择羁绊卡',
  choose_option: '选择方案',
  choose_cards: '选择卡牌',
  order_effects: '效果排序',
  reorder_cards: '整理牌序',
  choose_share_high: '分摊伤害',
  choose_redirect: '伤害代受',
  choose_equipment: '装备归属',
};

// ── 卡牌分类辅助 ────────────────────────────────────────────────────────────────

/** 对自己/友方提供攻击增益的 Buff 卡 */
const BUFF_CARD_IDS = new Set(['ya-07', 'kai-09', 'ba-04']);
// 雅-07 风之加护：指定友方下一攻 +2
// 凯-09 精灵荣光：同场景友方本回合攻击 +2
// 巴-04 弩炮掩护：同/邻场景友方本回合攻击 +1

/** 治疗标签卡（引擎识别 heal tag） */
function isHealCard(d: ActionCardDef): boolean {
  return d.tags.includes('heal');
}

function isBuffCard(d: ActionCardDef): boolean {
  return BUFF_CARD_IDS.has(d.id);
}

/** 估算攻击卡基础伤害（AI 用于排序，不影响结算） */
function estimatedDamage(d: ActionCardDef): number {
  const map: Record<string, number> = {
    'yu-01': 3,  // 横斩
    'yu-03': 2,  // 纵斩突进（+1 若巴爷在场）
    'yu-05': 4,  // 十字剑气
    'yu-08': 2,  // 多节变形弓（双目标各 1）
    'yu-10': 3,  // 为爱而战（基础 1 + erosion，暂估 3）
    'ya-01': 3,  // 精灵箭
    'ya-06': 4,  // 箭雨（双目标各 2）
    'ya-09': 3,  // 追踪箭
    'ya-10': 1,  // 为你而来（路过伤 1）
    'kai-02': 4, // 精灵剑术（+1 若偏见已用）
    'kai-04': 3, // 王夫之怒（古战场下方危机数 +2，暂估 3）
    'kai-08': 4, // 破晓冲锋（双目标各 2）
    'kai-10': 4, // 为妻而战
    'ba-01': 3,  // 舰炮轰击
    'ba-06': 3,  // 孤胆英雄（独处翻倍 6）
    'ba-07': 1,  // 战地抢修
    'ba-08': 2,  // 王牌驾驶员
  };
  return map[d.id] ?? (d.tags.includes('attack') ? 1 : 0);
}

// ── 卡牌辅助函数 ────────────────────────────────────────────────────────────────

interface HandEntry {
  uid: string;
  def: ActionCardDef | undefined;
}

function resolveHand(ch: { hand: string[] }, state: GameState): HandEntry[] {
  return ch.hand.map((uid) => ({ uid, def: ACTION_CARD_BY_ID.get(state.cards[uid]?.defId ?? '') }));
}

/** 可打出的攻击卡（本场景用，非 remote），按估算伤害降序 */
function attackCardsHere(hand: HandEntry[], ap: number): HandEntry[] {
  return hand
    .filter((h) => h.def && h.def.tags.includes('attack') && h.def.remote !== true && h.def.costAP <= ap)
    .sort((a, b) => estimatedDamage(b.def!) - estimatedDamage(a.def!));
}

/** 给攻击卡补充装备选择（巴-07 战地抢修需要指定展示区装备） */
function withEquipTarget(targets: Record<string, unknown>, defId: string | undefined, state: GameState): Record<string, unknown> {
  if (defId === 'ba-07' && state.equipmentDisplay.length > 0) {
    return { ...targets, cardUids: [state.equipmentDisplay[0]!] };
  }
  return targets;
}

/** 可打出的远程攻击卡 */
function attackCardsRemote(hand: HandEntry[], ap: number): HandEntry[] {
  return hand
    .filter((h) => h.def && h.def.tags.includes('attack') && (h.def.remote === true || h.def.remote === 'conditional') && h.def.costAP <= ap)
    .sort((a, b) => estimatedDamage(b.def!) - estimatedDamage(a.def!));
}

function charName(cid: string): string {
  return CHARACTERS[cid as CharacterId]?.name ?? cid;
}

// ── 危机查找 ────────────────────────────────────────────────────────────────────

function bestCrisisIn(state: GameState, sceneId: SceneId): string | null {
  const sc = state.scenes[sceneId];
  if (!sc) return null;
  let best: string | null = null;
  let bestRemain = -1;
  for (const uid of sc.crisisCards) {
    const def = CRISIS_CARD_BY_ID.get(state.cards[uid]?.defId ?? '');
    if (!def) continue;
    const remain = def.crisisValue - (sc.crisisDamage[uid] ?? 0);
    if (remain > bestRemain) {
      bestRemain = remain;
      best = uid;
    }
  }
  return best;
}

function bestCrisisAnywhere(state: GameState): string | null {
  let best: string | null = null;
  let bestRemain = -1;
  for (const sc of Object.values(state.scenes)) {
    const uid = bestCrisisIn(state, sc.id);
    if (!uid) continue;
    const def = CRISIS_CARD_BY_ID.get(state.cards[uid]?.defId ?? '');
    const remain = (def?.crisisValue ?? 0) - (sc.crisisDamage[uid] ?? 0);
    if (remain > bestRemain) {
      bestRemain = remain;
      best = uid;
    }
  }
  return best;
}

/** 找到全队 HP 比例最低的存活角色（AI 治疗目标选择用） */
function mostWoundedAlly(state: GameState): { id: CharacterId; hpPct: number } | null {
  let worst: { id: CharacterId; hpPct: number } | null = null;
  let worstPct = 1;
  for (const ch of Object.values(state.characters)) {
    if (!ch.alive) continue;
    const pct = ch.maxHp > 0 ? ch.hp / ch.maxHp : 0;
    if (pct < worstPct) {
      worstPct = pct;
      worst = { id: ch.id, hpPct: pct };
    }
  }
  return worst;
}

/** 找到全场有危机且本场景之外的场景中危机最多的 */
function bestCrisisElsewhere(state: GameState, myScene: SceneId): string | null {
  let best: string | null = null;
  let bestRemain = -1;
  for (const sc of Object.values(state.scenes)) {
    if (sc.id === myScene) continue;
    const uid = bestCrisisIn(state, sc.id);
    if (!uid) continue;
    const def = CRISIS_CARD_BY_ID.get(state.cards[uid]?.defId ?? '');
    const remain = (def?.crisisValue ?? 0) - (sc.crisisDamage[uid] ?? 0);
    if (remain > bestRemain) {
      bestRemain = remain;
      best = uid;
    }
  }
  return best;
}

// ── AI 角色识别 ────────────────────────────────────────────────────────────────

function aiCharacters(room: Room): Set<CharacterId> {
  const st = room.state!;
  const aiSeats = new Set([...room.players.values()].filter((p) => p.isAI).map((p) => p.seat));
  const set = new Set<CharacterId>();
  for (const [seat, chars] of Object.entries(st.config.seatAssignments)) {
    if (aiSeats.has(Number(seat))) for (const c of chars) set.add(c);
  }
  return set;
}

// ── 行动候选生成 ────────────────────────────────────────────────────────────────

/**
 * AI 行动候选（按优先级排序，end_turn 兜底永远在最后）。
 *
 * @param attemptCount 本回合第几次尝试（由 AiDriver.tick 传入）
 *   attemptCount=1 时允许搜索；>1 时禁止搜索（防搜索刷牌死循环）。
 */
export function aiActionCandidates(state: GameState, cid: CharacterId, attemptCount = 1): Command[] {
  const ch = state.characters[cid]!;
  const ap = ch.ap;
  const out: Command[] = [];
  const inBattle = state.phase.kind === 'final_battle';
  const hand = resolveHand(ch, state);
  const hpPct = ch.maxHp > 0 ? ch.hp / ch.maxHp : 0;
  const scene = state.scenes[ch.scene];
  const hasCrisisHere = scene ? scene.crisisCards.length > 0 : false;
  const bestHere = hasCrisisHere ? bestCrisisIn(state, ch.scene) : null;

  // ═══════════════════════════════════════════════════════════════
  // 行动阶段（常规）
  // ═══════════════════════════════════════════════════════════════
  if (!inBattle) {
    //
    // 1. 本场景有危机 → 先用 Buff 提升输出 → 再攻击（最高伤害优先）
    //
    if (hasCrisisHere) {
      // 1a. Buff 卡（仅当剩余 AP 仍足够打出一张攻击卡时才使用，避免 Buff 后无力攻击）
      for (const { uid, def } of hand) {
        if (def && isBuffCard(def) && def.costAP <= ap) {
          const canAttackAfter = attackCardsHere(hand, ap - def.costAP).length > 0;
          if (canAttackAfter) {
            out.push({ type: 'play_card', character: cid, cardUid: uid, targets: {} });
          }
        }
      }

      // 1b. 攻击卡（近战，打当前场景危机）
      if (bestHere) {
        for (const h of attackCardsHere(hand, ap)) {
          out.push({ type: 'play_card', character: cid, cardUid: h.uid, targets: withEquipTarget({ crisisUids: [bestHere] }, h.def?.id, state) });
        }
      }
    }

    //
    // 2. 主动移动：本场景无危机 OR 相邻场景危机更多（至少多2张才值得跑一趟）
    //
    const crisisScenes = (SCENES[ch.scene]?.adjacent ?? [])
      .filter((s) => (state.scenes[s]?.crisisCards.length ?? 0) > 0)
      .sort((a, b) => (state.scenes[b]?.crisisCards.length ?? 0) - (state.scenes[a]?.crisisCards.length ?? 0));
    const bestOtherCount = crisisScenes.length > 0 ? (state.scenes[crisisScenes[0]!]?.crisisCards.length ?? 0) : 0;
    const localCount = scene?.crisisCards.length ?? 0;
    // 移动条件：本地无危机；或相邻场景比本地多 ≥2 且还有 AP 去打仗
    const shouldMove = (!hasCrisisHere || (bestOtherCount >= localCount + 2 && ap >= 2)) && ap >= 1;
    if (shouldMove) {
      // 2a. 移动卡（有 move tag）
      for (const { uid, def } of hand) {
        if (def && def.tags.includes('move') && def.costAP <= ap) {
          for (const to of crisisScenes) {
            out.push({ type: 'play_card', character: cid, cardUid: uid, targets: { scene: to } });
          }
          // 也尝试无 targets（有些移动卡目标特殊，如 鱼-07 飞向莉雅）
          out.push({ type: 'play_card', character: cid, cardUid: uid, targets: {} });
        }
      }

      // 2b. 基础移动（1 AP，相邻场景）
      for (const to of crisisScenes) {
        out.push({ type: 'move', character: cid, to });
      }
    }

    //
    // 3. 任意队友 HP < 50% → 治疗最残血队友（而非只奶自己）
    //
    const wounded = mostWoundedAlly(state);
    if (wounded && wounded.hpPct < 0.5) {
      const healTarget = wounded.id;
      // 3a. 治疗标签卡（雅-04 治愈之矢 / 鱼-06 意志抵抗）
      for (const { uid, def } of hand) {
        if (def && isHealCard(def) && def.costAP <= ap) {
          out.push({ type: 'play_card', character: cid, cardUid: uid, targets: {} });
          out.push({ type: 'play_card', character: cid, cardUid: uid, targets: { characters: [healTarget] } });
        }
      }

      // 3b. 精灵王国生命树场景行动（1 AP）
      if (ch.scene === 'elf_kingdom' && ap >= 1) {
        out.push({ type: 'scene_action', character: cid, action: 'tree_heal', params: { target: healTarget } });
      }

      // 3c. 通用治疗（弃一张手牌回血）
      if (ap >= 1 && ch.hand.length > 0) {
        const matCard = hand.find((h) => h.def?.material);
        const discard = matCard?.uid ?? ch.hand[0]!;
        out.push({ type: 'heal', character: cid, discardUid: discard, target: healTarget });
      }
    }

    //
    // 4. 远程攻击异场景危机
    //
    const farCrisis = bestCrisisElsewhere(state, ch.scene);
    if (farCrisis) {
      for (const h of attackCardsRemote(hand, ap)) {
        out.push({ type: 'play_card', character: cid, cardUid: h.uid, targets: withEquipTarget({ crisisUids: [farCrisis] }, h.def?.id, state) });
      }
    }

    //
    // 5. 锻造（材料 ≥ 2）
    //
    if (ap >= 2 && state.equipmentDisplay.length > 0) {
      const mats = hand.filter((h) => h.def?.material).map((h) => h.uid);
      if (ch.materialTokens + mats.length >= 2) {
        const useTokens = Math.min(ch.materialTokens, 2);
        out.push({
          type: 'forge',
          character: cid,
          equipmentUid: state.equipmentDisplay[0]!,
          materialCardUids: mats.slice(0, 2 - useTokens),
          useTokens,
        });
      }
    }

    //
    // 6. 搜索（每回合最多 1 次，且有余裕时）
    //
    if (attemptCount <= 1 && ap >= 1) {
      out.push({ type: 'search', character: cid });
    }

  // ═══════════════════════════════════════════════════════════════
  // 决战阶段
  // ═══════════════════════════════════════════════════════════════
  } else {
    //
    // 1. 任意队友 HP < 50% → 治疗最残血队友（保命优先）
    //
    const woundedB = mostWoundedAlly(state);
    if (woundedB && woundedB.hpPct < 0.5) {
      const healTarget = woundedB.id;
      for (const { uid, def } of hand) {
        if (def && isHealCard(def) && def.costAP <= ap) {
          out.push({ type: 'play_card', character: cid, cardUid: uid, targets: {} });
          out.push({ type: 'play_card', character: cid, cardUid: uid, targets: { characters: [healTarget] } });
        }
      }
      if (ch.scene === 'elf_kingdom' && ap >= 1) {
        out.push({ type: 'scene_action', character: cid, action: 'tree_heal', params: { target: healTarget } });
      }
      if (ap >= 1 && ch.hand.length > 0) {
        const matCard = hand.find((h) => h.def?.material);
        out.push({ type: 'heal', character: cid, discardUid: matCard?.uid ?? ch.hand[0]!, target: healTarget });
      }
    }

    //
    // 2. Buff 后全力输出 Boss（仅当剩余 AP 够攻击时才 Buff）
    //
    for (const { uid, def } of hand) {
      if (def && isBuffCard(def) && def.costAP <= ap) {
        const remainingAP = ap - def.costAP;
        const canAttackAfter = hand.some(
          (h) => h.def && h.def.tags.includes('attack') && h.def.costAP <= remainingAP,
        );
        if (canAttackAfter) {
          out.push({ type: 'play_card', character: cid, cardUid: uid, targets: {} });
        }
      }
    }

    const bossAttacks = hand
      .filter((h) => h.def && h.def.tags.includes('attack') && h.def.costAP <= ap)
      .sort((a, b) => estimatedDamage(b.def!) - estimatedDamage(a.def!));
    for (const h of bossAttacks) {
      out.push({ type: 'play_card', character: cid, cardUid: h.uid, targets: withEquipTarget({}, h.def?.id, state) });
    }

    //
    // 3. 援护同场景最残血队友
    //
    const allies = Object.values(state.characters)
      .filter((c) => c.alive && c.id !== cid && c.scene === ch.scene)
      .sort((a, b) => a.hp - b.hp);
    if (ap >= 1 && allies.length > 0) {
      out.push({ type: 'guard', character: cid, target: allies[0]!.id });
    }

    //
    // 4. 净化蓄能
    //
    if (ap >= 1) {
      out.push({ type: 'purify_charge', character: cid });
    }

    //
    // 5. 搜索（每回合最多 1 次，兜底抽牌）
    //
    if (attemptCount <= 1 && ap >= 1) {
      out.push({ type: 'search', character: cid });
    }
  }

  // 兜底：结束回合
  out.push({ type: 'end_turn', character: cid });
  return out;
}

// ── 决策应答 ────────────────────────────────────────────────────────────────────

/**
 * AI 决策应答（镜像 engine test-utils 的 defaultChoice 策略 + 危机优先目标）：
 * 放置危机→当前危机最少场景（轮转防堆叠）；选择危机→危机度剩余最高；其余→第一个合法选项。
 */
export function aiChoice(d: PendingDecision, s: GameState): unknown {
  const o = (d.options ?? {}) as Record<string, unknown>;
  switch (d.kind) {
    case 'place_crisis': {
      const scenes = Object.values(s.scenes);
      const minCount = Math.min(...scenes.map((x) => x.crisisCards.length));
      const tied = scenes.filter((x) => x.crisisCards.length === minCount);
      const allowed = new Set((o['scenes'] as string[] | undefined) ?? tied.map((x) => x.id));
      const pool = tied.filter((x) => allowed.has(x.id));
      const pick = (pool.length > 0 ? pool : tied)[s.phase.round % (pool.length > 0 ? pool.length : tied.length)]!;
      return { scene: pick.id };
    }
    case 'choose_crisis': {
      const uids = (o['cardUids'] as string[] | undefined) ?? [];
      let best: string | undefined = uids[0];
      let bestRemain = -1;
      for (const uid of uids) {
        const def = CRISIS_CARD_BY_ID.get(s.cards[uid]?.defId ?? '');
        if (!def) continue;
        const sc = Object.values(s.scenes).find((x) => x.crisisCards.includes(uid));
        const remain = def.crisisValue - (sc?.crisisDamage[uid] ?? 0);
        if (remain > bestRemain) {
          bestRemain = remain;
          best = uid;
        }
      }
      return { cardUid: best ?? null };
    }
    case 'choose_character':
      return { character: (o['candidates'] as string[])[0] };
    case 'choose_cards': {
      const min = (o['min'] as number | undefined) ?? 1;
      return { cardUids: (o['cardUids'] as string[]).slice(0, min) };
    }
    case 'choose_bond_card':
      return { cardUid: (o['candidateUids'] as string[])[0] };
    case 'choose_option': {
      const opts = o['options'] as Array<{ id: string }>;
      const prompt = (o['prompt'] as string | undefined) ?? '';
      // 羁-07 兄妹同心：复制会以原目标半价重放原卡——原危机若已被清除，重放校验必抛错（引擎行为）。
      // AI 无法从 options 判断目标是否仍合法，一律「不复制」规避软锁。
      if (prompt.includes('兄妹同心')) return { option: opts.find((x) => x.id === 'pass')?.id ?? opts[0]!.id };
      return { option: opts[0]!.id };
    }
    case 'order_effects':
      return { order: (o['items'] as Array<{ uid: string }>).map((i) => i.uid) };
    case 'reorder_cards':
      return o['mode'] === 'scout' ? { bottom: (o['cardUids'] as string[])[0] } : { order: o['cardUids'] };
    case 'choose_share_high':
      return { highTaker: (o['candidates'] as string[])[0] };
    case 'choose_redirect':
      return { buffId: (o['candidates'] as Array<{ buffId: string }>)[0]!.buffId };
    case 'choose_equipment':
      return { equipmentUid: (o['equipmentUids'] as string[])[0], owner: (o['owners'] as string[] | undefined)?.[0] };
    default:
      return {};
  }
}

// ── 日志 ────────────────────────────────────────────────────────────────────────

function describe(cmd: Command, state: GameState): string | null {
  const name = charName(cmd.type === 'resolve_decision' ? '' : (cmd as { character?: CharacterId }).character ?? '');
  switch (cmd.type) {
    case 'play_card': {
      const defId = state.cards[cmd.cardUid]?.defId ?? '';
      const cardName = ACTION_CARD_BY_ID.get(defId)?.name ?? defId;
      return `🤖 ${name}(AI) 打出「${cardName}」`;
    }
    case 'move':
      return `🤖 ${name}(AI) 移动至「${SCENES[cmd.to]?.name ?? cmd.to}」`;
    case 'search':
      return `🤖 ${name}(AI) 搜索`;
    case 'forge': {
      const defId = state.cards[cmd.equipmentUid]?.defId ?? '';
      return `🤖 ${name}(AI) 锻造「${EQUIPMENT_CARD_BY_ID.get(defId)?.name ?? defId}」`;
    }
    case 'heal':
      return `🤖 ${name}(AI) 治疗 ${charName(cmd.target)}`;
    case 'guard':
      return `🤖 ${name}(AI) 援护 ${charName(cmd.target)}`;
    case 'purify_charge':
      return `🤖 ${name}(AI) 净化蓄能`;
    case 'gem_attune':
      return `🤖 ${name}(AI) 宝玉共鸣`;
    case 'scene_action':
      return `🤖 ${name}(AI) 场景行动 ${cmd.action}`;
    default:
      return null;
  }
}

// ── AiDriver ────────────────────────────────────────────────────────────────────

export interface AiDriverDeps {
  /** 状态变更后广播投影（registry.broadcastViews） */
  broadcastViews: (room: Room, events?: GameEvent[]) => void;
  /** 广播 AI 日志行（registry.broadcastLog） */
  broadcastLog: (room: Room, text: string) => void;
  /** 标记对局结束（registry 侧置 finished） */
  markFinished: (room: Room) => void;
}

export class AiDriver {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private attempts = new Map<string, { key: string; count: number }>();
  private failNote = new Map<string, { id: string; count: number }>();

  constructor(private deps: AiDriverDeps) {}

  /** 状态广播后调用：若当前该 AI 行动/应答且未排程，则排一个微延迟 tick */
  poke(room: Room): void {
    if (room.status !== 'playing' || !room.state) return;
    if (this.timers.has(room.id)) return;
    if (!this.nextActor(room)) return;
    const delay = AI_DELAY_MIN + Math.random() * (AI_DELAY_MAX - AI_DELAY_MIN);
    const timer = setTimeout(() => {
      this.timers.delete(room.id);
      this.tick(room);
    }, delay);
    timer.unref?.();
    this.timers.set(room.id, timer);
  }

  /** 当前是否有 AI 该做的事：AI 角色的挂起决策优先，其次 AI 角色的行动回合 */
  private nextActor(room: Room): { kind: 'decision' | 'action'; character: CharacterId } | null {
    const st = room.state!;
    const ai = aiCharacters(room);
    const d = st.pendingDecision;
    if (d && d.decider !== 'all' && ai.has(d.decider)) return { kind: 'decision', character: d.decider };
    const cur = st.currentTurn?.character;
    if (!d && cur && ai.has(cur)) return { kind: 'action', character: cur };
    return null;
  }

  private tick(room: Room): void {
    if (room.status !== 'playing' || !room.state) return;
    const actor = this.nextActor(room);
    if (!actor) return;
    const st = room.state;

    if (actor.kind === 'decision') {
      const d = st.pendingDecision!;
      // 同一决策连续失败 3 次 → 放弃驱动交还真人（防无限重试）；成功或新决策则清零
      const fk = this.failNote.get(room.id);
      if (fk && fk.id === d.id && fk.count >= 3) return;
      try {
        const r = applyCommand(st, { type: 'resolve_decision', decisionId: d.id, choice: aiChoice(d, st) });
        room.state = r.state;
        if (r.state.result) this.deps.markFinished(room);
        this.deps.broadcastLog(room, `🤖 ${charName(actor.character)}(AI) 决策：${DECISION_LABELS[d.kind] ?? d.kind}`);
        this.deps.broadcastViews(room, r.events);
        this.failNote.delete(room.id);
      } catch (err) {
        const prompt = (d.options as { prompt?: string } | null)?.prompt ?? '';
        console.error(
          `[ai] 决策应答失败（${d.kind}｜${d.resume.sys}:${d.resume.op}｜${prompt}）：`,
          err instanceof Error ? err.message : err,
        );
        this.failNote.set(room.id, { id: d.id, count: (fk?.id === d.id ? fk.count : 0) + 1 });
      }
      this.poke(room);
      return;
    }

    // 行动：按回合键重置尝试计数；超限直接结束回合
    const cid = actor.character;
    const key = `${st.phase.day}/${st.phase.segment}/${st.phase.round}/${st.turnPointer}/${cid}`;
    const rec = this.attempts.get(room.id);
    const count = rec?.key === key ? rec.count + 1 : 1;
    this.attempts.set(room.id, { key, count });
    if (count > MAX_ATTEMPTS + 2) {
      // 连 end_turn 都被拒（状态异常）——放弃排程交还真人，杜绝无限重试
      console.error(`[ai] ${cid} 尝试 ${count} 次仍无法行动，放弃本回合驱动`);
      return;
    }
    const candidates =
      count > MAX_ATTEMPTS
        ? [{ type: 'end_turn', character: cid } as Command]
        : aiActionCandidates(st, cid, count);

    for (const cmd of candidates) {
      const label = describe(cmd, st);
      try {
        const r = applyCommand(st, cmd);
        room.state = r.state;
        if (r.state.result) this.deps.markFinished(room);
        if (label) this.deps.broadcastLog(room, label);
        this.deps.broadcastViews(room, r.events);
        break;
      } catch {
        // 引擎裁决不合法，尝试下一个候选
      }
    }
    this.poke(room);
  }
}

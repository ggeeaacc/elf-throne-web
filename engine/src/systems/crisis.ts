/**
 * 危机系统：P1 翻牌管线（§5.1）+ P4① 轮末效果（§5.4【裁A-14】）。
 */
import { CRISIS_CARD_BY_ID } from '../content/crisis-cards.js';
import { MODE_TABLE } from '../content/modes.js';
import type { CharacterId, GameEvent, GameState, SceneId } from '../types.js';
import { EngineError } from '../types.js';
import { drawCrisisTop, emitEv, shuffleInPlace, suspendDecision } from './common.js';
import { changeErosion, dealDamageToCharacter, gainPurify, isBerserk } from './damage.js';
import { drawCards } from './common.js';

// ── P1 危机蔓延（§5.1）────────────────────────────────────────────────────────

/**
 * 翻开并放置危机卡（逐张翻开逐张结算）。
 * 通用卡 → place_crisis 决策（协商映射：本轮首位行动玩家定夺【L93】）；
 * 决策后由 decisions.ts resume 'crisis:flip_next' 续算剩余翻牌。
 */
export function runCrisisPhase(state: GameState, events: GameEvent[]): void {
  const mode = MODE_TABLE[state.config.playerCount];
  const segIdx = state.phase.segment === 'dawn' ? 0 : state.phase.segment === 'dusk' ? 1 : 2;
  const n = mode.crisisFlips[state.phase.day][segIdx];
  flipNext(state, events, { remaining: n, index: 0, total: n });
}

interface FlipContext {
  remaining: number;
  index: number;   // 本轮第 i 张（1-based 判定用 index+1）
  total: number;
}

function flipNext(state: GameState, events: GameEvent[], ctx: FlipContext): void {
  if (ctx.remaining <= 0 || state.result) return;
  ctx.index += 1;

  // a. D2 黄昏当日第 1 张固定为旁置通牒卡（计入当日数量【L69】）
  let uid: string | null = null;
  if (state.phase.day === 2 && state.phase.segment === 'dusk' && ctx.index === 1 && state.ultimatumAsideUid) {
    uid = state.ultimatumAsideUid;
    state.ultimatumAsideUid = null;
  } else {
    uid = drawCrisisTop(state, events);
  }
  if (!uid) return; // 牌库与弃牌堆均空（极端）
  ctx.remaining -= 1;

  const def = CRISIS_CARD_BY_ID.get(state.cards[uid]?.defId ?? '');
  if (!def) throw new EngineError('invalid_command', '危机卡定义缺失');

  // c. 目标场景
  if (def.scene !== 'any') {
    placeCrisis(state, events, uid, def.scene);
    flipNext(state, events, ctx);
    return;
  }
  // 通用 → 玩家协商（映射：本轮首位行动玩家定夺）
  const decider = state.turnOrder.find((c) => state.characters[c]?.alive) ?? state.turnOrder[0]!;
  suspendDecision(state, events, {
    kind: 'place_crisis',
    decider,
    options: {
      prompt: `通用危机卡「${def.name}」放置到哪个场景？`,
      cardUid: uid,
      cardDefId: def.id,
      scenes: ['human_city', 'elf_kingdom', 'ancient_battlefield', 'dark_valley'],
    },
    resume: { sys: 'crisis', op: 'flip_next', data: { uid, ctx } },
  });
}

/** resume 'crisis:flip_next'：通用卡落点回答后续算 */
export function resumeFlipNext(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const uid = data['uid'] as string;
  const ctx = data['ctx'] as FlipContext;
  const scene = (choice as Record<string, unknown>)?.['scene'] as SceneId | undefined;
  if (!scene || !(scene in state.scenes)) throw new EngineError('invalid_choice', '落点场景非法');
  placeCrisis(state, events, uid, scene);
  flipNext(state, events, ctx);
}

/** 放置危机卡（正面朝上、立即生效；偏见翻牌同样走此） */
export function placeCrisis(state: GameState, events: GameEvent[], uid: string, scene: SceneId): void {
  const def = CRISIS_CARD_BY_ID.get(state.cards[uid]?.defId ?? '');
  // 羁-05 主动：场景守护——改为弃置并移除指示物（不算清除、无奖励【裁A-09】）
  if ((state.sceneWards[scene] ?? 0) > 0) {
    state.sceneWards[scene] = 0;
    state.decks.crisisDiscard.push(uid);
    emitEv(events, { kind: 'flag_set', flag: 'ward_consumed', value: { scene, cardUid: uid } });
    return;
  }
  state.scenes[scene].crisisCards.push(uid);
  emitEv(events, { kind: 'crisis_flipped', cardUid: uid, cardDefId: def?.id ?? '', scene });
}

// ── P4① 危机卡轮末效果（§5.4【裁A-14】）───────────────────────────────────────

interface RoundEndItem {
  uid: string;
  defId: string;
  scene: SceneId;
}

function collectRoundEndItems(state: GameState): RoundEndItem[] {
  const withEffect = new Set(['crisis-02', 'crisis-03', 'crisis-04', 'crisis-05', 'crisis-09']);
  const out: RoundEndItem[] = [];
  for (const scene of Object.values(state.scenes)) {
    for (const uid of scene.crisisCards) {
      const defId = state.cards[uid]?.defId ?? '';
      if (withEffect.has(defId)) out.push({ uid, defId, scene: scene.id });
    }
  }
  return out;
}

/** P4① 入口：多张时玩家定序【裁A-14】（映射首位玩家定序） */
export function runCrisisRoundEnd(state: GameState, events: GameEvent[]): void {
  const items = collectRoundEndItems(state);
  if (items.length === 0) return;
  if (items.length === 1) {
    processQueue(state, events, items);
    return;
  }
  const decider = state.turnOrder.find((c) => state.characters[c]?.alive) ?? state.turnOrder[0]!;
  suspendDecision(state, events, {
    kind: 'order_effects',
    decider,
    options: { prompt: '多个危机卡轮末效果，决定结算顺序', items: items.map((i) => ({ uid: i.uid, defId: i.defId, scene: i.scene })) },
    resume: { sys: 'crisis', op: 'round_end_order', data: { items } },
  });
}

/** resume 'crisis:round_end_order' */
export function resumeRoundEndOrder(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const items = data['items'] as RoundEndItem[];
  const order = ((choice as Record<string, unknown>)?.['order'] as string[] | undefined) ?? items.map((i) => i.uid);
  const sorted = [...items].sort((a, b) => order.indexOf(a.uid) - order.indexOf(b.uid));
  processQueue(state, events, sorted);
}

/** resume 'crisis:continue_queue'（续算栈入口：内层决策完成后继续队列） */
export function continueQueue(state: GameState, events: GameEvent[], data: Record<string, unknown>): void {
  processQueue(state, events, (data['rest'] as RoundEndItem[]) ?? []);
}

function processQueue(state: GameState, events: GameEvent[], queue: RoundEndItem[]): void {
  const [head, ...rest] = queue;
  if (!head || state.result) return;
  applyRoundEndEffect(state, events, head, rest);
}

/** 单个危机卡轮末效果（rest 为后续队列，挂起时由续算栈携带） */
function applyRoundEndEffect(state: GameState, events: GameEvent[], item: RoundEndItem, rest: RoundEndItem[]): void {
  // 卡可能已被先前效果清除
  if (!state.scenes[item.scene].crisisCards.includes(item.uid)) {
    processQueue(state, events, rest);
    return;
  }
  const sceneChars = state.turnOrder.filter((c) => state.characters[c]?.alive && state.characters[c]?.scene === item.scene);
  const cont = rest.length > 0 ? { sys: 'crisis', op: 'continue_queue', data: { rest } } as const : undefined;

  switch (item.defId) {
    case 'crisis-02':
    case 'crisis-03': {
      // 所在场景一名角色受 1 点伤害（【暗】→ 小鱼 T2 侵蚀在 damage 终端处理）
      if (sceneChars.length === 0) {
        processQueue(state, events, rest);
        return;
      }
      if (sceneChars.length === 1) {
        hitOne(state, events, item, sceneChars[0]!, cont);
        if (!state.pendingDecision) processQueue(state, events, rest);
        return;
      }
      if (cont) state.resumeStack.push(cont);
      suspendDecision(state, events, {
        kind: 'choose_character',
        decider: sceneChars[0]!,
        options: { prompt: `「精灵亡魂」轮末：选择 ${item.scene} 一名角色承受 1 点伤害`, candidates: sceneChars },
        resume: { sys: 'crisis', op: 'round_end_hit', data: { item } },
      });
      return;
    }
    case 'crisis-04': {
      const x = state.characters['xiaoyu'];
      if (x?.alive && x.scene === item.scene) {
        // 小鱼在其场景 → 小鱼 E+1（T4）
        changeErosion(state, events, 1, 'T4');
      } else {
        for (const c of sceneChars) hitOne(state, events, item, c);
      }
      if (!state.pendingDecision) processQueue(state, events, rest);
      return;
    }
    case 'crisis-05':
      for (const c of sceneChars) hitOne(state, events, item, c);
      if (!state.pendingDecision) processQueue(state, events, rest);
      return;
    case 'crisis-09': {
      // 本卡献祭进度 +1【裁A-15 每张独立】
      const cur = (state.flags.sacrifice[item.uid] ?? 0) + 1;
      state.flags.sacrifice[item.uid] = Math.min(3, cur);
      emitEv(events, { kind: 'flag_set', flag: 'sacrifice', value: { uid: item.uid, progress: state.flags.sacrifice[item.uid] } });
      processQueue(state, events, rest);
      return;
    }
  }
}

/** resume 'crisis:round_end_hit'（危-02/03 目标选择） */
export function resumeRoundEndHit(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const item = data['item'] as RoundEndItem;
  const target = (choice as Record<string, unknown>)?.['character'] as CharacterId | undefined;
  if (!target) throw new EngineError('invalid_choice', '未选择承受角色');
  hitOne(state, events, item, target);
}

function hitOne(
  state: GameState,
  events: GameEvent[],
  item: RoundEndItem,
  target: CharacterId,
  then?: { sys: 'crisis'; op: 'continue_queue'; data: { rest: RoundEndItem[] } },
): void {
  dealDamageToCharacter(
    state,
    events,
    {
      target,
      damage: { base: 1, chain: [], source: `crisis:${item.defId}`, dark: item.defId === 'crisis-02' || item.defId === 'crisis-03' || item.defId === 'crisis-04', fromAttackCard: false },
      sourceCrisisUid: item.uid,
    },
    then,
  );
}

// ── 偏见翻牌（§5.3 / 凯-05【裁A-17】）──────────────────────────────────────────

/** 从危机牌库顶翻 1 张放置于指定场景（凯-05 也走此，占用同一场景本轮限额） */
export function flipPrejudiceCard(state: GameState, events: GameEvent[], scene: SceneId): string | null {
  const uid = drawCrisisTop(state, events);
  if (!uid) return null;
  placeCrisis(state, events, uid, scene);
  return uid;
}

export { shuffleInPlace, gainPurify, drawCards, isBerserk };

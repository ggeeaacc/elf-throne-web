/**
 * QA 回归套件共享摆盘工具（Task #4 后半段）。
 * 复用 engine/src/test-utils.ts（settle/passTurn/giveCard/putCrisis/fullHeal/trimCrises/playCardById），
 * 增补直达状态工厂（决战/失控/羁绊/清场/回合驱动）。
 * 引证规范见 docs/qa/test-plan.md §2。
 */
import { createInitialState } from '../../engine/src/state.js';
import { applyCommand, beginGame } from '../../engine/src/actions.js';
import {
  settle,
  passTurn,
  fullHeal,
  trimCrises,
  giveCard,
  playCardById,
  putCrisis,
} from '../../engine/src/test-utils.js';
import { enterFinalBattle } from '../../engine/src/systems/boss.js';
import { changeErosion } from '../../engine/src/systems/damage.js';
import { startTurn } from '../../engine/src/phases.js';
import type {
  CharacterId,
  GameConfig,
  GameEvent,
  GameState,
  PlayCardTargets,
  SceneId,
} from '../../engine/src/types.js';

export {
  settle,
  passTurn,
  fullHeal,
  trimCrises,
  giveCard,
  playCardById,
  putCrisis,
  applyCommand,
  createInitialState,
  startTurn,
};

export const cfg4: GameConfig = {
  playerCount: 4,
  seed: 42,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};
export const cfg3: GameConfig = {
  playerCount: 3,
  seed: 42,
  benchCharacter: 'baye',
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'] },
};
export const cfg3k: GameConfig = {
  playerCount: 3,
  seed: 42,
  benchCharacter: 'kaier',
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['baye'] },
};
export const cfg2: GameConfig = {
  playerCount: 2,
  seed: 42,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'] },
};
export const cfg1: GameConfig = {
  playerCount: 1,
  seed: 42,
  seatAssignments: { 0: ['xiaoyu', 'liya'] },
};

/** 开局并 settle（R1 P1 已翻牌，处于小鱼回合） */
export function freshGame(cfg: GameConfig = cfg4): GameState {
  return settle(beginGame(createInitialState(cfg)).state);
}

/** 确保角色手牌含指定 defId（已有则不动，否则从牌库/弃牌堆换入） */
export function ensureCard(s: GameState, character: CharacterId, defId: string): GameState {
  if (s.characters[character]!.hand.some((u) => s.cards[u]?.defId === defId)) return s;
  return giveCard(s, character, defId);
}

/** 摆盘：克隆并就地修改 */
export function mut(s: GameState, fn: (d: GameState) => void): GameState {
  const d = structuredClone(s);
  fn(d);
  return d;
}

/** 直达决战（BATTLE_PREP），prep 在进入前摆盘 */
export function toBattle(s: GameState, prep?: (d: GameState) => void): GameState {
  const d = structuredClone(s);
  prep?.(d);
  const events: GameEvent[] = [];
  enterFinalBattle(d, events);
  d.log.push(...events);
  return settle(d);
}

/** 设侵蚀（经 changeErosion 触发失控钩子/羁-02 替换/倒计时起点） */
export function setErosion(s: GameState, n: number): GameState {
  const d = structuredClone(s);
  const events: GameEvent[] = [];
  changeErosion(d, events, n, 'fixture');
  d.log.push(...events);
  return d;
}

/** 增减侵蚀（delta 带符号；经钩子，用于脱离失控等转换） */
export function bumpErosion(s: GameState, delta: number): GameState {
  return setErosion(s, delta);
}

/** 摆羁绊对（默认激活并持卡；自动从羁绊牌库移除该卡） */
export function setBond(
  s: GameState,
  a: CharacterId,
  b: CharacterId,
  defId: string,
  opts: { status?: 'active' | 'inactive'; replaced?: boolean } = {},
): GameState {
  return mut(s, (d) => {
    const order: CharacterId[] = ['xiaoyu', 'liya', 'kaier', 'baye'];
    const pair: [CharacterId, CharacterId] = order.indexOf(a) <= order.indexOf(b) ? [a, b] : [b, a];
    d.bonds = d.bonds.filter((x) => !(x.pair.includes(a) && x.pair.includes(b)));
    const cardUid = `${defId}#0`;
    d.decks.bond = d.decks.bond.filter((u) => u !== cardUid);
    d.bonds.push({
      pair,
      status: opts.status ?? 'active',
      cardUid: (opts.status ?? 'active') === 'inactive' ? null : cardUid,
      replacedByBerserk: opts.replaced ?? false,
      activeUsedRound: null,
    });
  });
}

/** 回答当前挂起决策 */
export function answer(s: GameState, choice: unknown): GameState {
  const d = s.pendingDecision;
  if (!d) throw new Error('无挂起决策');
  return applyCommand(s, { type: 'resolve_decision', decisionId: d.id, choice }).state;
}

/** 打出卡牌（不 settle，保留挂起决策；返回 ApplyResult）。consumables 对应指令顶层字段（§11 固定次序：净化→信物→小剑） */
export function playRaw(
  s: GameState,
  character: CharacterId,
  defId: string,
  targets?: PlayCardTargets,
  consumables?: { usePurify?: number; useCharm?: boolean; usePetAttack?: boolean; usePetDefend?: boolean },
) {
  const ch = s.characters[character]!;
  const uid = ch.hand.find((u) => s.cards[u]?.defId === defId);
  if (!uid) throw new Error(`${character} 手牌无 ${defId}（手牌：${ch.hand.map((u) => s.cards[u]?.defId).join(',')}）`);
  return applyCommand(s, {
    type: 'play_card',
    character,
    cardUid: uid,
    ...(targets ? { targets } : {}),
    ...(consumables?.usePurify ? { usePurify: consumables.usePurify } : {}),
    ...(consumables?.useCharm ? { useCharm: consumables.useCharm } : {}),
    ...(consumables?.usePetAttack ? { usePetAttack: consumables.usePetAttack } : {}),
    ...(consumables?.usePetDefend ? { usePetDefend: consumables.usePetDefend } : {}),
  });
}

/** 打出并处理羁-07 复制询问（默认不复制），返回终态 */
export function playPassCopy(s: GameState, character: CharacterId, defId: string, targets?: PlayCardTargets): GameState {
  let out = playRaw(s, character, defId, targets).state;
  if (out.pendingDecision?.kind === 'choose_option') out = answer(out, { option: 'pass' });
  return settle(out);
}

/** 清场：移除全部场景危机卡（长流程空转防 F2，摆盘不入事件流） */
export function clearCrises(s: GameState): GameState {
  const draft = structuredClone(s);
  for (const scene of Object.values(draft.scenes)) {
    for (const uid of scene.crisisCards) draft.decks.crisisDiscard.push(uid);
    scene.crisisCards = [];
    scene.crisisDamage = {};
  }
  draft.crisisDamageLog = {};
  return draft;
}

/** 摆盘续航：清场 + 全员满血 + 清失控倒计时 */
export function sustain(s: GameState): GameState {
  return fullHeal(clearCrises(s));
}

/** 空转一整轮（全部存活角色各结束一回合） */
export function passRound(s: GameState): GameState {
  const n = s.turnOrder.filter((c) => s.characters[c]?.alive).length;
  for (let i = 0; i < n && !s.result; i++) s = passTurn(s);
  return s;
}

/** 事件工具 */
export function evs<K extends GameEvent['kind']>(s: GameState, kind: K): Extract<GameEvent, { kind: K }>[] {
  return s.log.filter((e) => e.kind === kind) as Extract<GameEvent, { kind: K }>[];
}

/** 把指定 defId 的危机卡挪到危机牌库顶（控制下一次翻牌） */
export function topCrisis(s: GameState, defId: string): GameState {
  return mut(s, (d) => {
    const i = d.decks.crisis.findIndex((u) => d.cards[u]?.defId === defId);
    if (i < 0) throw new Error(`危机牌库无 ${defId}`);
    const [uid] = d.decks.crisis.splice(i, 1);
    d.decks.crisis.unshift(uid!);
  });
}

/** 给角色装备（从展示区取 uid 摆盘，不走锻造流程） */
export function giveEquipment(s: GameState, character: CharacterId, defId: string): GameState {
  return mut(s, (d) => {
    const i = d.equipmentDisplay.findIndex((u) => d.cards[u]?.defId === defId);
    if (i < 0) throw new Error(`展示区无 ${defId}`);
    const [uid] = d.equipmentDisplay.splice(i, 1);
    d.characters[character]!.equipment.push(uid!);
  });
}

/** 在场景放置 n 张指定 defId 危机卡 */
export function putCrisisN(s: GameState, defId: string, scene: SceneId, n: number): GameState {
  let out = s;
  for (let i = 0; i < n; i++) out = putCrisis(out, defId, scene);
  return out;
}

/** 场景危机卡 uid 列表（按 defId 过滤可选） */
export function crisisIn(s: GameState, scene: SceneId, defId?: string): string[] {
  const uids = s.scenes[scene].crisisCards;
  return defId ? uids.filter((u) => s.cards[u]?.defId === defId) : uids;
}

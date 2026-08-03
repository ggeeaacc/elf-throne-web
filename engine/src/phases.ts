/**
 * 相位状态机 v2（§2 全局状态机：ROUND_LOOP × 9 + BATTLE_LOOP）。
 *
 * P4 冻结管线【裁A-38】：① 危机卡轮末效果 → ② 手牌检查 → ③ 沦陷检查 F2 → ④ 推进时间。
 * 管线各阶段均可挂起决策；下一阶段以续算点（resumeStack / phase:* 续算器）串联。
 */
import { MODE_TABLE } from './content/modes.js';
import type {
  CharacterId,
  DaySegment,
  GameEvent,
  GameState,
  SceneId,
} from './types.js';
import { EngineError } from './types.js';
import { drawCards, emitEv, shuffleInPlace, suspendDecision } from './systems/common.js';
import { flipPrejudiceCard, runCrisisPhase, runCrisisRoundEnd } from './systems/crisis.js';
import { berserkAoE } from './systems/combat.js';
import { changeErosion, isBerserk } from './systems/damage.js';
import { receiveLetterIfAny } from './systems/letters.js';
import { enterFinalBattle, runBossAction } from './systems/boss.js';
import { drainResumeStack } from './systems/decisions.js';

const SEGMENTS: DaySegment[] = ['dawn', 'dusk', 'night'];

function enterPhase(state: GameState, events: GameEvent[], kind: GameState['phase']['kind']): void {
  state.phase.kind = kind;
  emitEv(events, {
    kind: 'phase_entered',
    phase: kind,
    day: state.phase.day,
    segment: state.phase.segment,
    round: state.phase.round,
  });
}

// ── 开局 ─────────────────────────────────────────────────────────────────────

export function beginGame(state: GameState): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  enterPhase(state, events, 'crisis');
  runCrisisPhase(state, events); // §5.1（通用卡可能挂起放置决策）
  if (state.pendingDecision) {
    state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'enter_action' } });
  } else {
    enterActionPhase(state, events);
  }
  state.log.push(...events);
  return { state, events };
}

function enterActionPhase(state: GameState, events: GameEvent[]): void {
  if (state.result) return;
  enterPhase(state, events, 'action');
  const first = state.turnOrder.find((c) => state.characters[c]?.alive);
  if (first) startTurn(state, events, first);
}

// ── 回合（§5.2 TURN_START / TURN_END）─────────────────────────────────────────

export function startTurn(state: GameState, events: GameEvent[], character: CharacterId): void {
  const ch = state.characters[character];
  if (!ch?.alive) return;
  state.turnPointer = state.turnOrder.indexOf(character);

  // 0. F4：小鱼失控倒计时 +1；第 3 次回合开始仍失控 → 判负【裁A-07】
  if (character === 'xiaoyu' && isBerserk(state)) {
    const n = (state.flags.berserkCountdown ?? 0) + 1;
    state.flags.berserkCountdown = n;
    if (n >= 3) {
      gameOver(state, events, 'defeat', '小鱼失控后第 3 次回合开始仍未脱离（F4）');
      return;
    }
  }

  state.currentTurn = { character };
  ch.freeMoveUsedThisTurn = false;

  // 1. 收信（获 AP 之前【L182】；失控→暂存）
  state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'grant_ap', character } });
  receiveLetterIfAny(state, events, character);
  if (!state.pendingDecision) {
    state.resumeStack.pop();
    grantAp(state, events, character);
  }
}

/** 回合 AP 授予（续算点 'grant_ap'） */
function grantAp(state: GameState, events: GameEvent[], character: CharacterId): void {
  const mode = MODE_TABLE[state.config.playerCount];
  const ch = state.characters[character];
  if (!ch?.alive) return;
  let ap = state.phase.kind === 'final_battle' ? 2 : mode.apPerTurn;
  // 中度侵蚀 -1（§6.4；决战 2→1【裁A-25】）
  if (character === 'xiaoyu' && ch.erosion === 3) ap -= 1;
  ap += ch.nextTurnApBonus;
  ch.nextTurnApBonus = 0;
  if (isBerserk(state) && character === 'xiaoyu') ap = 0; // 失控无法主动行动【L170】
  ch.ap = ap;
  if (ch.nextTurnDraw > 0) {
    drawCards(state, events, character, ch.nextTurnDraw);
    ch.nextTurnDraw = 0;
  }
  emitEv(events, { kind: 'turn_started', character, ap });
}

export function endTurn(state: GameState, events: GameEvent[], character: CharacterId): void {
  if (state.result) throw new EngineError('game_over', '对局已结束');
  if (state.phase.kind !== 'action' && state.phase.kind !== 'final_battle') {
    throw new EngineError('wrong_phase', '当前相位不能结束回合');
  }
  if (state.currentTurn?.character !== character) {
    throw new EngineError('not_your_turn', `当前不是 ${character} 的回合`);
  }
  const ch = state.characters[character];
  if (ch) ch.ap = 0;
  state.currentTurn = null;
  emitEv(events, { kind: 'turn_ended', character });

  // 失控小鱼回合结束：所在场景 AoE（§6.4；固定 1 点【裁A-12】）
  if (character === 'xiaoyu' && isBerserk(state)) {
    berserkAoE(state, events);
    if (state.result) return;
    if (state.pendingDecision) {
      state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'next_turn', character } });
      return;
    }
  }
  advanceToNextTurn(state, events, character);
}

function advanceToNextTurn(state: GameState, events: GameEvent[], from: CharacterId): void {
  const idx = state.turnOrder.indexOf(from);
  for (let i = idx + 1; i < state.turnOrder.length; i++) {
    const next = state.turnOrder[i]!;
    if (state.characters[next]?.alive) {
      startTurn(state, events, next);
      return;
    }
  }
  advanceAfterFullRound(state, events);
}

/**
 * 当前回合角色在回合中出局（如玫拉反击）→ 回合自动顺延【裁A-06 调度跳过】。
 * applyCommand 后置检查调用：无结果/无挂起决策/行动或决战相位/当前回合为空时，
 * 从 turnPointer 顺延至下一存活角色（或进入整轮收尾）。
 */
export function resumeTurnAfterElimination(state: GameState, events: GameEvent[]): void {
  if (state.result || state.pendingDecision || state.currentTurn) return;
  if (state.phase.kind !== 'action' && state.phase.kind !== 'final_battle') return;
  for (let i = state.turnPointer + 1; i < state.turnOrder.length; i++) {
    const next = state.turnOrder[i]!;
    if (state.characters[next]?.alive) {
      startTurn(state, events, next);
      return;
    }
  }
  advanceAfterFullRound(state, events);
}

// ── 整轮结束后的相位链 ──────────────────────────────────────────────────────────

function advanceAfterFullRound(state: GameState, events: GameEvent[]): void {
  if (state.result) return;

  if (state.phase.kind === 'final_battle') {
    // 决战 P4'：① 手牌检查 → ② 玫拉行动 → ③ 轮计数（§7.2）
    startHandCheck(state, events, 0, 'battle_after_hand_check');
    return;
  }

  // —— P3 偏见与羁绊（§5.3；1P/2P 整阶段跳过——不进入该相位【L256】）——
  const mode = MODE_TABLE[state.config.playerCount];
  if (mode.prejudice) {
    enterPhase(state, events, 'prejudice');
    const scenes = Object.keys(state.scenes) as SceneId[];
    runPrejudiceScenes(state, events, scenes);
    if (state.pendingDecision) {
      state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'p4_pipeline' } });
      return;
    }
  }
  runP4(state, events);
}

/** P3 场景扫描（每场景每轮 ≤1 张，含凯-05 占用【裁A-17】） */
function runPrejudiceScenes(state: GameState, events: GameEvent[], scenes: SceneId[]): void {
  const [scene, ...rest] = scenes;
  if (!scene || state.result) return;
  if (state.roundUsage[`prejudice:${scene}`]) {
    runPrejudiceScenes(state, events, rest);
    return;
  }
  const pairs = eligiblePrejudicePairs(state, scene);
  if (pairs.length === 0) {
    runPrejudiceScenes(state, events, rest);
    return;
  }
  if (pairs.length === 1) {
    flipForPrejudice(state, events, scene, pairs[0]!);
    runPrejudiceScenes(state, events, rest);
    return;
  }
  // 多对同在：玩家选定触发对【L142】（映射首位存活玩家）
  const decider = state.turnOrder.find((c) => state.characters[c]?.alive) ?? state.turnOrder[0]!;
  state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'prejudice_rest', scenes: rest } });
  suspendDecision(state, events, {
    kind: 'choose_option',
    decider,
    options: { prompt: `场景 ${scene} 多对人类×精灵组合，选定偏见触发对`, options: pairs.map((p) => ({ id: p.join('|'), label: p.join('×') })) },
    resume: { sys: 'phase', op: 'hand_check_next', data: { stage: 'prejudice_pair', scene } },
  });
}

function eligiblePrejudicePairs(state: GameState, scene: SceneId): Array<[CharacterId, CharacterId]> {
  const humans = (['xiaoyu', 'baye'] as CharacterId[]).filter((c) => state.characters[c]?.alive && state.characters[c]?.scene === scene);
  const elves = (['liya', 'kaier'] as CharacterId[]).filter((c) => state.characters[c]?.alive && state.characters[c]?.scene === scene);
  const out: Array<[CharacterId, CharacterId]> = [];
  for (const h of humans) {
    for (const e of elves) {
      if (h === 'xiaoyu' && e === 'liya') continue; // 小鱼×莉雅 永不触发【L153】
      const bonded = state.bonds.some((b) => b.status === 'active' && b.pair.includes(h) && b.pair.includes(e));
      if (bonded) continue; // 已结成不再触发【L145】
      out.push(h < e ? [h, e] : [e, h]);
    }
  }
  return out;
}

function flipForPrejudice(state: GameState, events: GameEvent[], scene: SceneId, pair: [CharacterId, CharacterId]): void {
  const uid = flipPrejudiceCard(state, events, scene);
  state.roundUsage[`prejudice:${scene}`] = true;
  if (uid) {
    // bondLead（跨轮有效【裁A-16】）：同 pair 旧关联失效重建
    state.bondLeads = state.bondLeads.filter((l) => !(l.pair[0] === pair[0] && l.pair[1] === pair[1]));
    state.bondLeads.push({ pair, crisisUid: uid });
    emitEv(events, { kind: 'prejudice_flipped', scene, cardUid: uid, pair });
  }
}

/** P4 冻结管线（§5.4【裁A-38】） */
function runP4(state: GameState, events: GameEvent[]): void {
  enterPhase(state, events, 'recovery');
  // ① 危机卡轮末效果
  runCrisisRoundEnd(state, events);
  if (state.pendingDecision) {
    state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'hand_check' } });
    return;
  }
  // ② 手牌检查
  startHandCheck(state, events, 0, 'p4_after_hand_check');
}

/** 手牌检查（②）：逐角色超出弃置（迷雾场景上限 -1【危-07】） */
function startHandCheck(state: GameState, events: GameEvent[], idx: number, nextStage: string): void {
  for (let i = idx; i < state.turnOrder.length; i++) {
    const cid = state.turnOrder[i]!;
    const ch = state.characters[cid];
    if (!ch?.alive) continue; // 出局无手牌检查【裁A-06】
    let limit = 5;
    if (state.scenes[ch.scene].crisisCards.some((u) => state.cards[u]?.defId === 'crisis-07')) limit -= 1;
    const excess = ch.hand.length - limit;
    if (excess > 0) {
      suspendDecision(state, events, {
        kind: 'choose_cards',
        decider: cid,
        options: { prompt: `手牌上限 ${limit}：弃置 ${excess} 张`, cardUids: [...ch.hand], min: excess, max: excess },
        resume: { sys: 'phase', op: 'hand_check_next', data: { stage: 'hand_check_discard', character: cid, excess, nextIdx: i + 1, nextStage } },
      });
      return;
    }
  }
  // 全部检查完毕 → 下一阶段（各阶段自含完整转换，无兜底重复调用）
  if (nextStage === 'p4_after_hand_check') {
    finishP4(state, events);
  } else if (nextStage === 'battle_after_hand_check') {
    // 决战 P4'：② 玫拉行动 → ③ 轮计数与下一轮（§7.2）
    runBossAction(state, events);
    if (state.result) return;
    if (state.pendingDecision) {
      state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'battle_round_inc' } });
      return;
    }
    battleRoundIncrement(state, events);
  }
}

/** 决战 ③：轮计数 +1，>9 → F1；否则开启下一轮 */
function battleRoundIncrement(state: GameState, events: GameEvent[]): void {
  const boss = state.boss;
  if (!boss || state.result) return;
  boss.round += 1;
  if (boss.round > 9) {
    gameOver(state, events, 'defeat', '玫拉完成黑暗仪式（决战超过九轮，F1）');
    return;
  }
  const first = state.turnOrder.find((c) => state.characters[c]?.alive);
  if (first) startTurn(state, events, first);
}

/** ③ 沦陷检查 + ④ 推进时间/决战切换 */
function finishP4(state: GameState, events: GameEvent[]): void {
  const mode = MODE_TABLE[state.config.playerCount];
  for (const scene of Object.values(state.scenes)) {
    if (scene.crisisCards.length >= mode.collapseThreshold) {
      gameOver(state, events, 'defeat', `场景「${scene.id}」危机达到 ${mode.collapseThreshold} 张，场景沦陷（F2）`);
      return;
    }
  }
  roundCleanup(state);
  if (state.phase.day === 3 && state.phase.segment === 'night') {
    enterFinalBattle(state, events);
    if (state.result) return;
    const first = state.turnOrder.find((c) => state.characters[c]?.alive);
    if (first) startTurn(state, events, first);
    return;
  }
  advanceTime(state);
  enterPhase(state, events, 'crisis');
  runCrisisPhase(state, events);
  if (state.pendingDecision) {
    state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'enter_action' } });
    return;
  }
  enterActionPhase(state, events);
}

/** 轮末清理（"本轮"持续至 P4 结束【裁A-05】） */
function roundCleanup(state: GameState): void {
  state.roundUsage = {};
  state.buffs = state.buffs.filter((b) => {
    if (b.scope === 'round' || b.scope === 'consumed') return false;
    if (b.scope === 'rounds') {
      b.roundsLeft = (b.roundsLeft ?? 1) - 1;
      return b.roundsLeft > 0;
    }
    return true; // permanent
  });
  for (const ch of Object.values(state.characters)) {
    ch.lettersSentThisRound = 0;
    ch.lettersReceivedThisRound = 0;
    ch.damagedThisRound = false;
    if (ch.airship && ch.airship.cooldownRounds > 0) ch.airship.cooldownRounds -= 1;
  }
  if (state.boss) state.boss.damageThisRound = {};
}

// ── 续算器（decisions.ts 路由 'phase:hand_check_next'）──────────────────────────

export function resumeP4AfterHandCheck(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const stage = data['stage'] as string;
  switch (stage) {
    case 'enter_action':
      enterActionPhase(state, events);
      return;
    case 'grant_ap':
      grantAp(state, events, data['character'] as CharacterId);
      return;
    case 'next_turn':
      advanceToNextTurn(state, events, data['character'] as CharacterId);
      return;
    case 'p4_pipeline':
      runP4(state, events);
      return;
    case 'hand_check':
      startHandCheck(state, events, 0, 'p4_after_hand_check');
      return;
    case 'battle_round_inc':
      battleRoundIncrement(state, events);
      return;
    case 'hand_check_discard': {
      const cid = data['character'] as CharacterId;
      const excess = data['excess'] as number;
      const uids = ((choice as Record<string, unknown>)?.['cardUids'] as string[] | undefined) ?? [];
      const ch = state.characters[cid]!;
      if (uids.length !== excess || uids.some((u) => !ch.hand.includes(u))) {
        throw new EngineError('invalid_choice', `须从手牌弃置 ${excess} 张`);
      }
      for (const u of uids) {
        ch.hand.splice(ch.hand.indexOf(u), 1);
        ch.discard.push(u);
      }
      startHandCheck(state, events, data['nextIdx'] as number, data['nextStage'] as string);
      return;
    }
    case 'prejudice_pair': {
      const scene = data['scene'] as SceneId;
      const opt = (choice as Record<string, unknown>)?.['option'] as string | undefined;
      const pair = (opt?.split('|') ?? []) as CharacterId[];
      if (pair.length !== 2) throw new EngineError('invalid_choice', '须选定触发对');
      flipForPrejudice(state, events, scene, [pair[0]!, pair[1]!]);
      return;
    }
    case 'prejudice_rest':
      runPrejudiceScenes(state, events, data['scenes'] as SceneId[]);
      if (!state.pendingDecision) runP4(state, events);
      else state.resumeStack.push({ sys: 'phase', op: 'hand_check_next', data: { stage: 'p4_pipeline' } });
      return;
    default:
      throw new EngineError('invalid_command', `未知相位续算阶段 ${stage}`);
  }
}

// ── 时间轴 ────────────────────────────────────────────────────────────────────

function advanceTime(state: GameState): void {
  const segIdx = SEGMENTS.indexOf(state.phase.segment);
  state.phase.round += 1;
  if (segIdx < SEGMENTS.length - 1) {
    state.phase.segment = SEGMENTS[segIdx + 1] as DaySegment;
  } else {
    state.phase.segment = 'dawn';
    if (state.phase.day < 3) state.phase.day = (state.phase.day + 1) as 1 | 2 | 3;
  }
}

function gameOver(state: GameState, events: GameEvent[], outcome: 'victory' | 'defeat', reason: string): void {
  state.result = { outcome, reason };
  state.phase.kind = 'game_over';
  state.currentTurn = null;
  emitEv(events, { kind: 'game_over', result: outcome, reason });
}

export { runBossAction, drainResumeStack, changeErosion, shuffleInPlace };

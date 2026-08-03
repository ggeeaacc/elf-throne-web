/**
 * 决策续算注册表（ADR-003 中断式决策的另一半）。
 *
 * resolve_decision 指令 → 按 resume.sys/op 路由到对应系统的续算器；
 * 完成后逐个弹出 resumeStack 中的外层续算点，直至再次挂起或耗尽。
 */
import type { GameEvent, GameState, ResumeRef } from '../types.js';
import { EngineError } from '../types.js';
import { resumeDamageApply } from './damage.js';
import { resumeFlipNext, resumeRoundEndOrder, resumeRoundEndHit, continueQueue } from './crisis.js';
import { resumeReceive, resumeReverseReceive, resumeHealChoice, resumeVowSend, resumeFaceSwap, resumeFaceSwapDiscard } from './letters.js';
import { resumeBondForm, resumeFreeForge, resumeFreeForgeSecond, resumeCopyOption, resumeCopyDiscard } from './bonds.js';
import { resumeCounterDiscard } from './boss.js';
import { resumeYa03Reorder, resumeBa02Pick } from './cards.js';
import { resumeEquipSwap } from './forge.js';
import { resumeP4AfterHandCheck } from '../phases.js';
import { takeEquipment } from './forge.js';
import { dealDamageToCrisis } from './combat.js';
import type { CharacterId } from '../types.js';

type Resumer = (state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown) => void;

const RESUMERS: Record<string, Record<string, Resumer>> = {
  damage: { apply: resumeDamageApply },
  crisis: {
    flip_next: resumeFlipNext,
    round_end_order: resumeRoundEndOrder,
    round_end_hit: resumeRoundEndHit,
    continue_queue: (s, e, d) => continueQueue(s, e, d),
    free_equipment: (s, e, _d, choice) => {
      // 危-06 免费装备归属【裁A-40】
      const c = choice as Record<string, unknown>;
      const uid = c['equipmentUid'] as string;
      const owner = c['owner'] as CharacterId;
      if (!uid || !owner || !s.characters[owner]?.alive) throw new EngineError('invalid_choice', '装备归属非法');
      takeEquipment(s, e, owner, uid);
    },
  },
  letter: {
    receive: resumeReceive,
    reverse_receive: resumeReverseReceive,
    heal_choice: resumeHealChoice,
    vow_send: resumeVowSend,
    face_swap: resumeFaceSwap,
    face_swap_discard: resumeFaceSwapDiscard,
  },
  bond: {
    form: resumeBondForm,
    free_forge: resumeFreeForge,
    free_forge_second: (s, e, d) => resumeFreeForgeSecond(s, e, d),
    copy_option: resumeCopyOption,
    copy_discard: resumeCopyDiscard,
  },
  boss: {
    counter_discard: resumeCounterDiscard,
  },
  card: {
    ya03_reorder: resumeYa03Reorder,
    ba02_pick: resumeBa02Pick,
    equip_swap: resumeEquipSwap,
    bond09_shot: (s, e, d, choice) => {
      // 羁-09 免费远程攻击（2 点，可选跳过）
      const uid = (choice as Record<string, unknown>)?.['cardUid'] as string | undefined;
      if (!uid) return;
      dealDamageToCrisis(s, e, uid, 2, (d['by'] as CharacterId) ?? 'liya');
    },
    scout: (s, e, d, choice) => {
      // 古战场侦查：顶 2 选 1 置底
      const top2 = d['top2'] as string[];
      const bottom = (choice as Record<string, unknown>)?.['bottom'] as string | undefined;
      if (!bottom || !top2.includes(bottom)) throw new EngineError('invalid_choice', '须选择置底的一张');
      const top = top2.find((u) => u !== bottom)!;
      const rest = s.decks.crisis.slice(top2.length);
      s.decks.crisis = [top, ...rest, bottom];
      void e;
    },
  },
  phase: {
    hand_check_next: (s, e, d, c) => resumeP4AfterHandCheck(s, e, d, c),
  },
};

/** resolve_decision 指令入口（actions.ts 调用） */
export function resolveDecision(state: GameState, events: GameEvent[], decisionId: string, choice: unknown): void {
  const d = state.pendingDecision;
  if (!d) throw new EngineError('no_such_decision', '当前无待决策事项');
  if (d.id !== decisionId) throw new EngineError('no_such_decision', `决策 id 不符（当前 ${d.id}）`);
  state.pendingDecision = null;
  const resumer = RESUMERS[d.resume.sys]?.[d.resume.op];
  if (!resumer) throw new EngineError('invalid_command', `续算器缺失 ${d.resume.sys}:${d.resume.op}`);
  resumer(state, events, (d.resume.data ?? {}) as Record<string, unknown>, choice);
  drainResumeStack(state, events);
}

/** 弹出外层续算点直至再次挂起（回合开始收信等特殊续算点也在此串联） */
export function drainResumeStack(state: GameState, events: GameEvent[]): void {
  let guard = 0;
  while (!state.pendingDecision && !state.result && state.resumeStack.length > 0 && guard++ < 64) {
    const ref = state.resumeStack.pop()!;
    runResumeRef(state, events, ref, null);
  }
}

/** 直接执行一个续算点（phases.ts 内部也复用） */
export function runResumeRef(state: GameState, events: GameEvent[], ref: ResumeRef, choice: unknown): void {
  const resumer = RESUMERS[ref.sys]?.[ref.op];
  if (!resumer) throw new EngineError('invalid_command', `续算器缺失 ${ref.sys}:${ref.op}`);
  resumer(state, events, (ref.data ?? {}) as Record<string, unknown>, choice);
}

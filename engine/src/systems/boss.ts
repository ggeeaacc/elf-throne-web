/**
 * 最终决战系统（§7：BATTLE_PREP / BATTLE_LOOP / 首领三阶段 / 黑暗宝玉）。
 */
import { MODE_TABLE } from '../content/modes.js';
import type { CharacterId, GameEvent, GameState } from '../types.js';
import { EngineError } from '../types.js';
import { drawCards, emitEv, suspendDecision } from './common.js';
import { addBuff, dealDamageToCharacter, gainPurify, healCharacter, isBerserk } from './damage.js';
import { drawCrisisTop } from './common.js';

// ── BATTLE_PREP（§7.1）────────────────────────────────────────────────────────

export function enterFinalBattle(state: GameState, events: GameEvent[]): void {
  const mode = MODE_TABLE[state.config.playerCount];
  // 2. 弃置所有场景残留危机卡
  for (const scene of Object.values(state.scenes)) {
    state.decks.crisisDiscard.push(...scene.crisisCards);
    scene.crisisCards = [];
    scene.crisisDamage = {};
  }
  state.crisisDamageLog = {};
  // 3. 存活角色强制召唤至黑暗山谷（出局不复活【裁A-06】）
  for (const ch of Object.values(state.characters)) {
    if (ch.alive) ch.scene = 'dark_valley';
  }
  // 4. 玫拉初始生命 + 备战加成
  let bossHp = mode.bossHp;
  if (!state.flags.avatarCleared) bossHp += 2; // 危-10 未清除 +2【L428】
  for (const progress of Object.values(state.flags.sacrifice)) {
    if (progress >= 3) bossHp += 3; // 每张通牒独立达 3 各 +3（最多 +6【裁A-15】）
  }
  // 5. 护盾/跳阶段
  const shieldMax = state.flags.queenRescued ? 0 : mode.shieldLayers * mode.shieldHpPerLayer;
  const stage = state.flags.queenRescued ? 2 : 1;
  state.boss = {
    hp: bossHp,
    maxHp: bossHp,
    shield: shieldMax,
    shieldMax,
    stage,
    round: 1,
    gemPurify: 0,
    damageThisRound: {},
  };
  state.phase.kind = 'final_battle';
  emitEv(events, { kind: 'phase_entered', phase: 'final_battle', day: 3, segment: 'night', round: state.phase.round });
  emitEv(events, { kind: 'final_battle_started', bossHp, shield: shieldMax, stage });
  if (state.flags.queenRescued) {
    for (const c of state.turnOrder) healCharacter(state, events, c, 2); // 跳过 P1 结算转换效果【L271】
  }
  // 6. 决战补给（2P/1P 各抽 2【L267】）
  if (mode.finalSupply > 0) {
    for (const c of state.turnOrder) {
      if (state.characters[c]?.alive) drawCards(state, events, c, mode.finalSupply);
    }
  }
}

// ── 决战可用行动（§7.2）────────────────────────────────────────────────────────

/** 治疗（1 AP：弃 1 手牌，自己或同场景一名角色回 2） */
export function battleHeal(state: GameState, events: GameEvent[], character: CharacterId, discardUid: string, target: CharacterId): void {
  const ch = state.characters[character]!;
  if (ch.ap < 1) throw new EngineError('insufficient_ap', '行动点不足');
  const idx = ch.hand.indexOf(discardUid);
  if (idx < 0) throw new EngineError('card_not_in_hand', '弃置卡不在手牌');
  const t = state.characters[target];
  if (!t?.alive || t.scene !== ch.scene) throw new EngineError('invalid_target', '目标须为自己或同场景角色');
  ch.hand.splice(idx, 1);
  ch.discard.push(discardUid);
  ch.ap -= 1;
  healCharacter(state, events, target, 2);
}

/** 援护（1 AP：本轮该同伴下一次伤害由你代受） */
export function battleGuard(state: GameState, events: GameEvent[], character: CharacterId, target: CharacterId): void {
  const ch = state.characters[character]!;
  if (ch.ap < 1) throw new EngineError('insufficient_ap', '行动点不足');
  const t = state.characters[target];
  if (!t?.alive || target === character) throw new EngineError('invalid_target', '须选择一名同伴');
  ch.ap -= 1;
  addBuff(state, { source: 'guard', kind: 'guard', value: 0, target, partner: character, scope: 'round' });
}

/** 净化蓄能（1 AP：自己 +1 净化，上限 3） */
export function purifyCharge(state: GameState, events: GameEvent[], character: CharacterId): void {
  const ch = state.characters[character]!;
  if (ch.ap < 1) throw new EngineError('insufficient_ap', '行动点不足');
  ch.ap -= 1;
  gainPurify(state, events, character, 1);
}

/** 宝玉共鸣（§7.4：莉雅 1 AP，小鱼×莉雅已激活羁绊；≤3） */
export function gemAttune(state: GameState, events: GameEvent[], character: CharacterId): void {
  if (character !== 'liya') throw new EngineError('invalid_command', '仅莉雅可净化宝玉');
  const boss = state.boss;
  if (!boss) throw new EngineError('wrong_phase', '不在决战中');
  const ch = state.characters[character]!;
  if (ch.ap < 1) throw new EngineError('insufficient_ap', '行动点不足');
  const bonded = state.bonds.some(
    (b) => b.status === 'active' && b.cardUid && b.pair.includes('xiaoyu') && b.pair.includes('liya'),
  );
  if (!bonded) throw new EngineError('condition_not_met', '小鱼与莉雅须已激活羁绊');
  if (boss.gemPurify >= 3) throw new EngineError('usage_limit', '宝玉共鸣最多 3 个净化指示物');
  ch.ap -= 1;
  boss.gemPurify += 1;
  emitEv(events, { kind: 'flag_set', flag: 'gemPurify', value: boss.gemPurify });
}

// ── P4'② 玫拉行动（§7.3，宝玉共鸣减免轮末效果【裁A-36】）────────────────────────

export function runBossAction(state: GameState, events: GameEvent[]): void {
  const boss = state.boss;
  if (!boss || state.result) return;
  const aliveChars = state.turnOrder.filter((c) => state.characters[c]?.alive);
  if (aliveChars.length === 0) return;
  const gem = boss.gemPurify;

  switch (boss.stage) {
    case 1: {
      // 暗影箭：对所有并列生命最低的角色各 1 点【A-46】（未标注黑暗【裁A-35】；共鸣可减）
      const minHp = Math.min(...aliveChars.map((c) => state.characters[c]!.hp));
      const targets = aliveChars.filter((c) => state.characters[c]!.hp === minHp);
      for (const target of targets) {
        emitEv(events, { kind: 'boss_action', action: 'shadow_arrow', detail: target });
        dealDamageToCharacter(state, events, {
          target,
          damage: { base: Math.max(0, 1 - gem), chain: [], source: 'boss_p1', dark: false, fromAttackCard: false },
        });
        if (state.result) return;
      }
      break;
    }
    case 2: {
      // 宝玉之力：本轮伤害最高者 2 点；并列各 1 点（统计窗口=本轮【裁A-35】；未标注黑暗）
      const dmg = boss.damageThisRound;
      const entries = aliveChars.map((c) => [c, dmg[c] ?? 0] as const).filter(([, v]) => v > 0);
      if (entries.length > 0) {
        const max = Math.max(...entries.map(([, v]) => v));
        const tops = entries.filter(([, v]) => v === max).map(([c]) => c);
        const each = tops.length > 1 ? 1 : 2;
        for (const t of tops) {
          emitEv(events, { kind: 'boss_action', action: 'gem_power', detail: t });
          dealDamageToCharacter(state, events, {
            target: t,
            damage: { base: Math.max(0, each - gem), chain: [], source: 'boss_p2', dark: false, fromAttackCard: false },
          });
        }
      }
      boss.damageThisRound = {};
      break;
    }
    case 3: {
      // 宝玉暴走：对所有角色 2 点黑暗伤害（宝玉侵蚀已失效【L226】），然后回 1（不超上限【裁A-34】）
      for (const c of aliveChars) {
        dealDamageToCharacter(state, events, {
          target: c,
          damage: { base: Math.max(0, 2 - gem), chain: [], source: 'boss_p3', dark: true, fromAttackCard: false },
        });
        if (state.result) return;
      }
      boss.hp = Math.min(boss.maxHp, boss.hp + 1);
      emitEv(events, { kind: 'boss_action', action: 'rampage', detail: 'AoE2+回血1' });
      break;
    }
  }
}

/** P2 反击后的精灵弃牌（resume 'boss:counter_discard'） */
export function resumeCounterDiscard(state: GameState, events: GameEvent[], data: Record<string, unknown>, choice: unknown): void {
  const character = data['character'] as CharacterId;
  const uid = ((choice as Record<string, unknown>)?.['cardUids'] as string[] | undefined)?.[0];
  const ch = state.characters[character]!;
  if (!uid || !ch.hand.includes(uid)) throw new EngineError('invalid_choice', '弃牌选择非法');
  ch.hand.splice(ch.hand.indexOf(uid), 1);
  ch.discard.push(uid);
  emitEv(events, { kind: 'flag_set', flag: 'counter_discarded', value: { character, cardUid: uid } });
}

export { drawCrisisTop, isBerserk };

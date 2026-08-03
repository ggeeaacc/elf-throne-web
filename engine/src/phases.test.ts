import { describe, expect, it } from 'vitest';
import { applyCommand, beginGame } from './actions.js';
import { createInitialState } from './state.js';
import { fullHeal, passTurn, settle, trimCrises } from './test-utils.js';
import type { GameConfig, GameState } from './types.js';

const cfg4: GameConfig = {
  playerCount: 4,
  seed: 42,
  seatAssignments: { 0: ['xiaoyu'], 1: ['liya'], 2: ['kaier'], 3: ['baye'] },
};

function freshGame(): GameState {
  return settle(beginGame(createInitialState(cfg4)).state);
}

describe('相位状态机（§2 全局状态机）', () => {
  it('开局进入小鱼行动回合，3 AP（§5.2）', () => {
    const s = freshGame();
    expect(s.phase.kind).toBe('action');
    expect(s.currentTurn?.character).toBe('xiaoyu');
    expect(s.characters['xiaoyu']?.ap).toBe(3);
  });

  it('回合轮转按固定顺序（小鱼→莉雅→凯尔→巴爷）', () => {
    let s = freshGame();
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      order.push(s.currentTurn?.character ?? '');
      s = passTurn(s);
    }
    expect(order).toEqual(['xiaoyu', 'liya', 'kaier', 'baye']);
    expect(s.currentTurn?.character).toBe('xiaoyu');
    expect(s.phase.round).toBe(2);
    expect(s.phase.segment).toBe('dusk');
  });

  it('相位链完整经过 危机→行动→偏见→休整（§2.1）', () => {
    let s = freshGame();
    for (let i = 0; i < 4; i++) s = passTurn(s);
    const kinds = s.log.filter((e) => e.kind === 'phase_entered').map((e) => (e as { phase: string }).phase);
    expect(kinds).toEqual(['crisis', 'action', 'prejudice', 'recovery', 'crisis', 'action']);
  });

  it('九轮空转后进入最终决战：集结黑暗山谷、护盾 9、阶段 1（§7.1）', () => {
    let s = freshGame();
    for (let r = 0; r < 9 && s.phase.kind !== 'final_battle'; r++) {
      for (let i = 0; i < 4; i++) s = passTurn(s);
      s = trimCrises(fullHeal(s)); // 摆盘：防空转减员与沦陷（直达决战）
    }
    expect(s.phase.kind).toBe('final_battle');
    for (const ch of Object.values(s.characters)) {
      expect(ch.scene).toBe('dark_valley'); // §7.1：强制召唤至黑暗山谷
    }
    expect(s.boss).toMatchObject({ shield: 12, shieldMax: 12, stage: 1, round: 1 });
    expect(s.boss!.hp).toBe(s.boss!.maxHp);
    // 备战加成：危-10 未清除 +2【L428】（空转无人清除）
    expect(s.boss!.maxHp).toBeGreaterThanOrEqual(26);
    expect(s.currentTurn?.character).toBe('xiaoyu');
    expect(s.characters['xiaoyu']?.ap).toBe(2); // §7.2：决战每人 2 AP
  });

  it('决战九轮后仪式完成判负（F1，§7.1）', () => {
    let s = freshGame();
    for (let r = 0; r < 9 && s.phase.kind !== 'final_battle'; r++) {
      for (let i = 0; i < 4; i++) s = passTurn(s);
      s = trimCrises(fullHeal(s));
    }
    for (let r = 0; r < 9 && !s.result; r++) {
      for (let i = 0; i < 4 && !s.result; i++) s = passTurn(s);
      s = trimCrises(fullHeal(s));
    }
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('黑暗仪式');
  });

  it('终局后指令一律拒绝', () => {
    let s = freshGame();
    for (let r = 0; r < 9 && s.phase.kind !== 'final_battle'; r++) {
      for (let i = 0; i < 4; i++) s = passTurn(s);
      s = trimCrises(fullHeal(s));
    }
    for (let r = 0; r < 9 && !s.result; r++) {
      for (let i = 0; i < 4 && !s.result; i++) s = passTurn(s);
      s = trimCrises(fullHeal(s));
    }
    expect(s.result).not.toBeNull();
    expect(() => applyCommand(s, { type: 'end_turn', character: 'xiaoyu' })).toThrow(/已结束/);
  });

  it('确定性：同种子同指令流逐字节同终态（回放性质，ADR-003）', () => {
    const run = () => {
      let s = freshGame();
      for (let i = 0; i < 12; i++) s = passTurn(s);
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });
});

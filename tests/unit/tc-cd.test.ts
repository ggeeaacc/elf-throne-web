/**
 * TC-CD 角色专属卡（40 张 + 飞空艇）回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import { dealDamageToCharacter } from '../../engine/src/systems/damage.js';
import {
  answer,
  clearCrises,
  crisisIn,
  ensureCard,
  evs,
  freshGame,
  giveEquipment,
  mut,
  passRound,
  passTurn,
  playCardById,
  playPassCopy,
  playRaw,
  putCrisis,
  setBond,
  setErosion,
  settle,
  toBattle,
  topCrisis,
} from '../helpers/regression-utils.js';
import type { CharacterId, GameEvent, GameState, SceneId } from '../../engine/src/types.js';

function giveTurn(s: GameState, c: CharacterId, ap = 3): GameState {
  return mut(s, (d) => {
    d.currentTurn = { character: c };
    d.characters[c]!.ap = ap;
  });
}

function uidOf(s: GameState, defId: string, scene: SceneId): string {
  return crisisIn(s, scene, defId)[0]!;
}

function dmgOf(r: { events: GameEvent[] }): number | undefined {
  const e = r.events.find((x) => x.kind === 'crisis_damaged') as { amount: number } | undefined;
  return e?.amount;
}

/** 直接对角色造成伤害（摆盘） */
function hit(s: GameState, target: CharacterId, base: number, opts?: { dark?: boolean; source?: string }): GameState {
  const d = structuredClone(s);
  const events: GameEvent[] = [];
  dealDamageToCharacter(d, events, {
    target,
    damage: { base, chain: [], source: opts?.source ?? 'fixture', dark: opts?.dark ?? false, fromAttackCard: false },
  });
  d.log.push(...events);
  return d;
}

describe('TC-CD 角色专属卡', () => {
  // ── 小鱼 ──
  it('TC-CD-001 鱼-01 横斩：当前场景 1 危机卡 3 点【§9.1】【§1.2】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    expect(dmgOf(playRaw(s, 'xiaoyu', 'yu-01', { crisisUids: [uidOf(s, 'crisis-10', 'human_city')] }))).toBe(3);
  });

  it('TC-CD-002 鱼-02 铁匠锻造：获 2 材料（上限 4 溢出丢失）【§9.1】【§1.4】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.materialTokens = 3;
    });
    s = ensureCard(s, 'xiaoyu', 'yu-02');
    s = playCardById(s, 'xiaoyu', 'yu-02');
    expect(s.characters['xiaoyu']?.materialTokens).toBe(4);
  });

  it('TC-CD-003 鱼-03 纵斩突进：移至相邻 + 该场景 2+巴爷1=3；决战仅结算伤害【§9.1】【§1.2】【L200】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'ancient_battlefield');
    s = ensureCard(s, 'xiaoyu', 'yu-03');
    s = mut(s, (d) => {
      d.characters['baye']!.scene = 'ancient_battlefield';
    });
    const r = playRaw(s, 'xiaoyu', 'yu-03', { scene: 'ancient_battlefield', crisisUids: [uidOf(s, 'crisis-10', 'ancient_battlefield')] });
    expect(r.state.characters['xiaoyu']?.scene).toBe('ancient_battlefield');
    expect(dmgOf(r)).toBe(3); // 2+巴爷1（无屠龙者 vs 危机卡）
    // 决战：仅结算伤害、不触发移动
    let b = toBattle(freshGame());
    b = giveTurn(b, 'xiaoyu', 2);
    b = ensureCard(b, 'xiaoyu', 'yu-03');
    const shield0 = b.boss!.shield;
    b = playPassCopy(b, 'xiaoyu', 'yu-03', { scene: 'human_city' });
    expect(b.boss?.shield).toBe(shield0 - 3); // 2+屠龙者1
    expect(b.characters['xiaoyu']?.scene).toBe('dark_valley'); // 未移动
  });

  it('TC-CD-004 鱼-04 守护之姿：本轮所在场景友方（含自己）受伤 -2（钳 0）；跨轮失效【§9.1】【裁A-05】', () => {
    let s = freshGame();
    s = ensureCard(s, 'xiaoyu', 'yu-04');
    s = playPassCopy(s, 'xiaoyu', 'yu-04');
    expect(s.buffs.some((b) => b.source === 'yu-04' && b.kind === 'damage_reduce' && b.value === 2)).toBe(true);
    s = passRound(s);
    expect(s.buffs.some((b) => b.source === 'yu-04')).toBe(false);
  });

  it('TC-CD-005 鱼-05 十字剑气：4 点 + 自放 1 侵蚀（T3）【§9.1】【§6.4】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-05');
    const r = playRaw(s, 'xiaoyu', 'yu-05', { crisisUids: [uidOf(s, 'crisis-10', 'human_city')] });
    expect(dmgOf(r)).toBe(4); // 4（无屠龙者 vs 危机卡）
    expect(r.state.characters['xiaoyu']?.erosion).toBe(1);
  });

  it('TC-CD-006 鱼-06 意志抵抗：移除 ≤2 侵蚀；无侵蚀改回 2【§9.1】', () => {
    let a = freshGame();
    a = mut(a, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
    });
    a = ensureCard(a, 'xiaoyu', 'yu-06');
    a = playCardById(a, 'xiaoyu', 'yu-06');
    expect(a.characters['xiaoyu']?.erosion).toBe(1);
    let b = freshGame();
    b = mut(b, (d) => {
      d.characters['xiaoyu']!.hp = 3;
    });
    b = ensureCard(b, 'xiaoyu', 'yu-06');
    b = playCardById(b, 'xiaoyu', 'yu-06');
    expect(b.characters['xiaoyu']?.hp).toBe(5);
  });

  it('TC-CD-007 鱼-07 像鸟一样飞：移至莉雅场景 + 双方各抽 1【§9.1】', () => {
    let s = freshGame();
    s = ensureCard(s, 'xiaoyu', 'yu-07');
    const xh0 = s.characters['xiaoyu']!.hand.length;
    const lh0 = s.characters['liya']!.hand.length;
    s = playCardById(s, 'xiaoyu', 'yu-07');
    expect(s.characters['xiaoyu']?.scene).toBe('elf_kingdom');
    expect(s.characters['xiaoyu']?.hand.length).toBe(xh0); // -1 打出 +1 抽
    expect(s.characters['liya']?.hand.length).toBe(lh0 + 1);
  });

  it('TC-CD-008 鱼-08 多节变形弓：当前或相邻至多 2 目标各 1 点；非相邻拒绝【§9.1】【裁A-20】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'human_city');
    s = putCrisis(s, 'crisis-01', 'dark_valley');
    s = ensureCard(s, 'xiaoyu', 'yu-08');
    const r = playRaw(s, 'xiaoyu', 'yu-08', { crisisUids: [uidOf(s, 'crisis-01', 'human_city'), uidOf(s, 'crisis-01', 'dark_valley')] });
    const dmgs = r.events.filter((e) => e.kind === 'crisis_damaged').map((e) => (e as { amount: number }).amount);
    expect(dmgs).toEqual([1, 1]); // 1 各目标（无屠龙者 vs 危机卡）
    let s2 = putCrisis(freshGame(), 'crisis-01', 'elf_kingdom');
    s2 = ensureCard(s2, 'xiaoyu', 'yu-08');
    expect(() => playRaw(s2, 'xiaoyu', 'yu-08', { crisisUids: [uidOf(s2, 'crisis-01', 'elf_kingdom')] })).toThrow(/当前或相邻/);
  });

  it('TC-CD-009 鱼-09 并肩而立：条件同场景；双方各回 2 + 小鱼 -1 侵蚀【§9.1】', () => {
    let a = freshGame();
    a = ensureCard(a, 'xiaoyu', 'yu-09');
    expect(() => playRaw(a, 'xiaoyu', 'yu-09')).toThrow(/同场景/); // 莉雅在精灵王国
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['liya']!.scene = 'human_city';
      d.characters['liya']!.hp = 2;
      d.characters['xiaoyu']!.hp = 3;
      d.characters['xiaoyu']!.erosion = 2;
    });
    s = ensureCard(s, 'xiaoyu', 'yu-09');
    s = playCardById(s, 'xiaoyu', 'yu-09');
    expect(s.characters['xiaoyu']?.hp).toBe(5);
    expect(s.characters['liya']?.hp).toBe(4);
    expect(s.characters['xiaoyu']?.erosion).toBe(1);
  });

  it('TC-CD-010 鱼-10 为爱而战：X=侵蚀+1；莉雅本轮已受伤 +2（窗口=本轮）【§9.1】【裁A-41】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'human_city');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
      d.characters['liya']!.damagedThisRound = true;
    });
    s = ensureCard(s, 'xiaoyu', 'yu-10');
    const r = playRaw(s, 'xiaoyu', 'yu-10', { crisisUids: [uidOf(s, 'crisis-10', 'human_city')] });
    expect(dmgOf(r)).toBe(6); // (3+1+2)（无屠龙者 vs 危机卡）
    let b = putCrisis(freshGame(), 'crisis-10', 'human_city');
    b = mut(b, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
    });
    b = ensureCard(b, 'xiaoyu', 'yu-10');
    const r2 = playRaw(b, 'xiaoyu', 'yu-10', { crisisUids: [uidOf(b, 'crisis-10', 'human_city')] });
    expect(dmgOf(r2)).toBe(4); // (3+1)（无屠龙者 vs 危机卡）
  });

  // ── 莉雅 ──
  it('TC-CD-011 雅-01 精灵箭：清除则收回手牌；未清除入弃牌堆【§9.2】', () => {
    let a = putCrisis(clearCrises(freshGame()), 'crisis-01', 'ancient_battlefield');
    a = giveTurn(a, 'liya');
    a = ensureCard(a, 'liya', 'ya-01');
    a = playPassCopy(a, 'liya', 'ya-01', { crisisUids: [uidOf(a, 'crisis-01', 'ancient_battlefield')] }); // 3+神射1=4 ≥ 4 清除
    expect(a.characters['liya']?.hand.some((u) => a.cards[u]?.defId === 'ya-01')).toBe(true);
    expect(a.characters['liya']?.discard.some((u) => a.cards[u]?.defId === 'ya-01')).toBe(false);
    let b = putCrisis(clearCrises(freshGame()), 'crisis-10', 'elf_kingdom');
    b = giveTurn(b, 'liya');
    b = ensureCard(b, 'liya', 'ya-01');
    b = playPassCopy(b, 'liya', 'ya-01', { crisisUids: [uidOf(b, 'crisis-10', 'elf_kingdom')] }); // 3 < 6 未清除
    expect(b.characters['liya']?.discard.some((u) => b.cards[u]?.defId === 'ya-01')).toBe(true);
  });

  it('TC-CD-012 雅-02 滞空跳跃：移动至多 2 场景（可跨不相邻、无需沿路径）【§9.2】', () => {
    let s = freshGame();
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-02');
    s = playPassCopy(s, 'liya', 'ya-02', { scene: 'human_city' }); // 跨 2 且终点与起点不相邻
    expect(s.characters['liya']?.scene).toBe('human_city');
  });

  it('TC-CD-013 雅-03 精灵地图：看顶 3 任意序放回；【暗】全置底【§9.2】【裁A-38】', () => {
    let s = freshGame();
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-03');
    // 摆盘：顶 3 中第 1/3 张为【暗】（危-02、危-09），第 2 张非暗（危-01）
    s = topCrisis(s, 'crisis-09');
    s = mut(s, (d) => {
      const rest = d.decks.crisis.slice(1);
      const c01 = rest.find((u) => d.cards[u]?.defId === 'crisis-01')!;
      const c02 = rest.find((u) => d.cards[u]?.defId === 'crisis-02')!;
      d.decks.crisis = [d.decks.crisis[0]!, c01, c02, ...rest.filter((u) => u !== c01 && u !== c02)];
    });
    const r = playRaw(s, 'liya', 'ya-03');
    expect(r.state.pendingDecision?.kind).toBe('reorder_cards');
    const s2 = settle(r.state);
    // 【暗】全部置底：危-09 与危-02 应在牌库底部区域（第 3 张起为非顶部位）
    expect(s2.cards[s2.decks.crisis[0]!]?.defId).toBe('crisis-01'); // 非暗卡回顶
    const bottom2 = s2.decks.crisis.slice(-2).map((u) => s2.cards[u]?.defId);
    expect(bottom2.sort()).toEqual(['crisis-02', 'crisis-09']);
  });

  it('TC-CD-014 雅-04 治愈之矢：任意角色回 2；目标失控小鱼额外 -1 侵蚀【§9.2】', () => {
    let a = freshGame();
    a = giveTurn(a, 'liya');
    a = mut(a, (d) => {
      d.characters['kaier']!.hp = 2;
    });
    a = ensureCard(a, 'liya', 'ya-04');
    a = playPassCopy(a, 'liya', 'ya-04', { characters: ['kaier'] });
    expect(a.characters['kaier']?.hp).toBe(4);
    let b = freshGame();
    b = setErosion(b, 4);
    b = giveTurn(b, 'liya');
    b = mut(b, (d) => {
      d.characters['xiaoyu']!.hp = 1;
    });
    b = ensureCard(b, 'liya', 'ya-04');
    b = playPassCopy(b, 'liya', 'ya-04', { characters: ['xiaoyu'] });
    expect(b.characters['xiaoyu']?.hp).toBe(3);
    expect(b.characters['xiaoyu']?.erosion).toBe(3);
  });

  it('TC-CD-015 雅-05 生命宝玉：清空+回满+自身永久 -1 上限；一局 2 次；决战不扣【§9.2】【L176, L223】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.erosion = 3;
      d.characters['xiaoyu']!.hp = 1;
      d.characters['liya']!.scene = 'human_city';
    });
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-05');
    s = playPassCopy(s, 'liya', 'ya-05');
    expect(s.characters['xiaoyu']?.erosion).toBe(0);
    expect(s.characters['xiaoyu']?.hp).toBe(5);
    expect(s.characters['liya']?.maxHp).toBe(4); // 永久 -1
    expect(s.flags.lifeGemUsed).toBe(1);
    // 限额 2：第 3 次拒绝
    let c = freshGame();
    c = mut(c, (d) => {
      d.characters['xiaoyu']!.erosion = 2;
      d.characters['liya']!.scene = 'human_city';
      d.flags.lifeGemUsed = 2;
    });
    c = giveTurn(c, 'liya');
    c = ensureCard(c, 'liya', 'ya-05');
    expect(() => playRaw(c, 'liya', 'ya-05')).toThrow(/两次|限/);
    // 决战中不扣上限（限额共用）
    let b = toBattle(freshGame(), (d) => {
      d.characters['xiaoyu']!.erosion = 3;
      d.flags.lifeGemUsed = 1;
    });
    b = giveTurn(b, 'liya', 2);
    b = ensureCard(b, 'liya', 'ya-05');
    b = playPassCopy(b, 'liya', 'ya-05');
    expect(b.characters['liya']?.maxHp).toBe(5); // 不扣
    expect(b.flags.lifeGemUsed).toBe(2);
  });

  it('TC-CD-016 雅-06 箭雨：当前场景至多 2 目标各 2 点【§9.2】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-06');
    const uids = crisisIn(s, 'elf_kingdom', 'crisis-01');
    const r = playRaw(s, 'liya', 'ya-06', { crisisUids: uids.slice(0, 2) });
    const dmgs = r.events.filter((e) => e.kind === 'crisis_damaged').map((e) => (e as { amount: number }).amount);
    expect(dmgs).toEqual([2, 2]);
  });

  it('TC-CD-017 雅-07 风之加护：同场景友方本轮下一次攻击 +2（一次性）【§9.2】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-07');
    s = playPassCopy(s, 'liya', 'ya-07', { characters: ['kaier'] });
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-02');
    const r = playRaw(s, 'kaier', 'kai-02', { crisisUids: [uidOf(s, 'crisis-10', 'elf_kingdom')] });
    expect(dmgOf(r)).toBe(6); // 4+2（危机度 6 恰好清除）
    // 第二次攻击（新目标）不加（一次性已消耗）
    let s2 = settle(r.state);
    s2 = giveTurn(s2, 'kaier');
    s2 = ensureCard(s2, 'kaier', 'kai-02');
    const r2 = playRaw(s2, 'kaier', 'kai-02', { crisisUids: [uidOf(s2, 'crisis-01', 'elf_kingdom')] });
    expect(dmgOf(r2)).toBe(4);
  });

  it('TC-CD-018 雅-08 精灵誓约：条件同处；双方各抽 1 + 小鱼下一回合 +1 AP（不可累积）【§9.2】【L332】', () => {
    let a = freshGame();
    a = giveTurn(a, 'liya');
    a = ensureCard(a, 'liya', 'ya-08');
    expect(() => playRaw(a, 'liya', 'ya-08')).toThrow(/同处/);
    let s = freshGame();
    s = giveTurn(s, 'liya');
    s = mut(s, (d) => {
      d.characters['liya']!.scene = 'human_city';
    });
    s = ensureCard(s, 'liya', 'ya-08');
    s = playPassCopy(s, 'liya', 'ya-08');
    expect(s.characters['xiaoyu']?.nextTurnApBonus).toBe(1);
  });

  it('TC-CD-019 雅-09 追踪箭：任意场景 1 目标 3 点（远程）【§9.2】【裁A-20】', () => {
    let s = putCrisis(clearCrises(freshGame()), 'crisis-01', 'human_city');
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-09');
    const r = playRaw(s, 'liya', 'ya-09', { crisisUids: [uidOf(s, 'crisis-01', 'human_city')] });
    expect(dmgOf(r)).toBe(3);
  });

  it('TC-CD-020 雅-10 为你而来：移至小鱼场景；途中经过场景 1 张危机 1 点（路径须合法相邻）【§9.2】', () => {
    let s = freshGame();
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-10');
    s = putCrisis(s, 'crisis-10', 'ancient_battlefield');
    const uid = uidOf(s, 'crisis-10', 'ancient_battlefield');
    const r = playRaw(s, 'liya', 'ya-10', { scene: 'ancient_battlefield', crisisUids: [uid] });
    expect(r.state.characters['liya']?.scene).toBe('human_city'); // 小鱼在王城
    expect(r.state.scenes['ancient_battlefield'].crisisDamage[uid]).toBe(1);
  });

  // ── 凯尔 ──
  it('TC-CD-021 凯-01 公爵之令：目标下一回合 +1 AP 并抽 1【§9.3】', () => {
    let s = freshGame();
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-01');
    s = playPassCopy(s, 'kaier', 'kai-01', { characters: ['liya'] });
    expect(s.characters['liya']?.nextTurnApBonus).toBe(1);
    expect(s.characters['liya']?.nextTurnDraw).toBe(1);
  });

  it('TC-CD-022 凯-02 精灵剑术：4 点；本轮已用凯-05 → +1（叠加凯-05 本轮 +2 buff）【§9.3】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'elf_kingdom');
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-02');
    expect(dmgOf(playRaw(s, 'kaier', 'kai-02', { crisisUids: [uidOf(s, 'crisis-10', 'elf_kingdom')] }))).toBe(4);
    let b = putCrisis(freshGame(), 'crisis-10', 'elf_kingdom');
    b = giveTurn(b, 'kaier');
    b = ensureCard(b, 'kaier', 'kai-05');
    b = playPassCopy(b, 'kaier', 'kai-05');
    b = ensureCard(b, 'kaier', 'kai-02');
    // 4 基础 + 1（凯-02 自身条件：本轮已用凯-05）+ 2（凯-05 本轮伤害 buff）= 7
    expect(dmgOf(playRaw(b, 'kaier', 'kai-02', { crisisUids: [uidOf(b, 'crisis-10', 'elf_kingdom')] }))).toBe(7);
  });

  it('TC-CD-023 凯-03 战术转移：自身与同场景 1 友方同移相邻、双方不耗 AP；可移失控小鱼【§9.3】【裁A-24】', () => {
    let s = freshGame();
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-03');
    s = mut(s, (d) => {
      d.characters['kaier']!.scene = 'human_city';
    });
    const apX = s.characters['xiaoyu']!.ap;
    s = playPassCopy(s, 'kaier', 'kai-03', { characters: ['xiaoyu'], scene: 'ancient_battlefield' });
    expect(s.characters['kaier']?.scene).toBe('ancient_battlefield');
    expect(s.characters['xiaoyu']?.scene).toBe('ancient_battlefield');
    expect(s.characters['xiaoyu']?.ap).toBe(apX); // 小鱼不耗
    // 失控小鱼可被移动
    let b = freshGame();
    b = setErosion(b, 4);
    b = giveTurn(b, 'kaier');
    b = ensureCard(b, 'kaier', 'kai-03');
    b = mut(b, (d) => {
      d.characters['kaier']!.scene = 'human_city';
    });
    b = playPassCopy(b, 'kaier', 'kai-03', { characters: ['xiaoyu'], scene: 'ancient_battlefield' });
    expect(b.characters['xiaoyu']?.scene).toBe('ancient_battlefield');
  });

  it('TC-CD-024 凯-04 王夫之怒：伤害=古战场危机卡数+2【§9.3】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'ancient_battlefield');
    s = putCrisis(s, 'crisis-01', 'ancient_battlefield');
    s = putCrisis(s, 'crisis-02', 'ancient_battlefield');
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-04');
    expect(dmgOf(playRaw(s, 'kaier', 'kai-04', { crisisUids: [uidOf(s, 'crisis-10', 'elf_kingdom')] }))).toBe(5); // 3+2
  });

  it('TC-CD-025 凯-05 偏见：0 AP 每轮限 1；翻卡+本轮 +2；决战仅 +2 不翻卡；独立限额【§9.3】【裁A-17】【裁A-10】【裁A-45】', () => {
    let s = clearCrises(freshGame());
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-05');
    const ap0 = s.characters['kaier']!.ap;
    s = playPassCopy(s, 'kaier', 'kai-05');
    expect(s.characters['kaier']?.ap).toBe(ap0); // 0 AP
    expect(Object.values(s.scenes).reduce((n, sc) => n + sc.crisisCards.length, 0)).toBe(1);
    expect(s.buffs.some((b) => b.source === 'kai-05' && b.value === 2)).toBe(true);
    // 决战：仅 +2 不翻卡
    let b = toBattle(freshGame());
    b = giveTurn(b, 'kaier', 2);
    b = ensureCard(b, 'kaier', 'kai-05');
    const total0 = Object.values(b.scenes).reduce((n, sc) => n + sc.crisisCards.length, 0);
    b = playPassCopy(b, 'kaier', 'kai-05');
    expect(Object.values(b.scenes).reduce((n, sc) => n + sc.crisisCards.length, 0)).toBe(total0);
    expect(b.buffs.some((x) => x.source === 'kai-05')).toBe(true);
  });

  it('TC-CD-026 凯-06 贵族决断：弃 2 抽 3【§9.3】', () => {
    let s = freshGame();
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-06');
    const hand0 = s.characters['kaier']!.hand.length;
    const discards = s.characters['kaier']!.hand.slice(0, 2);
    s = playPassCopy(s, 'kaier', 'kai-06', { cardUids: discards } as never);
    expect(s.characters['kaier']?.hand.length).toBe(hand0 - 1 - 2 + 3);
  });

  it('TC-CD-027 凯-07 护卫誓言：代受下一次伤害；来源带【暗】→ 获 1 材料【§9.3】', () => {
    // a) 无【暗】来源：代受、无材料
    let a = freshGame();
    a = giveTurn(a, 'kaier');
    a = ensureCard(a, 'kaier', 'kai-07');
    a = playPassCopy(a, 'kaier', 'kai-07', { characters: ['liya'] });
    a = hit(a, 'liya', 2);
    expect(a.characters['kaier']?.hp).toBe(3); // 代受 2
    expect(a.characters['liya']?.hp).toBe(5);
    expect(a.characters['kaier']?.materialTokens).toBe(0);
    // b) 【暗】来源（危-02 轮末路径）：代受 + 材料 1
    let b = freshGame();
    b = giveTurn(b, 'kaier');
    b = ensureCard(b, 'kaier', 'kai-07');
    b = playPassCopy(b, 'kaier', 'kai-07', { characters: ['liya'] });
    b = hit(b, 'liya', 1, { dark: true, source: 'crisis:crisis-02' });
    expect(b.characters['kaier']?.hp).toBe(4);
    expect(b.characters['kaier']?.materialTokens).toBe(1);
  });

  it('TC-CD-028 凯-08 破晓冲锋：至多 2 目标各 2 点；结算后剩余 AP 归零【§9.3】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = giveTurn(s, 'kaier', 3);
    s = ensureCard(s, 'kaier', 'kai-08');
    const uids = crisisIn(s, 'elf_kingdom', 'crisis-01');
    const r = playRaw(s, 'kaier', 'kai-08', { crisisUids: uids.slice(0, 2) });
    const dmgs = r.events.filter((e) => e.kind === 'crisis_damaged').map((e) => (e as { amount: number }).amount);
    expect(dmgs).toEqual([2, 2]);
    expect(r.state.characters['kaier']?.ap).toBe(0);
    // 无法再行动
    expect(() => applyCommand(r.state, { type: 'search', character: 'kaier' })).toThrow(/行动点不足/);
  });

  it('TC-CD-029 凯-09 精灵荣光：本轮场景友方攻击 +2；已与巴爷结羁绊 → 延长一轮【§9.3】【裁A-05】', () => {
    // a) 未结羁绊：仅本轮
    let a = freshGame();
    a = giveTurn(a, 'kaier');
    a = ensureCard(a, 'kaier', 'kai-09');
    a = playPassCopy(a, 'kaier', 'kai-09');
    expect(a.buffs.some((b) => b.source === 'kai-09' && b.scope === 'round')).toBe(true);
    a = passRound(a);
    expect(a.buffs.some((b) => b.source === 'kai-09')).toBe(false);
    // b) 已与巴爷结羁绊：持续至下一轮
    let b = freshGame();
    b = setBond(b, 'kaier', 'baye', 'bond-06');
    b = giveTurn(b, 'kaier');
    b = ensureCard(b, 'kaier', 'kai-09');
    b = playPassCopy(b, 'kaier', 'kai-09');
    b = passRound(b);
    expect(b.buffs.some((x) => x.source === 'kai-09')).toBe(true); // 下一轮仍在
    b = passRound(b);
    expect(b.buffs.some((x) => x.source === 'kai-09')).toBe(false); // 再一轮消失
  });

  it('TC-CD-030 凯-10 为妻而战：条件/基准 4/其他三场景无卡 6（裁A-02，3 断言）【§9.3】【L354】【裁A-02】', () => {
    // a) 古战场无危机卡 → 不可打出
    let a = clearCrises(freshGame());
    a = giveTurn(a, 'kaier');
    a = ensureCard(a, 'kaier', 'kai-10');
    expect(() => playRaw(a, 'kaier', 'kai-10', { crisisUids: [] })).toThrow(/古战场/);
    // b) 古战场有卡且其他场景也有 → 4
    let b = freshGame();
    b = clearCrises(b);
    b = putCrisis(b, 'crisis-02', 'ancient_battlefield');
    b = putCrisis(b, 'crisis-10', 'elf_kingdom');
    b = giveTurn(b, 'kaier');
    b = ensureCard(b, 'kaier', 'kai-10');
    expect(dmgOf(playRaw(b, 'kaier', 'kai-10', { crisisUids: [uidOf(b, 'crisis-10', 'elf_kingdom')] }))).toBe(4);
    // c) 古战场有卡、其他三场景均无 → 6
    let c = freshGame();
    c = clearCrises(c);
    c = putCrisis(c, 'crisis-02', 'ancient_battlefield');
    c = giveTurn(c, 'kaier');
    c = ensureCard(c, 'kaier', 'kai-10');
    expect(dmgOf(playRaw(c, 'kaier', 'kai-10', { crisisUids: [uidOf(c, 'crisis-02', 'ancient_battlefield')] }))).toBe(6);
  });

  // ── 巴爷 ──
  it('TC-CD-031 巴-01 舰炮轰击：任意场景 1 目标 3 点、1 AP 正常费用（远程）【§9.4】【裁A-38】【裁A-20】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'dark_valley');
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-01');
    const r = playRaw(s, 'baye', 'ba-01', { crisisUids: [uidOf(s, 'crisis-10', 'dark_valley')] });
    expect(dmgOf(r)).toBe(3);
    expect(r.state.characters['baye']?.ap).toBe(2);
  });

  it('TC-CD-032 巴-02 侠盗直觉：抽 3 选 2 弃 1 + 1 材料；牌库不足洗弃牌堆【§9.4】【L109】', () => {
    let s = freshGame();
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-02');
    const hand0 = s.characters['baye']!.hand.length;
    s = playPassCopy(s, 'baye', 'ba-02'); // settle 默认选前 2 张
    expect(s.characters['baye']?.hand.length).toBe(hand0 - 1 + 2); // 打出 1、入手 2
    expect(s.characters['baye']?.discard.length).toBe(1 + 1); // 打出的卡 + 弃 1
    expect(s.characters['baye']?.materialTokens).toBe(1);
    // 牌库 1 + 弃牌堆 3 → 洗混重建抽满 3
    let b = freshGame();
    b = giveTurn(b, 'baye');
    b = ensureCard(b, 'baye', 'ba-02');
    b = mut(b, (d) => {
      const y = d.characters['baye']!;
      y.discard.push(...y.deck.splice(0, y.deck.length - 1)); // 牌库留 1
    });
    const evCount = evs(b, 'deck_reshuffled').length;
    b = playPassCopy(b, 'baye', 'ba-02');
    expect(evs(b, 'deck_reshuffled').length).toBeGreaterThan(evCount); // 触发重建
  });

  it('TC-CD-033 巴-03 老练格挡：本轮受伤 -2（钳 0）+ 抽 1【§9.4】', () => {
    let s = freshGame();
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-03');
    const hand0 = s.characters['baye']!.hand.length;
    s = playPassCopy(s, 'baye', 'ba-03');
    expect(s.characters['baye']?.hand.length).toBe(hand0); // -1 打出 +1 抽
    s = hit(s, 'baye', 1);
    expect(s.characters['baye']?.hp).toBe(5); // 1-2 钳 0
    s = hit(s, 'baye', 4);
    expect(s.characters['baye']?.hp).toBe(3); // 4-2=2
  });

  it('TC-CD-034 巴-04 弩炮掩护：本轮同场景或相邻场景友方攻击 +1【§9.4】', () => {
    // 同场景（小鱼在王城）
    let s = putCrisis(freshGame(), 'crisis-10', 'human_city');
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-04');
    s = playPassCopy(s, 'baye', 'ba-04');
    s = giveTurn(s, 'xiaoyu');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    const r = playRaw(s, 'xiaoyu', 'yu-01', { crisisUids: [uidOf(s, 'crisis-10', 'human_city')] });
    expect(dmgOf(r)).toBe(4); // 3+1（无屠龙者 vs 危机卡）
    // 相邻场景（莉雅在古战场）也 +1；远处（黑暗山谷）不加
    let b = freshGame();
    b = giveTurn(b, 'baye'); // 巴爷在王城
    b = ensureCard(b, 'baye', 'ba-04');
    b = playPassCopy(b, 'baye', 'ba-04');
    b = mut(b, (d) => {
      d.characters['liya']!.scene = 'ancient_battlefield';
    });
    b = putCrisis(b, 'crisis-10', 'ancient_battlefield');
    b = giveTurn(b, 'liya');
    b = ensureCard(b, 'liya', 'ya-01');
    const r2 = playRaw(b, 'liya', 'ya-01', { crisisUids: [uidOf(b, 'crisis-10', 'ancient_battlefield')] });
    expect(dmgOf(r2)).toBe(4); // 3+1（掩护；当前场景攻击无神射）
  });

  it('TC-CD-035 巴-05 紧急融资：弃 1 装备 → +3 AP（未用完消失）；无装备 → 失去 1 血 +2 AP【§9.4】【裁A-29】', () => {
    // a) 弃装备 +3
    let a = freshGame();
    a = giveEquipment(a, 'baye', 'equip-01');
    a = giveTurn(a, 'baye');
    a = ensureCard(a, 'baye', 'ba-05');
    a = playPassCopy(a, 'baye', 'ba-05');
    expect(a.characters['baye']?.equipment.length).toBe(0);
    expect(a.characters['baye']?.ap).toBe(3 - 1 + 3); // 5
    // b) 无装备：失去 1 血（不可减免）+2（见 TC-CB-018 链外性）
    let b = freshGame();
    b = giveTurn(b, 'baye');
    b = ensureCard(b, 'baye', 'ba-05');
    b = playPassCopy(b, 'baye', 'ba-05');
    expect(b.characters['baye']?.hp).toBe(4);
    expect(b.characters['baye']?.ap).toBe(3 - 1 + 2); // 4
  });

  it('TC-CD-036 巴-06 孤胆英雄：3 点；场景无其他友方 → 翻倍（节点位置由声明顺序定）【§9.4】【裁A-08】', () => {
    // a) 无其他友方（巴爷独在人类王城? 初始小鱼也在——调开）
    let a = putCrisis(freshGame(), 'crisis-10', 'human_city');
    a = giveTurn(a, 'baye');
    a = ensureCard(a, 'baye', 'ba-06');
    a = mut(a, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom';
    });
    expect(dmgOf(playRaw(a, 'baye', 'ba-06', { crisisUids: [uidOf(a, 'crisis-10', 'human_city')] }))).toBe(6);
    // b) 有友方同场景 → 3
    let b = putCrisis(freshGame(), 'crisis-10', 'human_city');
    b = giveTurn(b, 'baye');
    b = ensureCard(b, 'baye', 'ba-06');
    expect(dmgOf(playRaw(b, 'baye', 'ba-06', { crisisUids: [uidOf(b, 'crisis-10', 'human_city')] }))).toBe(3);
    // c) 与静态 ADD 的顺序（凯-09 场景 +2）：(3+2)×2=10 —— 见 TC-CB-009
  });

  it('TC-CD-037 巴-07 战地抢修：当前场景 1 点 + 展示区 1 装备下次锻造折扣【§9.4】【裁A-38】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'human_city');
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-07');
    const eqUid = s.equipmentDisplay[0]!;
    const r = playRaw(s, 'baye', 'ba-07', { crisisUids: [uidOf(s, 'crisis-10', 'human_city')], cardUids: [eqUid] } as never);
    expect(dmgOf(r)).toBe(1);
    expect(r.state.flags.oneShotUsed[`ba07:${eqUid}`]).toBe(true); // 折扣标记已挂（锻造见 TC-FG-003）
  });

  it('TC-CD-038 巴-08 王牌驾驶员：飞空艇移至任意场景（不耗次数）+ 目标场景 2 点【§9.4】【L371】', () => {
    let s = putCrisis(freshGame(), 'crisis-10', 'dark_valley');
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-08');
    // 先用掉飞空艇使其冷却
    s = applyCommand(s, { type: 'move', character: 'baye', to: 'ancient_battlefield', via: 'airship' }).state;
    expect(s.characters['baye']?.airship?.cooldownRounds).toBeGreaterThan(0);
    // 巴-08 不耗次数、冷却中也可用
    const r = playRaw(s, 'baye', 'ba-08', { scene: 'dark_valley', crisisUids: [uidOf(s, 'crisis-10', 'dark_valley')] });
    expect(r.state.characters['baye']?.scene).toBe('dark_valley');
    expect(dmgOf(r)).toBe(2);
  });

  it('TC-CD-039 巴-09 生死之交：本轮伤害两人分摊（守恒）；已结羁绊各回 1【§9.4】【裁A-30】', () => {
    // a) 未结羁绊也可打出（条件仅同场景）：偶数伤害免询问各半
    let s = freshGame();
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-09');
    s = mut(s, (d) => {
      d.characters['kaier']!.scene = 'human_city';
    });
    s = playPassCopy(s, 'baye', 'ba-09');
    const r = hit(s, 'baye', 4); // 偶数 → 2+2
    expect(r.characters['baye']?.hp).toBe(3);
    expect(r.characters['kaier']?.hp).toBe(3);
    expect(r.characters['baye']!.hp + r.characters['kaier']!.hp).toBe(10 - 4); // 总额守恒
    // b) 已结羁绊：双方各回 1
    let b = freshGame();
    b = setBond(b, 'kaier', 'baye', 'bond-06');
    b = giveTurn(b, 'baye');
    b = ensureCard(b, 'baye', 'ba-09');
    b = mut(b, (d) => {
      d.characters['kaier']!.scene = 'human_city';
      d.characters['kaier']!.hp = 3;
      d.characters['baye']!.hp = 4;
    });
    b = playPassCopy(b, 'baye', 'ba-09');
    expect(b.characters['baye']?.hp).toBe(5);
    expect(b.characters['kaier']?.hp).toBe(4);
  });

  it('TC-CD-040 巴-10 最终航班：一局 1 次移出游戏；所有友方移至你场景、不耗 AP【§9.4】【L373】', () => {
    let s = freshGame();
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-10');
    s = playPassCopy(s, 'baye', 'ba-10');
    for (const c of ['xiaoyu', 'liya', 'kaier'] as const) {
      expect(s.characters[c]?.scene).toBe('human_city');
    }
    expect(s.characters['baye']?.hand.some((u) => s.cards[u]?.defId === 'ba-10')).toBe(false);
    expect(s.characters['baye']?.discard.some((u) => s.cards[u]?.defId === 'ba-10')).toBe(false); // 移出游戏
    expect(s.flags.oneShotUsed['ba-10']).toBe(true);
    // 第二次不可用
    let s2 = freshGame();
    s2 = giveTurn(s2, 'baye');
    s2 = ensureCard(s2, 'baye', 'ba-10');
    s2 = mut(s2, (d) => {
      d.flags.oneShotUsed['ba-10'] = true;
    });
    expect(() => playRaw(s2, 'baye', 'ba-10')).toThrow(/限/);
  });

  it('TC-CD-041 飞空艇：不耗 AP 移至任意场景；冷却 1 轮；可携 1 名出发场景友方【§6.7】【裁A-13】', () => {
    let s = freshGame();
    s = giveTurn(s, 'baye');
    // 携带小鱼（出发场景友方）
    s = applyCommand(s, { type: 'move', character: 'baye', to: 'dark_valley', via: 'airship', carry: 'xiaoyu' }).state;
    expect(s.characters['baye']?.scene).toBe('dark_valley');
    expect(s.characters['xiaoyu']?.scene).toBe('dark_valley');
    expect(s.characters['baye']?.ap).toBe(3); // 不耗 AP
    // 本轮再用拒绝
    expect(() => applyCommand(s, { type: 'move', character: 'baye', to: 'human_city', via: 'airship' })).toThrow(/冷却/);
    // 下一轮（冷却 1）仍不可用
    s = mut(s, (d) => {
      d.currentTurn = { character: 'baye' };
    });
    s = passRound(s);
    s = mut(s, (d) => {
      d.currentTurn = { character: 'baye' };
    });
    expect(() => applyCommand(s, { type: 'move', character: 'baye', to: 'human_city', via: 'airship' })).toThrow(/冷却/);
    // 再下一轮可用
    s = passRound(s);
    s = mut(s, (d) => {
      d.currentTurn = { character: 'baye' };
    });
    expect(() => applyCommand(s, { type: 'move', character: 'baye', to: 'human_city', via: 'airship' })).not.toThrow();
    // 携带者须为出发场景友方：莉雅（精灵王国）不可被携
    let b = freshGame();
    b = giveTurn(b, 'baye');
    expect(() => applyCommand(b, { type: 'move', character: 'baye', to: 'dark_valley', via: 'airship', carry: 'liya' })).toThrow(/携带|出发场景/);
  });

  it('TC-CD-042 飞空艇：位置恒视为巴爷所在；决战不可用【§6.7】【L198】【C6】', () => {
    // 位置跟随（状态仅存冷却计数，位置即巴爷场景）
    let s = freshGame();
    s = giveTurn(s, 'baye');
    s = applyCommand(s, { type: 'move', character: 'baye', to: 'dark_valley', via: 'airship' }).state;
    expect(s.characters['baye']?.scene).toBe('dark_valley');
    expect(s.characters['baye']?.airship?.cooldownRounds).toBeGreaterThanOrEqual(1); // 标记仅示冷却
    // 决战不可用
    let b = toBattle(freshGame());
    b = mut(b, (d) => {
      d.currentTurn = { character: 'baye' };
      d.characters['baye']!.ap = 2;
    });
    expect(() => applyCommand(b, { type: 'move', character: 'baye', to: 'human_city', via: 'airship' })).toThrow(/决战/);
  });
});

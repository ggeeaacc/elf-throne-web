/**
 * TC-CB 交战结算与伤害效果链 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import { dealDamageToCharacter, foldChain } from '../../engine/src/systems/damage.js';
import type { DamageInstance } from '../../engine/src/systems/damage.js';
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
  settle,
  toBattle,
  topCrisis,
} from '../helpers/regression-utils.js';
import type { CharacterId, GameEvent, GameState } from '../../engine/src/types.js';

function giveTurn(s: GameState, c: CharacterId, ap?: number): GameState {
  return mut(s, (d) => {
    d.currentTurn = { character: c };
    d.characters[c]!.ap = ap ?? 3;
  });
}

/** 直接对角色造成伤害（摆盘：基础 base、无链、非黑暗） */
function hit(s: GameState, target: CharacterId, base: number, opts?: { dark?: boolean }): GameState {
  const d = structuredClone(s);
  const events: GameEvent[] = [];
  dealDamageToCharacter(d, events, {
    target,
    damage: { base, chain: [], source: 'fixture', dark: opts?.dark ?? false, fromAttackCard: false },
  });
  d.log.push(...events);
  return d;
}

/** 对角色造成伤害并保留挂起（多代受/分摊决策用） */
function hitRaw(s: GameState, target: CharacterId, base: number): { state: GameState; events: GameEvent[] } {
  const d = structuredClone(s);
  const events: GameEvent[] = [];
  dealDamageToCharacter(d, events, {
    target,
    damage: { base, chain: [], source: 'fixture', dark: false, fromAttackCard: false },
  });
  d.log.push(...events);
  return { state: d, events };
}

function resolveNow(s: GameState, choice: unknown): GameState {
  return applyCommand(s, { type: 'resolve_decision', decisionId: s.pendingDecision!.id, choice }).state;
}

describe('TC-CB 交战结算与伤害效果链', () => {
  it('TC-CB-001 攻击扣危机度、单次溢出浪费【§6.1】【L134-138】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-08', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    const uid = crisisIn(s, 'human_city', 'crisis-08')[0]!;
    const r = playRaw(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] });
    const dmg = r.events.find((e) => e.kind === 'crisis_damaged') as { amount: number; remaining: number } | undefined;
    expect(dmg?.amount).toBe(3); // 3（无屠龙者 vs 危机卡）
    expect(dmg?.remaining).toBe(0); // 溢出 2 点浪费（不结转）
  });

  it('TC-CB-002 危机度 ≤0 → 清除入危机弃牌堆【§6.1】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-08', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    const uid = crisisIn(s, 'human_city', 'crisis-08')[0]!;
    s = playCardById(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] });
    expect(s.decks.crisisDiscard).toContain(uid);
    expect(s.scenes['human_city'].crisisCards).not.toContain(uid);
  });

  it('TC-CB-003 参与者=伤害轨迹 ≥1：仅提供 buff 者不算【§6.1】【裁A-09】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-01');
    s = playPassCopy(s, 'liya', 'ya-01', { crisisUids: [uid] }); // 3 伤（剩余 3）
    // 凯尔仅加 buff（凯-09 场景 +2），未造成伤害
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-09');
    s = playPassCopy(s, 'kaier', 'kai-09');
    // 莉雅再打（3+2=5，累计 8 ≥ 6 清除）
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-01');
    s = playPassCopy(s, 'liya', 'ya-01', { crisisUids: [uid] });
    const cleared = evs(s, 'crisis_cleared').find((e) => e.cardUid === uid);
    expect(cleared?.participants).toEqual(['liya']);
    const mats = evs(s, 'material_gained').map((e) => e.character);
    expect(mats).toContain('liya');
    expect(mats).not.toContain('kaier');
  });

  it('TC-CB-004 基础奖励（各 1 材料）与卡面清除奖励并存【§6.1】【L415】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-05', 'dark_valley');
    s = mut(s, (d) => {
      const uid = d.scenes['dark_valley'].crisisCards.find((u) => d.cards[u]?.defId === 'crisis-05')!;
      d.scenes['dark_valley'].crisisDamage[uid] = 2; // 莉雅此前造成 2
      d.crisisDamageLog[uid] = ['liya'];
    });
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-01');
    const uid = crisisIn(s, 'dark_valley', 'crisis-05')[0]!;
    s = playPassCopy(s, 'baye', 'ba-01', { crisisUids: [uid] }); // +3 → 清除
    expect(s.characters['liya']?.materialTokens).toBe(3); // 基础 1 + 卡面 2
    expect(s.characters['baye']?.materialTokens).toBe(3);
  });

  it('TC-CB-005 材料上限 4 溢出丢失；获得前可先转让腾位【§1.4】【裁A-28】', () => {
    // a) 直接获得 → 溢出丢失
    let a = freshGame();
    a = putCrisis(a, 'crisis-08', 'human_city');
    a = mut(a, (d) => {
      d.characters['xiaoyu']!.materialTokens = 4;
    });
    a = ensureCard(a, 'xiaoyu', 'yu-01');
    a = playCardById(a, 'xiaoyu', 'yu-01', { crisisUids: [crisisIn(a, 'human_city', 'crisis-08')[0]!] });
    expect(a.characters['xiaoyu']?.materialTokens).toBe(4);
    // b) 先转让 1 给巴爷再获得 → 4（3+1）
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.materialTokens = 4;
    });
    s = applyCommand(s, { type: 'transfer_material', character: 'xiaoyu', to: 'baye', count: 1 }).state;
    expect(s.characters['xiaoyu']?.materialTokens).toBe(3);
    expect(s.characters['baye']?.materialTokens).toBe(1);
    s = putCrisis(s, 'crisis-08', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = playCardById(s, 'xiaoyu', 'yu-01', { crisisUids: [crisisIn(s, 'human_city', 'crisis-08')[0]!] });
    expect(s.characters['xiaoyu']?.materialTokens).toBe(4);
    expect(s.characters['baye']?.materialTokens).toBe(1);
  });

  it('TC-CB-006 同场景材料自由转让：不耗 AP、任意回合；跨场景拒绝【§1.4】【L137】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.materialTokens = 2;
    });
    // 非巴爷回合也可转让（小鱼→巴爷 同场景）
    s = applyCommand(s, { type: 'transfer_material', character: 'xiaoyu', to: 'baye', count: 1 }).state;
    expect(s.characters['baye']?.materialTokens).toBe(1);
    expect(s.characters['xiaoyu']?.ap).toBe(3); // 不耗 AP
    // 跨场景拒绝
    expect(() => applyCommand(s, { type: 'transfer_material', character: 'xiaoyu', to: 'liya', count: 1 })).toThrow(/同场景/);
  });

  it('TC-CB-007 非伤害手段离场不算清除、无任何清除奖励【§6.1】【裁A-09】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'liya', 'bond-05');
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-05'))!.cardUid!;
    s = applyCommand(s, { type: 'bond_active', character: 'xiaoyu', bondUid, params: { scene: 'elf_kingdom' } }).state;
    expect(s.sceneWards['elf_kingdom']).toBe(1);
    // 控制下一轮 P1 翻通用卡并手动落点精灵王国 → 被守护弃置
    s = topCrisis(s, 'crisis-01');
    const count0 = crisisIn(s, 'elf_kingdom').length;
    const cleared0 = evs(s, 'crisis_cleared').length;
    s = passTurn(s);
    s = passTurn(s);
    s = passTurn(s);
    s = applyCommand(s, { type: 'end_turn', character: 'baye' }).state;
    expect(s.pendingDecision?.kind).toBe('place_crisis');
    s = resolveNow(s, { scene: 'elf_kingdom' });
    expect(s.sceneWards['elf_kingdom'] ?? 0).toBe(0); // 守护已消耗
    expect(crisisIn(s, 'elf_kingdom').length).toBe(count0); // 未放置
    expect(evs(s, 'crisis_cleared').length).toBe(cleared0); // 无清除事件
    expect(evs(s, 'material_gained').length).toBe(0); // 无奖励
  });

  it('TC-CB-008 屠龙者之血：仅攻击卡 +1（含对护盾/玫拉）【§1.2】【§11】【L300】【裁A-12】', () => {
    // 对护盾
    let s = toBattle(freshGame());
    s = giveTurn(s, 'xiaoyu', 2);
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    const shield0 = s.boss!.shield;
    s = playPassCopy(s, 'xiaoyu', 'yu-01');
    expect(s.boss?.shield).toBe(shield0 - 4); // 3+1 对护盾
    // 对玫拉本体（女王已救 → 直接 P2）
    let s2 = toBattle(freshGame(), (d) => {
      d.flags.queenRescued = true;
    });
    s2 = giveTurn(s2, 'xiaoyu', 2);
    s2 = ensureCard(s2, 'xiaoyu', 'yu-01');
    const hp0 = s2.boss!.hp;
    s2 = playPassCopy(s2, 'xiaoyu', 'yu-01');
    expect(s2.boss?.hp).toBe(hp0 - 4);
  });

  it('TC-CB-009 效果链声明顺序敏感：静态→卡面→消耗品确定性折叠【§11】【裁A-08】', () => {
    // 单元：同集合不同次序结果不同（声明顺序 = 链序）
    const mk = (chain: DamageInstance['chain']): DamageInstance => ({ base: 3, chain, source: 't', dark: false, fromAttackCard: true });
    expect(foldChain(mk([{ op: 'MULT', value: 2, source: 'a' }, { op: 'ADD', value: 2, source: 'b' }]))).toBe(8);
    expect(foldChain(mk([{ op: 'ADD', value: 2, source: 'b' }, { op: 'MULT', value: 2, source: 'a' }]))).toBe(10);
    // 对局：凯-09（静态 ADD 先于卡面）+ 巴-06（卡面 MULT）→ (3+2)×2=10
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'human_city');
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-09');
    s = mut(s, (d) => {
      d.characters['kaier']!.scene = 'human_city';
    });
    s = playPassCopy(s, 'kaier', 'kai-09'); // 王城场景 +2
    s = giveTurn(s, 'baye');
    s = ensureCard(s, 'baye', 'ba-06');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom';
      d.characters['kaier']!.scene = 'elf_kingdom'; // 凯尔离开不影响已挂场景 buff
    });
    const uid = crisisIn(s, 'human_city', 'crisis-10')[0]!;
    const r = playRaw(s, 'baye', 'ba-06', { crisisUids: [uid] });
    expect((r.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(10);
    // 巴-06 + 净化 1（消耗品在卡面之后）→ 3×2+1=7
    let s2 = freshGame();
    s2 = putCrisis(s2, 'crisis-10', 'human_city');
    s2 = giveTurn(s2, 'baye');
    s2 = ensureCard(s2, 'baye', 'ba-06');
    s2 = mut(s2, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom';
      d.characters['baye']!.purifyTokens = 1;
    });
    const uid2 = crisisIn(s2, 'human_city', 'crisis-10')[0]!;
    const r2 = playRaw(s2, 'baye', 'ba-06', { crisisUids: [uid2] }, { usePurify: 1 });
    expect((r2.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(7);
  });

  it('TC-CB-010 减半语义：羁-07 复制向下取整（floor）【§11】【裁A-08】【裁A-32】', () => {
    // 奇数基础 3 → 复制 1（floor(3/2)=1）；分摊 ceil/floor 见 TC-CB-015
    let s = freshGame(); // 凯尔×莉雅 羁-07 初始激活、同场景精灵王国
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-01');
    s = ensureCard(s, 'kaier', 'kai-02'); // 凯尔持攻击卡供复制
    let r = playRaw(s, 'liya', 'ya-01', { crisisUids: [uid] });
    expect(r.state.pendingDecision?.kind).toBe('choose_option'); // 复制询问
    let s2 = resolveNow(r.state, { option: 'copy' });
    if (s2.pendingDecision?.kind === 'choose_cards') s2 = settle(s2); // 多可选时默认首张
    const dmgEvents = evs(s2, 'crisis_damaged').filter((e) => e.cardUid === uid);
    const total = dmgEvents.reduce((n, e) => n + (e as { amount: number }).amount, 0);
    expect(total).toBe(3 + 1); // 原 3 + 复制 1
  });

  it('TC-CB-011 REDUCE 节点各自钳制下限 0【§11】【裁A-08】', () => {
    // 基准：无减免 1 点
    let s0 = hit(freshGame(), 'xiaoyu', 1);
    expect(s0.characters['xiaoyu']?.hp).toBe(4);
    // 鱼-04（场景 -2）对 1 点伤害 → 钳 0
    let s = freshGame();
    s = ensureCard(s, 'xiaoyu', 'yu-04');
    s = playPassCopy(s, 'xiaoyu', 'yu-04'); // human_city 场景 -2 本轮
    s = hit(s, 'xiaoyu', 1);
    expect(s.characters['xiaoyu']?.hp).toBe(5); // 1-2 → 钳 0（不为负）
    // 叠加装-01（-1）：3 点伤害 → 3-2-1=0，各节点独立钳制
    s = giveEquipment(s, 'xiaoyu', 'equip-01');
    s = hit(s, 'xiaoyu', 3);
    expect(s.characters['xiaoyu']?.hp).toBe(5);
  });

  it('TC-CB-012 精灵神射：指定相邻场景 +1；当前场景不加【§1.2】【L319】', () => {
    let s = clearCrises(freshGame());
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'ancient_battlefield');
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-01');
    // 相邻（古战场）→ 3+1=4
    const r1 = playRaw(s, 'liya', 'ya-01', { crisisUids: [crisisIn(s, 'ancient_battlefield', 'crisis-01')[0]!] });
    expect((r1.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(4);
    // 当前场景（精灵王国）→ 3（先回绝复制询问再继续）
    let s2 = r1.state;
    if (s2.pendingDecision?.kind === 'choose_option') s2 = resolveNow(s2, { option: 'pass' });
    s2 = giveTurn(s2, 'liya');
    s2 = ensureCard(s2, 'liya', 'ya-01');
    const r2 = playRaw(s2, 'liya', 'ya-01', { crisisUids: [crisisIn(s2, 'elf_kingdom', 'crisis-01')[0]!] });
    expect((r2.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(3);
  });

  it('TC-CB-013 净化指示物：多目标攻击每个目标各 +1【§1.4】【裁A-39】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-06');
    s = mut(s, (d) => {
      d.characters['liya']!.purifyTokens = 2;
    });
    const uids = crisisIn(s, 'elf_kingdom', 'crisis-01').slice(0, 2);
    const r = playRaw(s, 'liya', 'ya-06', { crisisUids: uids }, { usePurify: 2 });
    const dmgs = r.events.filter((e) => e.kind === 'crisis_damaged').map((e) => (e as { amount: number }).amount);
    expect(dmgs).toEqual([4, 4]); // 2+2 各目标
    expect(r.state.characters['liya']?.purifyTokens).toBe(0);
  });

  it('TC-CB-014 信物标记：弃置使该次攻击 +2；可叠加持有、不过期【§1.4】【裁A-38】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.charms = 2;
    });
    const uid = crisisIn(s, 'human_city', 'crisis-10')[0]!;
    const r = playRaw(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] }, { useCharm: true });
    expect((r.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(5); // 3+2（无屠龙者 vs 危机卡）
    expect(r.state.characters['xiaoyu']?.charms).toBe(1); // 该次弃 1，余 1 可下次再用
    // 跨轮不失效
    let s2 = settle(r.state);
    s2 = passRound(s2);
    expect(s2.characters['xiaoyu']?.charms).toBe(1);
  });

  it('TC-CB-015 分摊 SHARE：总额守恒 ceil+floor、高份玩家定；羁-01 回血按伤害事件触发一次【§11】【裁A-30】【裁A-47】', () => {
    let base = freshGame();
    base = setBond(base, 'xiaoyu', 'liya', 'bond-01');
    base = mut(base, (d) => {
      d.characters['liya']!.scene = 'human_city'; // 同场景触发被动分摊
    });
    // 奇数 5 询问高份；高份给小鱼：小鱼 3、莉雅 2；【裁A-47】按伤害事件：至少一方实承>0 → 触发一次，两人各回 1
    let r1 = hitRaw(base, 'xiaoyu', 5);
    expect(r1.state.pendingDecision?.kind).toBe('choose_share_high');
    let s1 = resolveNow(r1.state, { highTaker: 'xiaoyu' });
    expect(s1.characters['xiaoyu']?.hp).toBe(3); // 5-3+1（一次触发）
    expect(s1.characters['liya']?.hp).toBe(4); // 5-2+1
    // 高份给莉雅：小鱼 2、莉雅 3
    let r2 = hitRaw(base, 'xiaoyu', 5);
    let s2 = resolveNow(r2.state, { highTaker: 'liya' });
    expect(s2.characters['xiaoyu']?.hp).toBe(4); // 5-2+1
    expect(s2.characters['liya']?.hp).toBe(3); // 5-3+1
    // 偶数 4：免询问各半
    let r3 = hitRaw(base, 'xiaoyu', 4);
    expect(r3.state.pendingDecision).toBeNull();
    expect(r3.state.characters['xiaoyu']?.hp).toBe(4); // 5-2+1
    expect(r3.state.characters['liya']?.hp).toBe(4); // 5-2+1
  });

  it('TC-CB-016 分摊后各自再减免；双方均 0 伤不触发羁-01 回血【§9.6】【§11】【裁A-30】【裁A-47】', () => {
    // a) 莉雅持装-01：5 点高份给莉雅 → 莉雅 3-1=2、小鱼 2
    let base = freshGame();
    base = setBond(base, 'xiaoyu', 'liya', 'bond-01');
    base = giveEquipment(base, 'liya', 'equip-01');
    base = mut(base, (d) => {
      d.characters['liya']!.scene = 'human_city';
    });
    let r1 = hitRaw(base, 'xiaoyu', 5);
    let s1 = resolveNow(r1.state, { highTaker: 'liya' });
    expect(s1.characters['liya']?.hp).toBe(4); // 5-(3-1)+1【裁A-47 一次触发】
    expect(s1.characters['xiaoyu']?.hp).toBe(4); // 5-2+1
    // b) 双方均减至 0 → 不回血：小鱼鱼-04(-2)；莉雅装-01(-1)+公爵威严(-2，羁-01 持卡)
    let s2 = freshGame();
    s2 = setBond(s2, 'xiaoyu', 'liya', 'bond-01');
    s2 = giveEquipment(s2, 'liya', 'equip-01');
    s2 = ensureCard(s2, 'xiaoyu', 'yu-04');
    s2 = mut(s2, (d) => {
      d.characters['liya']!.scene = 'human_city';
      d.characters['kaier']!.scene = 'human_city';
    });
    s2 = playPassCopy(s2, 'xiaoyu', 'yu-04'); // 王城场景 -2
    const heal0 = evs(s2, 'character_healed').length;
    let r2 = hitRaw(s2, 'xiaoyu', 2); // 各半 1/1 → 小鱼 1-2=0；莉雅 1-1-2=0
    let after = r2.state;
    if (after.pendingDecision?.kind === 'choose_share_high') after = resolveNow(after, { highTaker: 'xiaoyu' });
    expect(after.characters['xiaoyu']?.hp).toBe(5);
    expect(after.characters['liya']?.hp).toBe(5);
    expect(evs(after, 'character_healed').length - heal0).toBe(0);
  });

  it('TC-CB-017 多重代受：玩家定承受者、按承受者减免链【§11】【裁A-29】', () => {
    let s = freshGame();
    s = giveEquipment(s, 'kaier', 'equip-01');
    // 凯-07：凯尔代受莉雅下一次伤害
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-07');
    s = playPassCopy(s, 'kaier', 'kai-07', { characters: ['liya'] });
    // 羁-09 主动：巴爷代受莉雅下一次（其 -2 减免另测，此处只测承受者选择与减免归属）
    s = setBond(s, 'liya', 'baye', 'bond-09');
    s = giveTurn(s, 'baye');
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-09'))!.cardUid!;
    s = applyCommand(s, { type: 'bond_active', character: 'baye', bondUid }).state;
    // 对莉雅造成 4 点 → 多代受决策 → 选凯尔承受（按凯尔减免链 -1）
    let r = hitRaw(s, 'liya', 4);
    expect(r.state.pendingDecision?.kind).toBe('choose_redirect');
    const cands = (r.state.pendingDecision!.options as { candidates: Array<{ buffId: string; guardian: string }> }).candidates;
    const kaiBuff = cands.find((c) => c.guardian === 'kaier')!;
    let s2 = resolveNow(r.state, { buffId: kaiBuff.buffId });
    expect(s2.characters['kaier']?.hp).toBe(2); // 4-1（凯尔装-01）
    expect(s2.characters['liya']?.hp).toBe(5);
    expect(s2.characters['baye']?.hp).toBe(5);
  });

  it('TC-CB-018 巴-05「失去生命」不入链：不可代受不可减免【§9.4】【§11】【裁A-29】', () => {
    let s = freshGame();
    s = giveTurn(s, 'baye', 3);
    s = ensureCard(s, 'baye', 'ba-03');
    s = ensureCard(s, 'baye', 'ba-05');
    s = playPassCopy(s, 'baye', 'ba-03'); // 本轮 -2 减免；AP 3→2
    // 凯-07 代受巴爷下一次伤害（须同场景：凯尔摆至人类王城）
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-07');
    s = mut(s, (d) => {
      d.characters['kaier']!.scene = 'human_city';
    });
    s = playPassCopy(s, 'kaier', 'kai-07', { characters: ['baye'] });
    // 巴爷无装备 → 失去 1 血 +2 AP（不可减免、不可代受）；直接交还回合不断 AP
    s = mut(s, (d) => {
      d.currentTurn = { character: 'baye' };
    });
    const hp0 = s.characters['baye']!.hp;
    s = playPassCopy(s, 'baye', 'ba-05');
    expect(s.characters['baye']?.hp).toBe(hp0 - 1); // 未被 -2 减免、未被凯-07 代受
    expect(s.characters['baye']?.ap).toBe(3); // 3-1(ba03)-1(ba05)+2
    expect(s.buffs.some((b) => b.kind === 'guard')).toBe(true); // 代受 buff 未被消耗
  });

  it('TC-CB-019 公爵威严：同场景精灵 -1；已与人类结羁绊并持卡 → -2【§1.2】【L338-339】【C8】【裁A-04】', () => {
    // a) 莉雅未与人类结羁绊 → -1
    let a = hit(freshGame(), 'liya', 3);
    expect(a.characters['liya']?.hp).toBe(3); // 5-2
    // b) 莉雅与巴爷结羁-09（持卡）→ -2
    let b = setBond(freshGame(), 'liya', 'baye', 'bond-09');
    b = hit(b, 'liya', 3);
    expect(b.characters['liya']?.hp).toBe(4); // 5-1
    // c) 羁-02 替换后同样成立
    let c = setBond(freshGame(), 'xiaoyu', 'liya', 'bond-02', { replaced: true });
    c = hit(c, 'liya', 3);
    expect(c.characters['liya']?.hp).toBe(4); // 5-1
  });
});

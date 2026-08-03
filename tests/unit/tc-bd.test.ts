/**
 * TC-BD 偏见与羁绊 回归用例（docs/qa/test-cases.md）。
 * 注：标记【预期失败=引擎 bug】的断言按冻结规格书写，失败即缺陷报告（QA 不改引擎）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../engine/src/actions.js';
import { dealDamageToBoss, dealDamageToCrisis } from '../../engine/src/systems/combat.js';
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
} from '../helpers/regression-utils.js';
import type { CharacterId, GameEvent, GameState } from '../../engine/src/types.js';

function giveTurn(s: GameState, c: CharacterId, ap = 3): GameState {
  return mut(s, (d) => {
    d.currentTurn = { character: c };
    d.characters[c]!.ap = ap;
  });
}

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

function hitRaw(s: GameState, target: CharacterId, base: number): GameState {
  return hit(s, target, base);
}

function resolveNow(s: GameState, choice: unknown): GameState {
  return applyCommand(s, { type: 'resolve_decision', decisionId: s.pendingDecision!.id, choice }).state;
}

/** 摆盘：指定角色同场景（偏见触发对布景） */
function colocate(s: GameState, chars: CharacterId[], scene: GameState['turnOrder'][number] extends never ? never : import('../../engine/src/types.js').SceneId): GameState {
  return mut(s, (d) => {
    for (const c of chars) d.characters[c]!.scene = scene;
  });
}

describe('TC-BD 偏见与羁绊', () => {
  it('TC-BD-001 可触发对枚举：仅 小鱼×凯尔/巴爷×莉雅/巴爷×凯尔【§5.3】【L149-153】', () => {
    // 小鱼×凯尔 同场景 → 翻
    let a = freshGame();
    a = clearCrises(a);
    a = colocate(a, ['xiaoyu', 'kaier'], 'elf_kingdom');
    const beforeA = a.log.length;
    a = passRound(a);
    const flipsA = a.log.slice(beforeA).filter((e) => e.kind === 'prejudice_flipped');
    expect(flipsA.length).toBe(1);
    // 小鱼×巴爷（同族）→ 不翻；凯尔×莉雅（已激活羁绊）→ 不翻
    let b = freshGame();
    b = clearCrises(b);
    b = colocate(b, ['xiaoyu', 'baye'], 'human_city');
    const beforeB = b.log.length;
    b = passRound(b);
    expect(b.log.slice(beforeB).filter((e) => e.kind === 'prejudice_flipped')).toHaveLength(0);
    // 巴爷×莉雅 / 巴爷×凯尔
    let c = freshGame();
    c = clearCrises(c);
    c = colocate(c, ['baye', 'liya'], 'elf_kingdom');
    const beforeC = c.log.length;
    c = passRound(c);
    expect(c.log.slice(beforeC).filter((e) => e.kind === 'prejudice_flipped').length).toBe(1);
    let d = freshGame();
    d = clearCrises(d);
    d = colocate(d, ['baye', 'kaier'], 'elf_kingdom');
    const beforeD = d.log.length;
    d = passRound(d);
    expect(d.log.slice(beforeD).filter((e) => e.kind === 'prejudice_flipped').length).toBe(1);
  });

  it('TC-BD-002 小鱼×莉雅 任何状态不触发偏见（含未激活期）【§5.3】【L153】【§6.3】', () => {
    let s = freshGame();
    s = clearCrises(s);
    // 小鱼×莉雅同场景；其余角色调开（排除巴爷×莉雅等其他触发对干扰）
    s = colocate(s, ['xiaoyu', 'liya'], 'human_city');
    s = mut(s, (d) => {
      d.characters['baye']!.scene = 'dark_valley';
    });
    const before = s.log.length;
    s = passRound(s);
    expect(s.log.slice(before).filter((e) => e.kind === 'prejudice_flipped')).toHaveLength(0);
  });

  it('TC-BD-003 每场景每轮偏见翻牌 ≤1【§5.3】【L141-142】', () => {
    let s = freshGame();
    s = clearCrises(s);
    // 同场景两对可触发对：小鱼×凯尔 + 巴爷×凯尔? 凯尔唯一——用 小鱼×凯尔 与 巴爷×莉雅 同场景
    s = colocate(s, ['xiaoyu', 'kaier', 'baye', 'liya'], 'elf_kingdom');
    const before = s.log.length;
    s = passRound(s);
    const flips = s.log.slice(before).filter((e) => e.kind === 'prejudice_flipped');
    expect(flips.length).toBe(1); // 该场景仅 1 张
  });

  it('TC-BD-004 多对同在：玩家选定触发对（pendingDecision）【§5.3】【L142】', () => {
    let s = freshGame();
    s = clearCrises(s);
    s = colocate(s, ['xiaoyu', 'kaier', 'baye', 'liya'], 'elf_kingdom');
    s = passTurn(s);
    s = passTurn(s);
    s = passTurn(s);
    s = applyCommand(s, { type: 'end_turn', character: 'baye' }).state;
    expect(s.pendingDecision?.kind).toBe('choose_option'); // 触发对选择
    const opts = (s.pendingDecision!.options as { options: Array<{ id: string }> }).options.map((o) => o.id);
    expect(opts.length).toBeGreaterThanOrEqual(2);
    s = resolveNow(s, { option: opts.find((o) => o.includes('baye') && o.includes('liya')) ?? opts[0]! });
    const leads = s.bondLeads;
    expect(leads.length).toBe(1);
    expect(leads[0]!.pair.join('|')).toContain('baye');
  });

  it('TC-BD-005 bondLead 跨轮有效【§5.3】【裁A-16】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    s = mut(s, (d) => {
      d.bondLeads.push({ pair: ['kaier', 'xiaoyu'], crisisUid: uid });
    });
    // 跨一轮后再共同击败
    s = passRound(s);
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom';
    });
    const ev1: GameEvent[] = [];
    dealDamageToCrisis(s, ev1, uid, 1, 'xiaoyu');
    const ev2: GameEvent[] = [];
    dealDamageToCrisis(s, ev2, uid, 1, 'kaier');
    const ev3: GameEvent[] = [];
    dealDamageToCrisis(s, ev3, uid, 4, 'xiaoyu'); // 小鱼清除（双方均有轨迹）
    expect(s.pendingDecision?.kind).toBe('choose_bond_card');
  });

  it('TC-BD-006 结成（偏见路径）：双方均 ≥1 伤害轨迹 + 其中一人清除【§5.3】【L143-145】', () => {
    // a) 仅小鱼造成伤害并清除 → 不结成
    let a = freshGame();
    a = putCrisis(a, 'crisis-10', 'elf_kingdom');
    const uidA = crisisIn(a, 'elf_kingdom', 'crisis-10')[0]!;
    a = mut(a, (d) => {
      d.bondLeads.push({ pair: ['kaier', 'xiaoyu'], crisisUid: uidA });
    });
    const evA: GameEvent[] = [];
    dealDamageToCrisis(a, evA, uidA, 6, 'xiaoyu');
    expect(a.pendingDecision?.kind ?? 'none').not.toBe('choose_bond_card');
    expect(a.bonds.some((x) => x.pair.includes('kaier') && x.pair.includes('xiaoyu'))).toBe(false);
    // b) 双方各 ≥1 伤害、小鱼清除 → 结成
    let b = freshGame();
    b = putCrisis(b, 'crisis-10', 'elf_kingdom');
    const uidB = crisisIn(b, 'elf_kingdom', 'crisis-10')[0]!;
    b = mut(b, (d) => {
      d.bondLeads.push({ pair: ['kaier', 'xiaoyu'], crisisUid: uidB });
    });
    const ev1: GameEvent[] = [];
    dealDamageToCrisis(b, ev1, uidB, 2, 'kaier');
    const ev2: GameEvent[] = [];
    dealDamageToCrisis(b, ev2, uidB, 4, 'xiaoyu');
    expect(b.pendingDecision?.kind).toBe('choose_bond_card');
  });

  it('TC-BD-007 bondLead 失效：第三方清除【§5.3】【裁A-16】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    s = mut(s, (d) => {
      d.bondLeads.push({ pair: ['kaier', 'xiaoyu'], crisisUid: uid });
    });
    const ev1: GameEvent[] = [];
    dealDamageToCrisis(s, ev1, uid, 6, 'liya'); // 第三方莉雅单独清除
    expect(s.bondLeads).toHaveLength(0); // 关联失效
    expect(s.bonds.some((x) => x.pair.includes('kaier') && x.pair.includes('xiaoyu'))).toBe(false);
  });

  it('TC-BD-008 非伤害离场（羁-05 守护弃置）不产生清除、不成立结成【§5.3】【裁A-16】【裁A-09】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'liya', 'bond-05');
    s = mut(s, (d) => {
      d.sceneWards['elf_kingdom'] = 1;
      d.bondLeads.push({ pair: ['kaier', 'xiaoyu'], crisisUid: 'crisis-01#99' }); // 指向未在场卡
    });
    // 守护弃置一张新放置卡：直接调用放置流程
    const uid = s.decks.crisis[0]!;
    s = mut(s, (d) => {
      d.decks.crisis.shift();
      d.decks.crisisDiscard.push(uid); // 模拟守护弃置（placeCrisis 的 ward 分支见 TC-CB-007）
    });
    // 该对不可通过被弃置的卡结成（场上无此卡 → 无法共同击败）
    expect(s.bonds.some((x) => x.pair.includes('kaier') && x.pair.includes('xiaoyu'))).toBe(false);
    expect(crisisIn(s, 'elf_kingdom')).not.toContain(uid);
  });

  it('TC-BD-009 羁-08 同族补充路径：小鱼×巴爷同场景共同清除任意危机卡【§5.3】【§6.3】【裁A-03】', () => {
    // a) 双方均造成伤害、小鱼清除 → 结成（候选含羁-08）
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'human_city');
    const uid = crisisIn(s, 'human_city', 'crisis-10')[0]!;
    const ev1: GameEvent[] = [];
    dealDamageToCrisis(s, ev1, uid, 2, 'baye');
    const ev2: GameEvent[] = [];
    dealDamageToCrisis(s, ev2, uid, 4, 'xiaoyu');
    expect(s.pendingDecision?.kind).toBe('choose_bond_card');
    const cands = (s.pendingDecision!.options as { candidateUids: string[] }).candidateUids;
    expect(cands.some((u) => u.startsWith('bond-08'))).toBe(true);
    s = resolveNow(s, { cardUid: cands.find((u) => u.startsWith('bond-08'))! });
    const bond = s.bonds.find((x) => x.pair.includes('xiaoyu') && x.pair.includes('baye'));
    expect(bond?.status).toBe('active');
    expect(s.cards[bond!.cardUid!]?.defId).toBe('bond-08');
    // b) 仅小鱼伤害并清除 → 不结成
    let b = freshGame();
    b = putCrisis(b, 'crisis-10', 'human_city');
    const uidB = crisisIn(b, 'human_city', 'crisis-10')[0]!;
    const ev3: GameEvent[] = [];
    dealDamageToCrisis(b, ev3, uidB, 6, 'xiaoyu');
    expect(b.bonds.some((x) => x.pair.includes('xiaoyu') && x.pair.includes('baye'))).toBe(false);
  });

  it('TC-BD-010 结成结算与选卡范围：专属+通用 03/04/05（05 仅人类×精灵）【§5.3】【L143-145】【裁A-18】', () => {
    // 巴爷×莉雅（人类×精灵）：候选 = 羁-09 + 03/04/05
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    s = mut(s, (d) => {
      d.bondLeads.push({ pair: ['baye', 'liya'], crisisUid: uid });
      d.characters['baye']!.scene = 'elf_kingdom';
    });
    const ev1: GameEvent[] = [];
    dealDamageToCrisis(s, ev1, uid, 3, 'baye');
    const ev2: GameEvent[] = [];
    dealDamageToCrisis(s, ev2, uid, 3, 'liya');
    const cands = ((s.pendingDecision!.options as { candidateUids: string[] }).candidateUids).map((u) => s.cards[u]?.defId);
    expect(cands).toContain('bond-09');
    expect(cands).toContain('bond-03');
    expect(cands).toContain('bond-04');
    expect(cands).toContain('bond-05');
    // 小鱼×巴爷（同族）：候选 = 羁-08 + 03/04（无 05）
    let b = freshGame();
    b = putCrisis(b, 'crisis-10', 'human_city');
    const uidB = crisisIn(b, 'human_city', 'crisis-10')[0]!;
    const ev3: GameEvent[] = [];
    dealDamageToCrisis(b, ev3, uidB, 3, 'baye');
    const ev4: GameEvent[] = [];
    dealDamageToCrisis(b, ev4, uidB, 3, 'xiaoyu');
    const candsB = ((b.pendingDecision!.options as { candidateUids: string[] }).candidateUids).map((u) => b.cards[u]?.defId);
    expect(candsB).toContain('bond-08');
    expect(candsB).toContain('bond-03');
    expect(candsB).toContain('bond-04');
    expect(candsB).not.toContain('bond-05');
    // 结成后该对不再触发偏见 + 双方各 1 金指示物
    let s2 = resolveNow(b, { cardUid: (b.pendingDecision!.options as { candidateUids: string[] }).candidateUids[0]! });
    expect(s2.characters['xiaoyu']?.bondTokens).toBe(1);
    expect(s2.characters['baye']?.bondTokens).toBe(1);
  });

  it('TC-BD-011 初始羁绊：凯尔×莉雅 默认激活锁羁-07【§5.3】【裁A-18】', () => {
    const s = freshGame();
    const kl = s.bonds.find((b) => b.pair.includes('kaier') && b.pair.includes('liya'));
    expect(kl?.status).toBe('active');
    expect(s.cards[kl!.cardUid!]?.defId).toBe('bond-07');
  });

  it('TC-BD-012 小鱼×莉雅 传书激活：2 次成功传书发羁-01（方向不限、锁定）【§5.3】【裁A-23】【裁A-44】【裁A-18】', () => {
    let s = freshGame();
    s = mut(s, (d) => {
      d.flags.xiaoyuLiyaLetters = 1; // 已有 1 次（小鱼→莉雅）
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    s = passTurn(s); // 小鱼结束 → 莉雅 TURN_START 收信 → 计数 2
    const bond = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(bond?.status).toBe('active');
    expect(s.cards[bond!.cardUid!]?.defId).toBe('bond-01');
  });

  it('TC-BD-013 羁绊三态谓词时序（formed/active/hasCard）【§6.3】', () => {
    // 开局：formed=true, active=false, hasCard=false
    let s = freshGame();
    let bond = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(bond !== undefined).toBe(true); // formed
    expect(bond?.status).toBe('inactive'); // !active
    expect(bond?.cardUid).toBeNull(); // !hasCard
    // 2 次传书后：三值全 true（羁-01）
    s = mut(s, (d) => {
      d.flags.xiaoyuLiyaLetters = 1;
      d.characters['liya']!.pendingLetter = { cardUid: d.characters['xiaoyu']!.hand[0]!, from: 'xiaoyu' };
    });
    s = passTurn(s);
    bond = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(bond?.status).toBe('active');
    expect(bond?.cardUid).toMatch(/^bond-01#/);
    // 失控后：三值全 true（羁-02 终态）
    s = setErosion(s, 4);
    bond = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(bond?.status).toBe('active');
    expect(bond?.cardUid).toMatch(/^bond-02#/);
    expect(bond?.replacedByBerserk).toBe(true);
  });

  it('TC-BD-014 失控替换羁-02：未激活直接发卡激活；已持羁-01 则替换【§5.3】【L153, L261】【裁A-04】', () => {
    // a) 未激活 → 直接发羁-02 激活
    let a = freshGame();
    a = setErosion(a, 4);
    const bondA = a.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(bondA?.status).toBe('active');
    expect(a.cards[bondA!.cardUid!]?.defId).toBe('bond-02');
    expect(bondA?.replacedByBerserk).toBe(true);
    // b) 已持羁-01 → 替换为羁-02
    let b = setBond(freshGame(), 'xiaoyu', 'liya', 'bond-01');
    b = setErosion(b, 4);
    const bondB = b.bonds.find((x) => x.pair.includes('xiaoyu') && x.pair.includes('liya'));
    expect(b.cards[bondB!.cardUid!]?.defId).toBe('bond-02');
    expect(evs(b, 'bond_replaced').length).toBeGreaterThanOrEqual(1);
  });

  it('TC-BD-015 羁-02 终态不回退；主动自发卡当轮起每轮限 1【§5.3】【裁A-04】', () => {
    let s = freshGame();
    s = setErosion(s, 4);
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-02'))!.cardUid!;
    // 当轮即可由莉雅发动（activeUsedRound 已重置）
    s = giveTurn(s, 'liya');
    s = applyCommand(s, { type: 'bond_active', character: 'liya', bondUid }).state;
    expect(s.characters['xiaoyu']?.erosion).toBe(3);
    // 本轮再发动拒绝
    expect(() => applyCommand(s, { type: 'bond_active', character: 'liya', bondUid })).toThrow(/限/);
    // 脱离失控后保持羁-02（不回退羁-01）
    s = setErosion(s, 3);
    const bond = s.bonds.find((b) => b.pair.includes('xiaoyu') && b.pair.includes('liya'));
    expect(s.cards[bond!.cardUid!]?.defId).toBe('bond-02');
    expect(bond?.replacedByBerserk).toBe(true);
  });

  it('TC-BD-016 羁-02 计入已激活羁绊：公爵威严翻倍、宝玉共鸣认可【§5.3】【§7.4】【C8】【裁A-04】', () => {
    // 公爵威严 -2（羁-02 持卡）
    let a = freshGame();
    a = setBond(a, 'xiaoyu', 'liya', 'bond-02', { replaced: true });
    a = hit(a, 'liya', 3);
    expect(a.characters['liya']?.hp).toBe(4); // 3-2=1
    // 宝玉共鸣可用（羁-02 算已激活）
    let b = toBattle(freshGame(), (d) => {
      d.bonds = [{ pair: ['xiaoyu', 'liya'], status: 'active', cardUid: 'bond-02#0', replacedByBerserk: true, activeUsedRound: null }];
    });
    b = giveTurn(b, 'liya', 2);
    b = applyCommand(b, { type: 'gem_attune', character: 'liya' }).state;
    expect(b.boss?.gemPurify).toBe(1);
  });

  it('TC-BD-017 凯-05 与偏见限额：相互独立两条限额（P3×1 + 凯-05×1），场景每轮最多 2 张【§9.3】【§5.3】【裁A-17】【裁A-45】', () => {
    // a)【裁A-45】凯-05 翻后，该场景本轮 P3 仍可翻（独立限额）
    let a = freshGame();
    a = clearCrises(a);
    a = colocate(a, ['xiaoyu', 'kaier'], 'elf_kingdom'); // 保证 P3 有触发对
    a = giveTurn(a, 'kaier');
    a = ensureCard(a, 'kaier', 'kai-05');
    a = playPassCopy(a, 'kaier', 'kai-05');
    expect(crisisIn(a, 'elf_kingdom').length).toBe(1); // 凯-05 翻 1 张
    const beforeA = a.log.length;
    a = passRound(a);
    expect(a.log.slice(beforeA).filter((e) => e.kind === 'prejudice_flipped')).toHaveLength(1); // P3 独立限额再翻 1
    expect(crisisIn(a, 'elf_kingdom').length).toBe(2); // 场景每轮最多 2 张
    // b)【裁A-45】P3 先翻 → 凯-05 仍可翻（相互独立，原裁Q1 方向）
    let b = freshGame();
    b = clearCrises(b);
    b = mut(b, (d) => {
      d.roundUsage['prejudice:elf_kingdom'] = true; // 模拟 P3 已翻
    });
    b = giveTurn(b, 'kaier');
    b = ensureCard(b, 'kaier', 'kai-05');
    b = playPassCopy(b, 'kaier', 'kai-05');
    expect(crisisIn(b, 'elf_kingdom').length).toBe(1); // 凯-05 独立限额翻出
    // c) 同轮凯-05 第二次拒绝（凯-05 自身每轮限 1）
    b = ensureCard(b, 'kaier', 'kai-05');
    expect(() => playRaw(b, 'kaier', 'kai-05')).toThrow(/限/);
  });

  it('TC-BD-018 凯-05 翻出的卡记为偏见卡：凯尔与同场景未结羁绊人类共同清除 → 结成【§9.3】【裁A-17】', () => {
    let s = freshGame();
    s = clearCrises(s); // 清除 P1 翻的牌（D1 翻 2 张可能干扰偏见卡判定，危机度=4→3 伤害打不掉）
    s = mut(s, (d) => {
      d.characters['baye']!.scene = 'elf_kingdom'; // 未结羁绊人类先就位（凯-05 翻卡时记录偏见卡）
    });
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-05');
    s = playPassCopy(s, 'kaier', 'kai-05');
    const uid = crisisIn(s, 'elf_kingdom')[0]!;
    expect(s.bondLeads.some((l) => l.crisisUid === uid)).toBe(true); // 已记为偏见卡
    // 双方各造成 ≥1 伤害，凯尔清除
    const ev1: GameEvent[] = [];
    dealDamageToCrisis(s, ev1, uid, 1, 'baye');
    const ev2: GameEvent[] = [];
    dealDamageToCrisis(s, ev2, uid, 99, 'kaier');
    expect(s.pendingDecision?.kind).toBe('choose_bond_card');
    const cands = (s.pendingDecision!.options as { candidateUids: string[] }).candidateUids.map((u) => s.cards[u]?.defId);
    expect(cands).toContain('bond-06'); // 凯尔×巴爷 专属
  });

  it('TC-BD-019 羁绊主动：0 AP、双方均可用、每轮限 1；被动永久【§5.3】【L144】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'baye', 'bond-08');
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-08'))!.cardUid!;
    const ap0 = s.characters['xiaoyu']!.ap;
    s = applyCommand(s, { type: 'bond_active', character: 'xiaoyu', bondUid }).state;
    expect(s.characters['xiaoyu']?.ap).toBe(ap0); // 0 AP
    // 本轮（同轮次计数）巴爷再发动拒绝（同一羁绊卡每轮限 1）
    s = giveTurn(s, 'baye');
    expect(() => applyCommand(s, { type: 'bond_active', character: 'baye', bondUid })).toThrow(/限/);
    // 下一轮可用
    s = passRound(s);
    s = giveTurn(s, 'baye');
    expect(() => applyCommand(s, { type: 'bond_active', character: 'baye', bondUid })).not.toThrow();
  });

  it('TC-BD-020 羁-01 主动：双方立即各恢复2点生命值并各抽一张牌【§9.6】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'liya', 'bond-01');
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-01'))!.cardUid!;
    // 先让双方低于满血以验证治疗
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.hp = 3;
      d.characters['liya']!.hp = 3;
    });
    const beforeHandX = s.characters['xiaoyu']!.hand.length;
    const beforeHandL = s.characters['liya']!.hand.length;
    s = giveTurn(s, 'xiaoyu');
    s = applyCommand(s, { type: 'bond_active', character: 'xiaoyu', bondUid }).state;
    // 双方各回 2 血
    expect(s.characters['xiaoyu']?.hp).toBe(5);
    expect(s.characters['liya']?.hp).toBe(5);
    // 双方各抽 1 张牌
    expect(s.characters['xiaoyu']!.hand.length).toBe(beforeHandX + 1);
    expect(s.characters['liya']!.hand.length).toBe(beforeHandL + 1);
    // 本轮再发动拒绝
    s = giveTurn(s, 'liya');
    expect(() => applyCommand(s, { type: 'bond_active', character: 'liya', bondUid })).toThrow(/限/);
  });

  it('TC-BD-021 羁-07 复制：全类型可复制、复合卡按任一类型、数值减半向下取整【§9.6】【裁A-32】', () => {
    // a) 攻击卡复制：凯-02（4）→ 2；雅-01（3）→ 1（floor）
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-02');
    s = ensureCard(s, 'liya', 'ya-01'); // 莉雅持攻击卡
    let r = playRaw(s, 'kaier', 'kai-02', { crisisUids: [uid] });
    expect(r.state.pendingDecision?.kind).toBe('choose_option');
    let s2 = resolveNow(r.state, { option: 'copy' });
    if (s2.pendingDecision?.kind === 'choose_cards') s2 = settle(s2);
    const total = evs(s2, 'crisis_damaged').filter((e) => e.cardUid === uid).reduce((n, e) => n + (e as { amount: number }).amount, 0);
    expect(total).toBe(4 + 2);
    // b) 复合卡（雅-10 移动/特殊）按第一或第二类型均可复制：莉雅打雅-10，凯尔弃移动卡复制
    let b = freshGame();
    b = giveTurn(b, 'liya');
    b = ensureCard(b, 'liya', 'ya-10');
    b = ensureCard(b, 'kaier', 'kai-03'); // 凯尔持移动卡
    b = mut(b, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom'; // 小鱼已在同场景 → 雅-10 不移位，复制询问正常触发
    });
    let rb = playRaw(b, 'liya', 'ya-10', {});
    expect(rb.state.pendingDecision?.kind).toBe('choose_option'); // 复合卡可按移动类型复制
  });

  it('TC-BD-022-a 羁-06 共享：凯尔装备减免→巴爷；巴爷装备攻击加成→凯尔；一次性即时不共享【§9.6】【裁A-31】', () => {
    let s = freshGame();
    s = setBond(s, 'kaier', 'baye', 'bond-06');
    s = giveEquipment(s, 'kaier', 'equip-01'); // 凯尔 -1
    s = giveEquipment(s, 'baye', 'equip-02'); // 巴爷 +1
    s = colocate(s, ['kaier', 'baye'], 'elf_kingdom');
    // 巴爷受 3 点 → 享凯尔装-01 → 2
    s = hit(s, 'baye', 3);
    expect(s.characters['baye']?.hp).toBe(3); // 5-2
    // 凯尔攻击享巴爷装-02 +1：凯-02 基础 4 → 5
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-02');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    const r = playRaw(s, 'kaier', 'kai-02', { crisisUids: [uid] });
    expect((r.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(5);
    // 反向不共享：巴爷的减免（巴-03）不作用于凯尔
    let s2 = freshGame();
    s2 = setBond(s2, 'kaier', 'baye', 'bond-06');
    s2 = colocate(s2, ['kaier', 'baye'], 'elf_kingdom');
    s2 = giveTurn(s2, 'baye');
    s2 = ensureCard(s2, 'baye', 'ba-03');
    s2 = playPassCopy(s2, 'baye', 'ba-03'); // 巴爷本轮 -2
    s2 = hit(s2, 'kaier', 3);
    expect(s2.characters['kaier']?.hp).toBe(2); // 3 实受（方向相反不共享）
  });

  it('TC-BD-022-b 羁-06 持续 buff 减免类（装-01 主动）同样作用于巴爷【§9.6】【裁A-31】', () => {
    let s = freshGame();
    s = setBond(s, 'kaier', 'baye', 'bond-06');
    s = giveEquipment(s, 'kaier', 'equip-01');
    s = colocate(s, ['kaier', 'baye'], 'elf_kingdom');
    s = giveTurn(s, 'kaier');
    // 凯尔发动装-01 主动（本轮 -1 持续 buff，挂在凯尔身上）
    const eqUid = s.characters['kaier']!.equipment[0]!;
    s = applyCommand(s, { type: 'equipment_active', character: 'kaier', equipmentUid: eqUid }).state;
    s = hit(s, 'baye', 3);
    // 【预期失败=引擎 bug】A-31：持续 buff 减免应共享 → 巴爷 3-1(buff)-1(装备被动共享)=1，hp 4
    expect(s.characters['baye']?.hp).toBe(4);
  });

  it('TC-BD-023-a 羁-03：同场景各攻击 +1【§9.6】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'kaier', 'bond-03');
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    s = colocate(s, ['xiaoyu', 'kaier'], 'elf_kingdom');
    s = giveTurn(s, 'kaier');
    s = ensureCard(s, 'kaier', 'kai-02');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    const r = playRaw(s, 'kaier', 'kai-02', { crisisUids: [uid] });
    expect((r.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(5); // 4+1
  });

  it('TC-BD-023-b 羁-03 主动：双方立即各对当前场景一张危机卡造成2点伤害【§9.6】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'kaier', 'bond-03');
    s = putCrisis(s, 'crisis-01', 'human_city'); // xiaoyu 场景
    s = putCrisis(s, 'crisis-01', 'elf_kingdom'); // kaier 场景
    s = mut(s, (d) => {
      d.characters['kaier']!.scene = 'elf_kingdom';
    });
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-03'))!.cardUid!;
    s = giveTurn(s, 'xiaoyu');
    // 各场景危机总伤害
    const totalBefore1 = Object.values(s.scenes['human_city']!.crisisDamage).reduce((a, b) => a + b, 0);
    const totalBefore2 = Object.values(s.scenes['elf_kingdom']!.crisisDamage).reduce((a, b) => a + b, 0);
    s = applyCommand(s, { type: 'bond_active', character: 'xiaoyu', bondUid }).state;
    const totalAfter1 = Object.values(s.scenes['human_city']!.crisisDamage).reduce((a, b) => a + b, 0);
    const totalAfter2 = Object.values(s.scenes['elf_kingdom']!.crisisDamage).reduce((a, b) => a + b, 0);
    expect(totalAfter1).toBe(totalBefore1 + 2);
    expect(totalAfter2).toBe(totalBefore2 + 2);
  });

  it('TC-BD-024 羁-04：不同场景每人每轮第一次伤害 -1；主动交换位置【§9.6】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'baye', 'bond-04'); // 小鱼王城、巴爷王城→摆巴爷去黑暗山谷（不同场景）
    s = mut(s, (d) => {
      d.characters['baye']!.scene = 'dark_valley';
    });
    s = hit(s, 'baye', 3);
    expect(s.characters['baye']?.hp).toBe(3); // 首次 3-1=2
    s = hit(s, 'baye', 3);
    expect(s.characters['baye']?.hp).toBe(0); // 第二次不减：3-... 等下 hp 3-3=0 → 出局
    // 主动交换位置
    let b = freshGame();
    b = setBond(b, 'xiaoyu', 'baye', 'bond-04');
    b = mut(b, (d) => {
      d.characters['baye']!.scene = 'dark_valley';
    });
    const bondUid = b.bonds.find((x) => x.cardUid?.startsWith('bond-04'))!.cardUid!;
    b = applyCommand(b, { type: 'bond_active', character: 'xiaoyu', bondUid }).state;
    expect(b.characters['xiaoyu']?.scene).toBe('dark_valley');
    expect(b.characters['baye']?.scene).toBe('human_city');
  });

  it('TC-BD-025 羁-05：同场景不再触发偏见；清除额外 +1 材料（需参与者）；主动弃置下次危机卡【§9.6】【裁A-09】', () => {
    // 清除额外 +1（参与者）
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'liya', 'bond-05');
    s = putCrisis(s, 'crisis-08', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = playCardById(s, 'xiaoyu', 'yu-01', { crisisUids: [crisisIn(s, 'human_city', 'crisis-08')[0]!] });
    expect(s.characters['xiaoyu']?.materialTokens).toBe(2); // 基础 1 + 羁-05 额外 1
    // 主动弃置（见 TC-CB-007）；非参与者不加
    let b = freshGame();
    b = setBond(b, 'xiaoyu', 'liya', 'bond-05');
    b = putCrisis(b, 'crisis-08', 'elf_kingdom');
    b = giveTurn(b, 'kaier');
    b = ensureCard(b, 'kaier', 'kai-02');
    b = playPassCopy(b, 'kaier', 'kai-02', { crisisUids: [crisisIn(b, 'elf_kingdom', 'crisis-08')[0]!] });
    expect(b.characters['kaier']?.materialTokens).toBe(1); // 凯尔非羁-05 成员，仅基础 1
  });

  it('TC-BD-026-a 羁-08 主动：本轮两人攻击伤害各 +2【§9.6】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'baye', 'bond-08');
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-08'))!.cardUid!;
    s = applyCommand(s, { type: 'bond_active', character: 'xiaoyu', bondUid }).state;
    s = putCrisis(s, 'crisis-10', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    const uid = crisisIn(s, 'human_city', 'crisis-10')[0]!;
    const r = playRaw(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] });
    expect((r.events.find((e) => e.kind === 'crisis_damaged') as { amount: number })?.amount).toBe(5); // 3+0(屠龙者已不适用危机卡)+2(羁-08)
  });

  it('TC-BD-026-b 羁-08 被动：同场景合力清除 1 张危机卡后各恢复 1 点生命【§9.6】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'baye', 'bond-08');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.hp = 3;
      d.characters['baye']!.hp = 2;
    });
    s = putCrisis(s, 'crisis-01', 'human_city'); // 危机度 4，需要 ≥4 点才能清除
    const uid = crisisIn(s, 'human_city', 'crisis-01')[0]!;
    const ev1: GameEvent[] = [];
    dealDamageToCrisis(s, ev1, uid, 2, 'baye');
    const ev2: GameEvent[] = [];
    dealDamageToCrisis(s, ev2, uid, 2, 'xiaoyu'); // 合力清除（2+2=4）
    // 【预期失败=引擎 bug】被动：合力清除后双方各回 1
    expect(s.characters['xiaoyu']?.hp).toBe(4);
    expect(s.characters['baye']?.hp).toBe(3);
  });

  it('TC-BD-027-a 羁-09 被动：飞空艇携带莉雅到达后免费远程 2 点（每轮 ≤1）【§9.6】', () => {
    let s = freshGame();
    s = setBond(s, 'liya', 'baye', 'bond-09');
    s = putCrisis(s, 'crisis-10', 'dark_valley');
    s = mut(s, (d) => {
      d.characters['liya']!.scene = 'human_city'; // 与巴爷同出发场景
      d.currentTurn = { character: 'baye' };
      d.characters['baye']!.ap = 3;
    });
    const uid = crisisIn(s, 'dark_valley', 'crisis-10')[0]!;
    let r = applyCommand(s, { type: 'move', character: 'baye', to: 'dark_valley', via: 'airship', carry: 'liya' });
    expect(r.state.pendingDecision?.kind).toBe('choose_crisis'); // 免费远程询问
    let s2 = resolveNow(r.state, { cardUid: uid });
    expect(s2.scenes['dark_valley'].crisisDamage[uid]).toBe(2);
    expect(s2.characters['baye']?.ap).toBe(3); // 飞空艇不耗 AP
  });

  it('TC-BD-027-b 羁-09 主动：巴爷替莉雅承受下一次伤害且该伤害 -2【§9.6】', () => {
    let s = freshGame();
    s = setBond(s, 'liya', 'baye', 'bond-09');
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-09'))!.cardUid!;
    s = giveTurn(s, 'baye');
    s = applyCommand(s, { type: 'bond_active', character: 'baye', bondUid }).state;
    s = hit(s, 'liya', 4);
    // 【预期失败=引擎 bug】巴爷代受且伤害 -2 → 巴爷受 2（非 4）
    expect(s.characters['baye']?.hp).toBe(3);
    expect(s.characters['liya']?.hp).toBe(5);
  });

  it('TC-BD-028-a 羁-10 主动：本轮无论身处何处均可为对方分担一半伤害【§9.6】【裁A-30】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'kaier', 'bond-10');
    const bondUid = s.bonds.find((b) => b.cardUid?.startsWith('bond-10'))!.cardUid!;
    s = applyCommand(s, { type: 'bond_active', character: 'xiaoyu', bondUid }).state;
    // 不同场景（小鱼王城、凯尔精灵王国）也可分摊
    const r = hitRaw(s, 'kaier', 4); // 偶数免询问各半
    expect(r.characters['kaier']?.hp).toBe(3);
    expect(r.characters['xiaoyu']?.hp).toBe(3);
  });

  it('TC-BD-028-b 羁-10 被动：两人首次共同清除后各获 1 件免费锻造（仅 1 次、占持有上限）【§9.6】【L400】', () => {
    let s = freshGame();
    s = setBond(s, 'xiaoyu', 'kaier', 'bond-10');
    s = putCrisis(s, 'crisis-10', 'elf_kingdom');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-10')[0]!;
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom';
    });
    const ev1: GameEvent[] = [];
    dealDamageToCrisis(s, ev1, uid, 3, 'xiaoyu');
    const ev2: GameEvent[] = [];
    dealDamageToCrisis(s, ev2, uid, 3, 'kaier'); // 首次共同清除
    // 【预期失败=引擎 bug】应挂起免费装备选择（两人各 1 件、不耗材料与 AP）
    expect(s.pendingDecision?.kind).toBe('choose_equipment');
  });
});

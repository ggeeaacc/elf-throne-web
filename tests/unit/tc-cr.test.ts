/**
 * TC-CR 危机蔓延与危机卡 回归用例（docs/qa/test-cases.md）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand, beginGame } from '../../engine/src/actions.js';
import { dealDamageToCrisis } from '../../engine/src/systems/combat.js';
import {
  answer,
  cfg4,
  clearCrises,
  createInitialState,
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
  settle,
  sustain,
  toBattle,
  topCrisis,
} from '../helpers/regression-utils.js';
import type { GameEvent, GameState } from '../../engine/src/types.js';

/** 把当前回合直接摆给某角色（action 相位内） */
function giveTurn(s: GameState, c: GameState['turnOrder'][number], ap = 3): GameState {
  return mut(s, (d) => {
    d.currentTurn = { character: c };
    d.characters[c]!.ap = ap;
  });
}

describe('TC-CR 危机蔓延与危机卡', () => {
  it('TC-CR-001 P1 逐张翻开逐张结算、立即生效【§5.1】【L94】', () => {
    let s = freshGame();
    for (let r = 0; r < 3; r++) {
      s = passRound(s);
      s = sustain(s);
    }
    // 现在处于 R4（D2 清晨）action；过完整轮到 R5 期间会经 R5 P1（D2 黄昏翻 2 张）
    const before = s.log.length;
    s = passRound(s);
    const flips = s.log.slice(before).filter((e) => e.kind === 'crisis_flipped');
    expect(flips.length).toBe(2); // D2 黄昏 4P 翻 2（首张为通牒卡，见 TC-CR-002）
    // 逐张开逐张生效：两张均已在场上（翻开即放置）
    const total = Object.values(s.scenes).reduce((n, sc) => n + sc.crisisCards.length, 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it('TC-CR-002 D2 黄昏（R5）当日第 1 张固定为旁置通牒卡且计入数量【§5.1】【L69】', () => {
    let s0 = createInitialState(cfg4);
    const asideUid = s0.ultimatumAsideUid!;
    let s = settle(beginGame(s0).state);
    for (let r = 0; r < 4; r++) {
      s = passRound(s);
      s = sustain(s);
    }
    // 处于 R5 action → 说明 R5 P1 已翻完；查日志
    expect(s.phase.round).toBe(5);
    expect(s.phase.segment).toBe('dusk');
    const flips = evs(s, 'crisis_flipped');
    const r5flips = flips.slice(-2); // D2 黄昏翻 2 张
    expect(r5flips[0]?.cardUid).toBe(asideUid);
    expect(r5flips[0]?.scene).toBe('ancient_battlefield');
    expect(s.ultimatumAsideUid).toBeNull();
  });

  it('TC-CR-003 危机牌库耗尽→弃牌堆洗混重建【§5.1】【L95】', () => {
    let s0 = createInitialState(cfg4);
    s0 = mut(s0, (d) => {
      d.decks.crisisDiscard.push(...d.decks.crisis.splice(0)); // 牌库 0、弃牌堆 29
    });
    const r = beginGame(s0);
    expect(r.events.some((e) => e.kind === 'crisis_deck_reshuffled')).toBe(true);
    expect(r.state.decks.crisis.length).toBe(28); // 29 洗回后翻 1
  });

  it('TC-CR-004 通用卡落点：协商→本轮首位行动玩家定夺；落点立即生效【§5.1】【L93】', () => {
    let s0 = createInitialState(cfg4);
    s0 = topCrisis(s0, 'crisis-01'); // 通用卡置顶
    const r = beginGame(s0);
    expect(r.state.pendingDecision?.kind).toBe('place_crisis');
    expect(r.state.pendingDecision?.decider).toBe('xiaoyu'); // 本轮首位行动玩家
    const s = answer(r.state, { scene: 'dark_valley' });
    // D1 R1 4P 翻 2 张，第二张可能是通用或固定场景卡
    expect(crisisIn(s, 'dark_valley').length).toBeGreaterThanOrEqual(1);
    expect(evs(s, 'crisis_flipped')[0]?.scene).toBe('dark_valley');
  });

  it('TC-CR-005 P1 不做沦陷检查：翻至阈值不当场判负，P4③ 才判【§5.1】【裁A-19】【L157】', () => {
    let s = freshGame();
    s = clearCrises(s);
    s = putCrisis(s, 'crisis-01', 'human_city');
    s = putCrisis(s, 'crisis-01', 'human_city');
    s = putCrisis(s, 'crisis-01', 'human_city');
    s = topCrisis(s, 'crisis-01'); // 下一轮 P1 必翻通用卡
    s = passTurn(s);
    s = passTurn(s);
    s = passTurn(s);
    // 巴爷回合直接结束（不 settle，保留 P1 放置决策）
    s = applyCommand(s, { type: 'end_turn', character: 'baye' }).state;
    expect(s.pendingDecision?.kind).toBe('place_crisis');
    s = answer(s, { scene: 'human_city' }); // 第 4 张落 human_city
    expect(crisisIn(s, 'human_city').length).toBe(4);
    expect(s.result).toBeNull(); // P1 不判负
    s = passRound(s); // 进入 P4③
    expect(s.result?.outcome).toBe('defeat');
    expect(s.result?.reason).toContain('F2');
  });

  it('TC-CR-006 P3 偏见翻卡达阈值不当场判负，P4③ 才判【§5.3-5.4】【裁A-19】', () => {
    let s = freshGame();
    s = clearCrises(s);
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom'; // 小鱼×凯尔 同场景未结羁绊 → 触发对
    });
    const before = s.log.length;
    s = passRound(s);
    const slice = s.log.slice(before);
    const iPrej = slice.findIndex((e) => e.kind === 'prejudice_flipped');
    const iOver = slice.findIndex((e) => e.kind === 'game_over');
    expect(iPrej).toBeGreaterThanOrEqual(0); // P3 偏见翻出第 4 张
    expect(s.scenes['elf_kingdom'].crisisCards.length).toBe(4);
    expect(iOver).toBeGreaterThan(iPrej); // 判负发生在 P3 之后（P4③）
    expect(s.result?.reason).toContain('F2');
  });

  it('TC-CR-007 轮末效果放置当轮即触发【§5.4】【裁A-14】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-02', 'ancient_battlefield');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'ancient_battlefield';
    });
    const before = s.log.length;
    s = passRound(s); // 当轮 P4① 即结算危-02
    const dmg = s.log.slice(before).filter((e) => e.kind === 'character_damaged');
    expect(dmg.length).toBeGreaterThanOrEqual(1);
    expect(s.characters['xiaoyu']?.hp).toBe(4);
  });

  it('TC-CR-008 多张轮末效果同时触发由玩家定序【§5.4】【裁A-14】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-02', 'ancient_battlefield');
    s = putCrisis(s, 'crisis-05', 'dark_valley');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'ancient_battlefield';
      d.characters['baye']!.scene = 'dark_valley';
    });
    const uid02 = crisisIn(s, 'ancient_battlefield', 'crisis-02')[0]!;
    const uid05 = crisisIn(s, 'dark_valley', 'crisis-05')[0]!;
    // 前三个回合 settle，巴爷回合 raw 结束以截取 P4① 定序决策
    s = passTurn(s);
    s = passTurn(s);
    s = passTurn(s);
    s = applyCommand(s, { type: 'end_turn', character: 'baye' }).state;
    expect(s.pendingDecision?.kind).toBe('order_effects');
    const before = s.log.length;
    s = answer(s, { order: [uid05, uid02] }); // 先火山喷发后精灵亡魂
    const dmgSeq = s.log
      .slice(before)
      .filter((e) => e.kind === 'character_damaged')
      .map((e) => (e as { character: string }).character);
    expect(dmgSeq[0]).toBe('baye'); // 危-05 先
    expect(dmgSeq[dmgSeq.length - 1]).toBe('xiaoyu'); // 危-02 后
  });

  it('TC-CR-009 危-02/03 清除奖励：此场景一名角色抽 1 + 1 材料（与基础并存）【§9.8】【L415】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-02', 'ancient_battlefield');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'ancient_battlefield';
    });
    s = ensureCard(s, 'xiaoyu', 'yu-05');
    const uid = crisisIn(s, 'ancient_battlefield', 'crisis-02')[0]!;
    const mat0 = s.characters['xiaoyu']!.materialTokens;
    s = playCardById(s, 'xiaoyu', 'yu-05', { crisisUids: [uid] }); // 4 点，刚好清除 danger-4 卡
    expect(s.scenes['ancient_battlefield'].crisisCards).not.toContain(uid);
    expect(s.characters['xiaoyu']?.materialTokens).toBe(mat0 + 2); // 基础 1 + 卡面 1
  });

  it('TC-CR-010 危-02/03 轮末伤害使小鱼 E+1（T2）【§9.8】【§6.4】【L164】', () => {
    let s = freshGame();
    s = clearCrises(s); // 排除 R1 翻牌的轮末效果干扰
    s = putCrisis(s, 'crisis-03', 'dark_valley');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'dark_valley';
    });
    s = passRound(s);
    expect(s.characters['xiaoyu']?.hp).toBe(4);
    expect(s.characters['xiaoyu']?.erosion).toBe(1); // 【暗】卡效果伤害 T2
  });

  it('TC-CR-011 危-04 轮末双分支【§9.8】', () => {
    // a) 小鱼在 → 小鱼 E+1，其他人不伤
    let a = freshGame();
    a = putCrisis(a, 'crisis-04', 'elf_kingdom');
    a = mut(a, (d) => {
      d.characters['xiaoyu']!.scene = 'elf_kingdom';
    });
    a = passRound(a);
    expect(a.characters['xiaoyu']?.erosion).toBe(1);
    expect(a.characters['liya']?.hp).toBe(5);
    expect(a.characters['kaier']?.hp).toBe(5);
    // b) 小鱼不在 → 该场景所有角色受 1 点（公爵威严使莉雅 -1 → 0）
    let b = freshGame();
    b = putCrisis(b, 'crisis-04', 'elf_kingdom');
    b = passRound(b);
    expect(b.characters['xiaoyu']?.erosion).toBe(0);
    expect(b.characters['kaier']?.hp).toBe(4);
    expect(b.characters['liya']?.hp).toBe(5); // 凯尔被动 -1 → 0 伤
  });

  it('TC-CR-012 危-05 轮末全场景 1 伤；清除奖励参与者各 2 材料【§9.8】', () => {
    let s = freshGame();
    s = clearCrises(s); // 排除 R1 翻牌干扰
    s = putCrisis(s, 'crisis-05', 'dark_valley');
    s = mut(s, (d) => {
      d.characters['baye']!.scene = 'dark_valley';
      d.characters['xiaoyu']!.scene = 'dark_valley';
    });
    s = passRound(s);
    expect(s.characters['baye']?.hp).toBe(4);
    expect(s.characters['xiaoyu']?.hp).toBe(4);
    // 清除：巴-01 远程 3 点 → 参与者巴爷 +1 基础 +2 卡面
    let s2 = freshGame();
    s2 = putCrisis(s2, 'crisis-05', 'dark_valley');
    s2 = giveTurn(s2, 'baye');
    s2 = ensureCard(s2, 'baye', 'ba-01');
    const uid = crisisIn(s2, 'dark_valley', 'crisis-05')[0]!;
    // 危-05 danger=4，巴-01 3 点不够；先垫 1 点
    const evPre: GameEvent[] = [];
    dealDamageToCrisis(s2, evPre, uid, 1, 'baye');
    s2 = playCardById(s2, 'baye', 'ba-01', { crisisUids: [uid] });
    expect(s2.characters['baye']?.materialTokens).toBe(3);
  });

  it('TC-CR-013 危-06 持续：所在场景无法锻造【§9.8】【裁A-40】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-06', 'dark_valley');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'dark_valley';
      d.characters['xiaoyu']!.materialTokens = 2;
    });
    expect(() =>
      applyCommand(s, {
        type: 'forge',
        character: 'xiaoyu',
        equipmentUid: s.equipmentDisplay[0]!,
        materialCardUids: [],
        useTokens: 2,
      }),
    ).toThrow(/黑暗战船|无法锻造/);
  });

  it('TC-CR-014 危-07 双向远程失效清单（6 项）【§9.8】【裁A-20】', () => {
    const fog = 'elf_kingdom';
    // 摆盘：迷雾在 elf_kingdom；外部 human_city / ancient_battlefield 各有目标卡
    function foggy(): GameState {
      let s = freshGame();
      s = putCrisis(s, 'crisis-07', fog);
      s = putCrisis(s, 'crisis-01', 'human_city');
      s = putCrisis(s, 'crisis-02', 'ancient_battlefield');
      s = putCrisis(s, 'crisis-01', fog);
      return s;
    }
    // ① 莉雅被动（指定相邻场景）：精灵王国(迷雾内) → 古战场
    let s = giveTurn(foggy(), 'liya');
    s = ensureCard(s, 'liya', 'ya-01');
    expect(() => playRaw(s, 'liya', 'ya-01', { crisisUids: [crisisIn(s, 'ancient_battlefield', 'crisis-02')[0]!] })).toThrow(/迷雾/);
    // ② 雅-09：迷雾内 → 外
    s = ensureCard(s, 'liya', 'ya-09');
    expect(() => playRaw(s, 'liya', 'ya-09', { crisisUids: [crisisIn(s, 'human_city', 'crisis-01')[0]!] })).toThrow(/迷雾/);
    // ③ 鱼-08（指定相邻场景）：小鱼在王城 → 迷雾内卡
    let s3 = giveTurn(foggy(), 'xiaoyu');
    s3 = ensureCard(s3, 'xiaoyu', 'yu-08');
    expect(() =>
      playRaw(s3, 'xiaoyu', 'yu-08', { crisisUids: [crisisIn(s3, fog, 'crisis-01')[0]!] }),
    ).toThrow(/迷雾|须在当前或相邻/);
    // ④ 装-02 主动：标记后小鱼以 yu-01 打迷雾内卡
    let s4 = giveTurn(foggy(), 'xiaoyu');
    s4 = giveEquipment(s4, 'xiaoyu', 'equip-02');
    s4 = ensureCard(s4, 'xiaoyu', 'yu-01');
    s4 = applyCommand(s4, { type: 'equipment_active', character: 'xiaoyu', equipmentUid: s4.characters['xiaoyu']!.equipment[0]! }).state;
    expect(() => playRaw(s4, 'xiaoyu', 'yu-01', { crisisUids: [crisisIn(s4, fog, 'crisis-01')[0]!] })).toThrow(/迷雾/);
    // ⑤ 巴-01：巴爷在王城 → 迷雾内卡
    let s5 = giveTurn(foggy(), 'baye');
    s5 = ensureCard(s5, 'baye', 'ba-01');
    expect(() => playRaw(s5, 'baye', 'ba-01', { crisisUids: [crisisIn(s5, fog, 'crisis-01')[0]!] })).toThrow(/迷雾/);
    // ⑥ 凯-10：凯尔在迷雾内 → 任意场景卡（凯-10 需古战场有卡：已摆 crisis-02）
    let s6 = giveTurn(foggy(), 'kaier');
    s6 = ensureCard(s6, 'kaier', 'kai-10');
    expect(() => playRaw(s6, 'kaier', 'kai-10', { crisisUids: [crisisIn(s6, 'human_city', 'crisis-01')[0]!] })).toThrow(/迷雾/);
    // 正向：外部可以打外部（非迷雾场景）
    let s7 = giveTurn(foggy(), 'baye');
    s7 = ensureCard(s7, 'baye', 'ba-01');
    expect(() => playRaw(s7, 'baye', 'ba-01', { crisisUids: [crisisIn(s7, 'ancient_battlefield', 'crisis-02')[0]!] })).not.toThrow();
  });

  it('TC-CR-015 迷雾内打本场景卡不算远程；场景内手牌上限 -1【§9.8】【裁A-20】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-07', 'elf_kingdom');
    s = putCrisis(s, 'crisis-01', 'elf_kingdom');
    s = giveTurn(s, 'liya');
    s = ensureCard(s, 'liya', 'ya-01');
    const uid = crisisIn(s, 'elf_kingdom', 'crisis-01')[0]!;
    const r = playRaw(s, 'liya', 'ya-01', { crisisUids: [uid] }); // 本场景卡：合法
    expect(r.events.find((e) => e.kind === 'crisis_damaged')).toBeTruthy();
    // 手牌上限 5-1=4：莉雅手牌凑 5 → P4② 弃至 4
    let s2 = freshGame();
    s2 = putCrisis(s2, 'crisis-07', 'elf_kingdom');
    s2 = mut(s2, (d) => {
      const l = d.characters['liya']!;
      l.hand.push(l.deck.shift()!); // 手牌 5
    });
    s2 = passRound(s2);
    expect(s2.characters['liya']?.hand.length).toBe(4);
  });

  it('TC-CR-016 危-08 危机度 1；清除获 1 净化（上限 3 溢出丢失）【§9.8】【§1.4】【L67】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-08', 'human_city');
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.purifyTokens = 3;
    });
    const uid = crisisIn(s, 'human_city', 'crisis-08')[0]!;
    s = playCardById(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] });
    expect(s.scenes['human_city'].crisisCards).not.toContain(uid); // 1 点即清除（4 伤溢出浪费）
    expect(s.characters['xiaoyu']?.purifyTokens).toBe(3); // 溢出丢失
  });

  it('TC-CR-017 危-09 献祭进度独立：各达 3 各 +3，最多 +6【§9.8】【L427】【裁A-15】', () => {
    // 轮末 +1：两张在场各累计（一张取自牌库，另一张为 SETUP 旁置通牒卡）
    let s = freshGame();
    s = clearCrises(s);
    s = putCrisis(s, 'crisis-09', 'ancient_battlefield');
    s = mut(s, (d) => {
      const aside = d.ultimatumAsideUid!;
      d.ultimatumAsideUid = null;
      d.scenes['ancient_battlefield'].crisisCards.push(aside);
    });
    s = passRound(s);
    const progresses = Object.values(s.flags.sacrifice);
    expect(progresses.length).toBe(2);
    expect(progresses.every((p) => p === 1)).toBe(true);
    // 决战加成：一张 3 一张 2 → +3；两张各 3 → +6
    const b1 = toBattle(freshGame(), (d) => {
      d.flags.avatarCleared = true;
      d.flags.sacrifice = { 'crisis-09#0': 3, 'crisis-09#1': 2 };
    });
    expect(b1.boss?.maxHp).toBe(26 + 3);
    const b2 = toBattle(freshGame(), (d) => {
      d.flags.avatarCleared = true;
      d.flags.sacrifice = { 'crisis-09#0': 3, 'crisis-09#1': 3 };
    });
    expect(b2.boss?.maxHp).toBe(26 + 6);
  });

  it('TC-CR-018 危-10 未清除 +2 / 清除全员回满【§9.8】【L428】', () => {
    const b = toBattle(freshGame()); // 默认未清除
    expect(b.boss?.maxHp).toBe(26 + 2);
    // 清除：全员回满并标记
    let s = freshGame();
    s = putCrisis(s, 'crisis-10', 'ancient_battlefield');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.hp = 1;
      d.characters['liya']!.hp = 2;
      d.characters['xiaoyu']!.scene = 'ancient_battlefield';
    });
    const uid = crisisIn(s, 'ancient_battlefield', 'crisis-10')[0]!;
    const events: GameEvent[] = [];
    dealDamageToCrisis(s, events, uid, 6, 'xiaoyu');
    expect(s.flags.avatarCleared).toBe(true);
    expect(s.characters['xiaoyu']?.hp).toBe(5);
    expect(s.characters['liya']?.hp).toBe(5);
  });

  it('TC-CR-019 危机卡带【暗】且小鱼参与清除 → E+1（T1）【§6.1】【L138, L416】', () => {
    let s = freshGame();
    s = putCrisis(s, 'crisis-02', 'ancient_battlefield');
    s = mut(s, (d) => {
      d.characters['xiaoyu']!.scene = 'ancient_battlefield';
    });
    s = ensureCard(s, 'xiaoyu', 'yu-01');
    const uid = crisisIn(s, 'ancient_battlefield', 'crisis-02')[0]!;
    // 危-02 danger=4，鱼-01 3 点不够；加 1 点直接清除
    const evPre: GameEvent[] = [];
    dealDamageToCrisis(s, evPre, uid, 1, 'xiaoyu');
    s = playCardById(s, 'xiaoyu', 'yu-01', { crisisUids: [uid] }); // 3+1=4 清除 【暗】卡
    expect(s.characters['xiaoyu']?.erosion).toBe(1);
    // 对照：莉雅单独清除 → 小鱼不加
    let s2 = freshGame();
    s2 = clearCrises(s2); // 清 P1 翻的牌避免迷雾阻挡远程
    s2 = putCrisis(s2, 'crisis-02', 'ancient_battlefield');
    s2 = giveTurn(s2, 'liya');
    s2 = ensureCard(s2, 'liya', 'ya-09');
    const uid2 = crisisIn(s2, 'ancient_battlefield', 'crisis-02')[0]!;
    s2 = playPassCopy(s2, 'liya', 'ya-09', { crisisUids: [uid2] });
    expect(s2.characters['xiaoyu']?.erosion).toBe(0);
  });

  it('TC-CR-020 轮末「一名角色」由玩家协商（pendingDecision）【§9.8】【L298】', () => {
    let s = freshGame();
    s = clearCrises(s); // 仅留一张轮末效果卡，避免触发定序决策
    s = putCrisis(s, 'crisis-02', 'elf_kingdom'); // 莉雅+凯尔在场 → 2 名候选
    s = passTurn(s);
    s = passTurn(s);
    s = passTurn(s);
    s = applyCommand(s, { type: 'end_turn', character: 'baye' }).state;
    expect(s.pendingDecision?.kind).toBe('choose_character');
    s = answer(s, { character: 'kaier' });
    expect(s.characters['kaier']?.hp).toBe(4);
    expect(s.characters['liya']?.hp).toBe(5);
  });
});

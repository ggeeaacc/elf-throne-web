# 《精灵王座：破晓之契》规则回归套件（QA Task #4）

- 对照基准：`design/spec/rules-spec.md` v1.1+（冻结）、`design/spec/ambiguities.md` v1.2（47 条裁定冻结）
- 用例目录：`docs/qa/test-cases.md`（225 条）；策略与引证规范：`docs/qa/test-plan.md`

## 组织

```
tests/
  helpers/regression-utils.ts   摆盘工厂：直达状态（决战/失控/羁绊/清场/回合驱动/决策回答）
  unit/tc-md.test.ts            人数变体与开局 SETUP（12）
  unit/tc-ph.test.ts            相位状态机与时间轴（10）
  unit/tc-sc.test.ts            场景行动与移动/飞空艇（7）
  unit/tc-cr.test.ts            危机蔓延与危机卡（20）
  unit/tc-cb.test.ts            交战结算与伤害效果链（19）
  unit/tc-wl.test.ts            胜负判定与出局（10）
  unit/tc-er.test.ts            侵蚀与失控状态机（16）
  unit/tc-bd.test.ts            偏见与羁绊（28 用例 / 33 its，部分用例拆 -a/-b）
  unit/tc-lt.test.ts            传书（15）
  unit/tc-fg.test.ts            锻造与装备（14）
  unit/tc-cd.test.ts            角色专属卡 40+2（41）
  unit/tc-fb.test.ts            最终决战（24）
  unit/tc-sy.test.ts            联机同步与确定性（8）
```

## 引证规范（test-plan §2 镜像）

- 每条 `it` 标题 = `TC-XX-NNN + 标题 + 引证串`，引证串 = `【§章节】【L行号】【裁A-xx】`（联机基建类允许【ADR-xxx】）。
- 一条用例可拆多条 `it`（后缀 `-a`/`-b`），每条都必须带同一 TC 编号与引证串。
- 校验：`node scripts/check-citations.mjs`——缺编号/缺引证/用例未转码/裁定未覆盖即 FAIL（CI 挂根脚本）。

## 铁律

- 测试按冻结规格书写；**失败即引擎 bug**（QA 不改引擎代码），按 Blocker/Critical/Major/Minor 定级报 team-lead。
- 确定性：一切随机经种子 RNG；禁止 Math.random/Date.now/真定时器（TC-SY-002 静态扫描兜底）。

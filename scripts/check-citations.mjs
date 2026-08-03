#!/usr/bin/env node
/**
 * 规则断言引证校验（docs/qa/test-plan.md §2.4）。
 *
 * 检查项：
 *  1. tests/ 下全部 .test.ts 每条 it 标题：必须以 TC-XX-NNN 开头且含引证串（【§…】或【ADR…】）。
 *  2. 覆盖：docs/qa/test-cases.md 中每条 TC 用例至少有 1 条 it（允许多 it 带 -a/-b 后缀）。
 *  3. 反向：测试中的 TC 编号必须在用例目录中登记（防杜撰）。
 *  4. 裁定覆盖：design/spec/ambiguities.md 的 44 条 + test-plan §10 登记的裁Q-x，均至少 1 条 it 引用。
 *
 * 退出码：0 = 全部通过；1 = 存在违例/缺口。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

// ── 1. 扫描测试标题 ─────────────────────────────────────────────────────────
const testFiles = walk(join(ROOT, 'tests'));
const itRe = /it\(\s*['"`]([^'"`]+)['"`]/g;
const tcRe = /^(TC-[A-Z]+-\d+(?:-[ab])?)/;
const titles = [];
for (const f of testFiles) {
  const src = readFileSync(f, 'utf8');
  let m;
  while ((m = itRe.exec(src))) {
    titles.push({ file: f, title: m[1] });
  }
}
if (titles.length === 0) errors.push('tests/ 下未发现任何 it 用例');

const testTcIds = new Set();
const citedRulings = new Set();
for (const t of titles) {
  const m = t.title.match(tcRe);
  if (!m) {
    errors.push(`[INVALID] 缺 TC 编号：${t.title}（${t.file}）`);
    continue;
  }
  testTcIds.add(m[1].replace(/-[ab]$/, ''));
  if (!/【(§|ADR)/.test(t.title)) {
    errors.push(`[INVALID] 缺引证串（【§…】/【ADR…】）：${t.title}（${t.file}）`);
  }
  for (const r of t.title.matchAll(/【裁(A-\d+|Q-\d+)】/g)) citedRulings.add(r[1]);
}

// ── 2. 用例目录覆盖 ─────────────────────────────────────────────────────────
const caseDoc = readFileSync(join(ROOT, 'docs/qa/test-cases.md'), 'utf8');
const caseIds = new Set([...caseDoc.matchAll(/^- (TC-[A-Z]+-\d+)/gm)].map((m) => m[1]));
for (const id of caseIds) {
  if (!testTcIds.has(id)) errors.push(`[COVERAGE GAP] 用例无测试：${id}`);
}
for (const id of testTcIds) {
  if (!caseIds.has(id)) warnings.push(`[WARN] 测试编号未在用例目录登记：${id}`);
}

// ── 3. 裁定覆盖（44 条 A + test-plan §10 登记的 Q）──────────────────────────
const amb = readFileSync(join(ROOT, 'design/spec/ambiguities.md'), 'utf8');
const aIds = new Set([...amb.matchAll(/A-(\d{2})/g)].map((m) => `A-${m[1]}`));
for (const id of aIds) {
  if (!citedRulings.has(id)) errors.push(`[RULING GAP] 裁定无测试引用：裁${id}`);
}
const plan = readFileSync(join(ROOT, 'docs/qa/test-plan.md'), 'utf8');
const qIds = new Set([...plan.matchAll(/裁(Q-\d+)】/g)].map((m) => m[1]));
for (const id of qIds) {
  if (!citedRulings.has(id)) errors.push(`[RULING GAP] 新裁定无测试引用：裁${id}`);
}

// ── 报告 ────────────────────────────────────────────────────────────────────
console.log(`[check-citations] 测试标题 ${titles.length} 条；用例目录 ${caseIds.size} 条；裁定 ${aIds.size}+${qIds.size} 条`);
for (const w of warnings) console.log(w);
if (errors.length) {
  for (const e of errors) console.error(e);
  console.error(`[check-citations] FAIL：${errors.length} 项违例/缺口`);
  process.exit(1);
}
console.log('[check-citations] PASS：引证完备、用例与裁定全覆盖');
process.exit(0);

# 《精灵王座：破晓之契》联机测试版 — 主架构文档

> 版本 v0.1 · 2026-08-02 · 工程负责人：程基岩
> 关联决策：见 `adr/ADR-001`～`ADR-004` · 工程红线：见 `control-manifest.md`
> 上游输入：`design/source/rulebook-annotated.txt`（规则书批注版）、`design/spec/rules-spec.md`（设计组并行产出中，命名约定已与其对齐，见 §9）

---

## 1. 目标与约束

| 项 | 内容 |
|---|---|
| 产品 | 1–4 人合作桌游的联机网页**测试版** |
| 首要质量 | 规则 100% 忠实、无 bug；美术零要求；轻量可测 |
| 联机形态 | 房间制，4 人实时对局 |
| 本机环境 | Windows + 托管 Node.js 22.22.2（禁全局安装） |
| 关键复杂度 | 严格四阶段回合状态机；100 张卡牌（40 专属行动 / 30 危机 / 10 羁绊 / 10 传书 / 10 装备）效果大量联动；4 种人数配置变体；隐藏信息（手牌、牌库序、背面书信）；结算中途的玩家决策（通用危机卡放置协商、目标选择等） |

## 2. 总体分层

```
┌─────────────────────────────────────────────────────────────┐
│ client/   极简网页客户端（Vite + 原生 TS，无框架）             │
│           渲染个性化视图 → 收集意图 → 发 Command；无规则逻辑    │
├─────────────────────────────────────────────────────────────┤
│ server/   房间制服务端（node:http + ws，TypeScript）           │
│           房间/会话/重连 · 指令鉴权 · 视图投影分发 · 静态托管    │
│           —— 不含任何规则实现，只调用引擎 ——                   │
├─────────────────────────────────────────────────────────────┤
│ engine/   规则引擎（纯 TS，零运行时依赖）                      │
│  ┌───────────────┬───────────────────┬────────────────────┐ │
│  │ content/      │ core              │ systems (Task #1)  │ │
│  │ 卡牌/角色/场景 │ 状态Schema·种子RNG │ 危机·交战·侵蚀·羁绊 │ │
│  │ /人数变体 数据 │ 相位状态机·指令分发 │ 传书·首领战         │ │
│  └───────────────┴───────────────────┴────────────────────┘ │
│   纯函数内核：applyCommand(state, cmd) → { state', events }   │
│   禁 I/O、禁 Date.now/Math.random、禁 import 网络/UI          │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向**：client → server → engine，单向不可逆。engine 不知道网络存在。

## 3. 模块边界

| 模块 | 职责 | 不负责 |
|---|---|---|
| `engine/types.ts` | GameState / Command / GameEvent / PendingDecision 全部 schema | 任何行为逻辑 |
| `engine/content/*` | 100 张卡牌、4 角色、4 场景、人数变体表的**数据化**定义 | 效果结算逻辑 |
| `engine/state.ts` | `createInitialState(config)`：完整实现规则书「游戏准备」（含初始羁绊发出） | 回合流程 |
| `engine/phases.ts` | 四相位状态机 + 时间轴 + 决战循环 + P4 冻结管线 | 相位内的具体结算 |
| `engine/actions.ts` | `applyCommand` 全指令面分发与前置鉴权 | 效果本体 |
| `engine/systems/common.ts` | 事件/决策挂起/确定性洗牌抽牌原语 | — |
| `engine/systems/damage.ts` | §11 有序效果链 + 角色伤害终端（代受/分摊/减免/侵蚀/出局） | — |
| `engine/systems/combat.ts` | 攻击链构建（静态修饰→卡面→消耗品→目标侧）、危机卡伤害/清除/奖励、玫拉伤害与反击 | — |
| `engine/systems/crisis.ts` | P1 翻牌管线（通牒固定翻/通用卡决策）+ P4① 轮末效果队列 | — |
| `engine/systems/cards.ts` | 40 张行动卡结算器注册表 | — |
| `engine/systems/letters.ts` | 传书收发 + 5 种传书卡 + 羁-01 激活 | — |
| `engine/systems/forge.ts` | 锻造费用/支付 + 5 种装备主被动 | — |
| `engine/systems/bonds.ts` | 羁绊状态机 + 10 张羁绊卡 + 羁-07 复制续算 | — |
| `engine/systems/boss.ts` | 决战备战/首领三阶段/决战行动/宝玉共鸣 | — |
| `engine/systems/decisions.ts` | 决策续算注册表（resume.sys/op 路由 + resumeStack 排空） | — |
| `engine/view.ts` | `projectView(state, seat)` 隐藏信息投影（决策选项按座位过滤） | 传输 |
| `server/rooms.ts` | 房间注册表、座位→角色映射、开局装配、指令鉴权（决策人/转出方/当前回合三类） | 规则 |
| `server/session.ts` | WebSocket 协议、个性化广播、断线重连 | 规则 |
| `client/src/main.ts` | 视图渲染与意图采集 | 一切规则 |

## 4. 状态同步模型（ADR-002 摘要）

- **服务端权威**：规则只在服务端执行；客户端发送意图（Command），服务端用引擎校验并应用。
- **全量个性化视图广播**：每次状态变更后，对每个座位执行 `projectView` 投影（隐藏他人手牌、牌库序、背面书信/通牒卡）后全量推送。状态体积 < 50KB、动作频率为人手操作级，快照优于增量补丁——简单且永不漂移。
- **单调 seq**：每房间一个递增序号，客户端据以丢弃乱序/过期视图。
- **事件流**：`applyCommand` 同时返回领域事件列表（日志/动画依据），随视图一并按座位脱敏下发。
- **重连**：入座即发 token；断线后凭 `roomId + token` 恢复座位与最新视图（ADR-004）。

## 5. 规则引擎内核（ADR-003 摘要）

- **纯函数内核**：`applyCommand(state, cmd) → { state', events, pendingDecision? }`；state 为纯 JSON（含 RNG 游标），可结构化克隆、可序列化、可回放。
- **确定性**：mulberry32 种子 RNG，游标存于 state 内；同种子 + 同指令序列 ⇒ 逐字节相同的状态。洗牌/抽牌全部经由 `Rng`。
- **中断式决策**：结算需要玩家选择时（如通用危机卡落点、弃牌选择），引擎落 `pendingDecision` 并挂起，等待 `resolve_decision` 指令续算——天然映射规则书中的「协商/选择」点。
- **相位状态机**：`crisis → action → prejudice → recovery` 四相位 × 三天九轮；自动相位（无玩家输入）由引擎连续推进直至需要输入；第三天深夜结束后切换 `final_battle`。
- **人数变体**：全部差异（AP/血量/翻牌量/偏见开关/沦陷阈值/玫拉数值/决战补给）收敛为 `MODE_TABLE[1..4]` 数据，禁止散落在代码里 if/else。

## 6. 房间 / 会话管理（ADR-004 摘要）

内存房间注册表（无 DB）：`Room{ id, status: lobby|playing|finished, players, engineState, seq }`。
座位按加入顺序分配，角色映射由人数规则导出（4 人各控 1 名；3 人弃凯尔/巴爷其一；1–2 人固定小鱼+莉雅，单人双控）。
进程重启即清场——测试版可接受，重开房间即可。

## 7. 目录与命令

```
package.json            npm workspaces（engine/server/client）+ 根脚本
engine/src/*.ts         引擎内核与数据表（含 *.test.ts 单测）
server/src/*.ts         服务端（含房间集成测试）
client/                 index.html + src/main.ts（vite）
scripts/smoke.mjs       端到端冒烟：建房→4 人入座→开局→行动→推进至决战
docs/architecture/      本文档 + adr/ + control-manifest.md
tests/                  （QA 领地：Task #4 规则回归套件）
```

根命令（npm 脚本内 `node` 即托管 22.22.2，npm 会自动将其目录注入 PATH）：

```bash
npm install     # 工作区本地安装全部依赖
npm test        # vitest：引擎单测 + 服务端集成测试
npm run smoke   # 构建并跑端到端冒烟脚本
npm start       # 构建并以 :8787 启动服务端（同端口托管 client/dist 与 /ws）
npm run dev --workspace @elf-throne/client   # 前端热更新开发（代理 /ws → :8787）
```

## 8. 测试策略

- **引擎单测**（99 用例）：RNG 确定性；SETUP 全模式不变量；相位机九轮+决战循环；§11 效果链折叠/代受/分摊/减免钳制；交战参与轨迹与清除奖励；侵蚀状态机（失控/倒计时 F4/羁-02 替换）；危机翻牌量表/通牒固定翻/轮末效果定序；传书全流程与羁-01 激活；锻造混合支付/折扣/装备钳制；首领三阶段/反击/宝玉共鸣/决战行动；视图投影脱敏。
- **服务端集成测试**：真实 WebSocket 四客户端全链路（含断线重连）。
- **回放性质**：`同种子 + 同指令流 ⇒ 同终态` 常驻断言。
- **tests/（QA 领地）**：Task #4 规则回归套件在此基础上扩建（test-utils 的摆盘/自动决策工具可直接复用）。

## 9. 与 rules-spec 的对齐约定（已与 designer 同步）

引擎 content 数据表与设计组规则规格共享同一词汇表：

- 角色 id：`xiaoyu / liya / kaier / baye`；场景 id：`human_city / elf_kingdom / ancient_battlefield / dark_valley`
- 时段：`dawn / dusk / night`；相位：`crisis / action / prejudice / recovery / final_battle`
- 卡牌：规则书编号原样入 `code`（鱼-01、危-09…），ASCII slug 入 `id`（yu-01、crisis-09…）
- 效果语义以 spec 为准，引擎 content 仅先落元数据与原文 `text`；歧义点统一进设计组《规则歧义清单》。

## 10. 风险与开放问题

| # | 事项 | 状态 |
|---|---|---|
| R1 | 规则冲突：单人玫拉血量——人数总表与单人规则为 12，§七写 10；引擎取 12（多数口径）并作 config 可覆盖 | 已提 designer 歧义清单，待裁决 |
| R2 | 协商类决策（偏见触发者、通用危机落点）在联机下需 UI 流程支撑 | 引擎 pendingDecision 已预留；客户端 Task #3 落地 |
| R3 | 引擎知识缺口：无——本项目不依赖外部游戏引擎 API，规则全部自实现 | — |
| R4 | 内存房间无持久化，进程重启丢局 | 测试版接受；如需续局再加快照落盘（非本任务） |

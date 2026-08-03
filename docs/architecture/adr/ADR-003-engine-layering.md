# ADR-003 规则引擎分层：纯函数内核 + 数据化内容 + 中断式决策

- 状态：**Accepted**（2026-08-02，程基岩）
- 上下文：规则书为状态机驱动（四相位 × 三天九轮 + 决战三阶段）；100 张卡效果互相联动（伤害修正叠乘、代伤、复制、时机窗口）；存在结算中途的玩家选择；QA 要求规则回归全覆盖。

## 决策

引擎分三层，依赖单向：

```
content/  纯数据：卡牌/角色/场景/人数变体表（MODE_TABLE），效果挂元数据 + 原文 text
core      纯函数：GameState schema、种子 RNG（游标在 state 内）、相位状态机、
          applyCommand 分发、projectView 投影、PendingDecision 中断协议
systems/  （Task #1 落地）危机/交战/侵蚀/羁绊/传书/首领战的结算器，只准调 core 原语
```

1. **纯函数内核**：`applyCommand(state, cmd) → { state', events }`，内部 `structuredClone` 后进 draft 可变风格书写，返回全新引用。无 I/O、无时钟、无全局态。
2. **确定性随机**：mulberry32；`state.rng = { seed, cursor }` 随状态序列化——同种子同指令流逐字节同终态（回放/属性测试基底）。
3. **中断式决策（PendingDecision）**：结算遇玩家选择即产出 `pendingDecision`（类型化的选项集 + 决策人座位），引擎挂起；`resolve_decision` 指令续算。规则书所有"协商/选择/由谁定夺"点统一走此协议，杜绝在结算器里写回调。
4. **内容数据化**：人数差异只查 `MODE_TABLE`；卡牌效果（Task #1）以声明式效果步骤注册进 systems，卡面原文只作显示。
5. **事件溯源式日志**：每次变更追加领域事件入 `state.log`（测试断言与客户端动画共用）；日志即回放脚本。

## 备选与否决理由

1. **面向对象实体/行为树**：状态散在对象里，序列化与回放困难。否决。
2. **效果回调/Promise 式结算器**：异步回调穿过网络层，断线即死。否决——一切异步性外化为 pendingDecision。
3. **把变体差异写成 if/else 撒在各系统**：规则忠实度无法审计。否决——MODE_TABLE 唯一出处。

## 后果

- 正面：引擎可在 node 单测与浏览器（未来本地热座模式）双跑；QA 可用脚本批量回放对局；新增卡牌 = 加数据 + 加效果步骤 + 加测试，不动内核。
- 代价：`structuredClone` 全量拷贝每指令一次（状态 < 50KB，微秒级，忽略）；中断协议要求所有"询问玩家"显式建模，Task #1 工作量大但路径唯一。
- 红线：engine 不得 import server/client 任何符号（control-manifest 强制执行）。

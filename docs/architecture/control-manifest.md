# 工程控制清单（一页红线）

> 任何向 `engine/`、`server/` 提交代码的人，先读这一页。违反任一条即打回。

## 引擎（engine/）
1. **纯函数内核**：`applyCommand` 不得做 I/O；`engine/` 任何文件不得 import `server/`、`client/`、`node:*`、`ws`、`vite`。
2. **确定性**：随机只走 `Rng`（`state.rng` 游标）；禁 `Math.random` / `Date.now` / `crypto.random` 出现在结算路径。
3. **状态即 JSON**：`GameState` 只允许可 `JSON.stringify` 的plain data（无类实例、无 Map/Set、无函数）。新字段默认在 `projectView` 中**隐藏**，显式声明才公开。
4. **变体查表**：人数差异一律查 `MODE_TABLE`，禁止散写 `if (playerCount === ...)` 于结算逻辑。
5. **决策走协议**：任何"问玩家"一律产出 `PendingDecision`，禁止回调/异步穿过引擎边界。
6. **先测后码**：每张卡效果、每条相位规则，先写 `applyCommand` 断言测试再实现；测试引用规则书章节号（如 `// 规则书 §五.第二阶段.3`）。

## 服务端（server/）
7. **零规则**：server 只做鉴权转发 + 投影分发；发现自己在 server 写规则判断，立即停手移到 engine。
8. **唯一出口**：发给客户端的一切状态必须经 `projectView(state, seat)`；事件按座位脱敏。
9. **错误不回响**：引擎抛出的指令错误只回发送者，不广播。

## 客户端（client/）
10. **无状态权威**：客户端不缓存、不推断游戏规则；视图渲染只读最近一份 `view`。
11. **意图即指令**：用户操作翻译为 Command 上送，本地不改 state。

## 通用
12. **依赖最小化**：新增依赖需在 ADR 留记录；engine 永远零运行时依赖。
13. **禁全局安装**：一切依赖经工作区 `npm install`；脚本内 `node` 为托管 22.22.2（npm 自动注入 PATH）。

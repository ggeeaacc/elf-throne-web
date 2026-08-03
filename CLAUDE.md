# 项目约定（工程）

《精灵王座：破晓之契》合作桌游联机网页测试版。规则 100% 忠实优先，美术零要求，1–4 人房间制联机。

## 工具链（钉定）
- Node.js 22.22.2（托管）：`C:/Users/34744/.workbuddy/binaries/node/versions/22.22.2/node.exe`
- npm 10.9.7 随 Node 自带；**依赖一律工作区内本地安装，禁全局安装**
- 调用方式：`node <node目录>/node_modules/npm/bin/npm-cli.js <cmd>`；npm 脚本内 `node` 自动指向该版本
- TypeScript 5.6 严格模式 / Vite 6 / Vitest 3 / ws 8；引擎零运行时依赖

## 常用命令
- `npm install` 安装；`npm test` 全部测试；`npm run smoke` 构建+端到端冒烟；`npm start` :8787 启动
- 注意：本环境沙箱拦截 `rm -rf` 与 vite `emptyOutDir`（安全删除层）；client/dist 已设 `emptyOutDir:false`，如需清理用 PowerShell `Remove-Item -Recurse -Force`

## 架构红线（详见 docs/architecture/control-manifest.md）
- engine/ = 纯函数规则内核：禁 I/O、禁 Math.random/Date.now、与网络/UI 零耦合；状态为纯 JSON
- server/ = 零规则：鉴权转发 + `projectView` 投影分发是唯一信息出口（隐藏他人手牌/牌库序/背面书信）
- 人数变体只查 `MODE_TABLE`；玩家选择一律 `PendingDecision` 中断协议
- 验证驱动：先写 `applyCommand` 断言测试再实现，测试引用规则书章节号

## 上游文档
- 规则书：`design/source/rulebook-annotated.txt`；规则规格：`design/spec/rules-spec.md`（设计组）
- 架构：`docs/architecture/README.md` + `adr/ADR-001..004`；共享命名约定见 README §9

# 联机部署指南

当前服务端跑在本地 `http://localhost:8787`，只有同一局域网的人能访问。要让朋友通过互联网联机，选以下方案之一：

## 方案 A：cloudflared 隧道（推荐，免费无需注册）

1. 下载 cloudflared：https://github.com/cloudflare/cloudflared/releases/latest → 选 `cloudflared-windows-amd64.exe`
2. 重命名为 `cloudflared.exe`，放到项目根目录
3. 确保服务端在跑（`node server/dist/index.js`）
4. 执行：
   ```
   cloudflared.exe tunnel --url http://localhost:8787
   ```
5. 终端会输出一个 `https://xxx-xxx.trycloudflare.com` URL——这就是公网地址，发给朋友用浏览器打开即可
6. 保持终端开着，关掉就断线

**优点**：免费、无需注册、WebSocket 原生支持、不限流量

## 方案 B：Render.com（长期托管）

1. 把项目推到 GitHub 仓库
2. 注册 https://render.com（GitHub 登录）
3. New → Web Service → 连接你的 GitHub 仓库
4. 配置：
   - Build Command: `npm install && npm run build`
   - Start Command: `node server/dist/index.js`
   - 环境变量: 无需
5. 部署完成后 Render 给一个 `https://你的应用名.onrender.com` URL
6. 免费层 512MB 内存 / 750 小时/月，够测试用

## 方案 C：ngrok

1. 注册 https://ngrok.com（免费）
2. 下载 ngrok.exe + 配置 authtoken
3. 执行：`ngrok http 8787`
4. 获取 `https://xxx.ngrok-free.app` URL

---

**注意**：客户端 WebSocket 连接地址已用 `location.host` 自动适配，无需改代码——从任何域名访问都会自动连到正确的服务端。

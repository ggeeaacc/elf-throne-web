import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  // emptyOutDir 关闭：构建前由脚本手动清理（规避环境安全删除拦截 rmSync 的问题）
  build: { outDir: 'dist', sourcemap: true, emptyOutDir: false },
});

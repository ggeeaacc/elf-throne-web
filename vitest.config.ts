import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 测试直接解析 engine 源码（免先构建）；server 运行时仍走 dist 产物。
export default defineConfig({
  resolve: {
    alias: {
      '@elf-throne/engine': fileURLToPath(new URL('./engine/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['engine/src/**/*.test.ts', 'server/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});

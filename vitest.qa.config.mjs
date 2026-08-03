// QA 回归套件专用 vitest 配置（纯 JS，避免 TS 配置转译产生的临时文件）
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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

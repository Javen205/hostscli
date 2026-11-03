import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        // 只精确匹配包根，避免把 `@hostscli/core/duration` 改写成 `…/index.ts/duration`；
        // 子路径按 package.json exports 解析到 dist（因此需先 build）。
        find: /^@hostscli\/core$/,
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts'],
  },
});

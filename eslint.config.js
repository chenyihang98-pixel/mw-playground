import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    'dist/',
    'build/',
    'coverage/',
    'test-results/',
    'playwright-report/',
    'blob-report/',
    '.local/',
  ]),
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // 资产检查和夹具生成是纯模块：浏览器和 Node 都要能用，所以不能碰文件系统、DOM、网络或 three 的加载器。
    files: ['src/asset/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'fs/*', 'path', 'child_process', 'http', 'https', 'net', 'three', 'three/*'],
              message: 'src/asset 下是纯模块：不用 Node 内置模块，也不用 three。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'location',
        'fetch',
        'XMLHttpRequest',
        'WebSocket',
        'Image',
        'createImageBitmap',
        'localStorage',
        'sessionStorage',
        'process',
        'require',
      ],
    },
  },
  {
    // 玩法规格、关卡布局和模拟是纯模块：不依赖 three、DOM、网络，也不读墙钟、不用随机数，
    // 这样同样的输入总是得到同样的结果，单元测试可以直接驱动。
    files: ['src/game/spec.ts', 'src/game/level/**/*.ts', 'src/game/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*', 'node:*', '**/render/**', '**/ui/**', '**/input/**', '**/dev/**'],
              message: '玩法规格、关卡和模拟是纯模块：不依赖 three、DOM 或渲染 / 界面 / 输入代码。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'performance',
        'Date',
        'requestAnimationFrame',
        'setTimeout',
        'setInterval',
        'fetch',
        'localStorage',
        'process',
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: '模拟必须是确定的：不要用 Math.random。' },
        { object: 'Date', property: 'now', message: '模拟不读墙钟。' },
        { object: 'performance', property: 'now', message: '模拟不读墙钟。' },
      ],
    },
  },
);

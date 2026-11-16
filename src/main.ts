// F6：最先决定界面语言（其他模块顶层用 t() 算出来的文字也要是当前语言）
import './i18n/boot';
import './ui/theme.css';
import { startGameApp } from './game/app';
import { resolveLevelPackage } from './game/boot';
import { createScene } from './scene/createScene';
import { devLevelPackage } from './dev/devLevels';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('页面里缺少 #scene 画布');

// 开发和测试模式才有：夹具预览（?view=fixtures）、选关卡（?level=<id>）和测试钩子。
// 生产构建里 devMode 是常量 false，这些分支和动态导入的模块会被整体去掉。
const devMode = import.meta.env.DEV || import.meta.env.MODE === 'test';
const params = new URLSearchParams(window.location.search);

if (devMode && params.get('view') === 'fixtures') {
  const app = createScene(canvas);
  void import('./dev/devTools').then(({ startDevTools }) => {
    startDevTools(app);
  });
} else {
  const scene = createScene(canvas, { ground: false });
  const requested = devMode ? params.get('level') : null;
  const level = (requested !== null ? devLevelPackage(requested) : null) ?? resolveLevelPackage(requested);
  // 没有 ?level= 时先显示开始界面；有 ?level=（开发和测试）时直接进入这一关的开始面板
  const game = startGameApp(scene, level, document.body, { home: requested === null });
  if (devMode) {
    void Promise.all([import('./dev/gameTestHooks'), import('./game/boot')]).then(([hooks, boot]) => {
      hooks.installGameTestHooks(hooks.createGameTestHooks(game, boot.levelList()));
    });
  }
}

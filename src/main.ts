import { startGameApp } from './game/app';
import { resolveLevelPackage } from './game/boot';
import { createScene } from './scene/createScene';

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
  const level = resolveLevelPackage(devMode ? params.get('level') : null);
  const game = startGameApp(scene, level, document.body);
  if (devMode) {
    void Promise.all([import('./dev/gameTestHooks'), import('./game/boot')]).then(([hooks, boot]) => {
      hooks.installGameTestHooks(hooks.createGameTestHooks(game, boot.levelList()));
    });
  }
}

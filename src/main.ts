import { createScene } from './scene/createScene';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('页面里缺少 #scene 画布');

const app = createScene(canvas);

// 夹具预览和测试钩子只在开发和测试模式下加载；生产构建里这段代码会被整体去掉。
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  void import('./dev/devTools').then(({ startDevTools }) => {
    startDevTools(app);
  });
}

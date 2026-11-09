// 空场景：地面、灯光、相机和渲染循环。

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';

export type FrameCallback = (deltaSeconds: number) => void;

export interface RenderStats {
  readonly frames: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface SceneApp {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  onFrame(callback: FrameCallback): void;
  stats(): RenderStats;
}

export interface SceneOptions {
  /** 是否加 40×40 的默认地面和网格。游戏按关卡尺寸自己建地面，传 false。默认 true。 */
  readonly ground?: boolean;
}

export function createScene(canvas: HTMLCanvasElement, options: SceneOptions = {}): SceneApp {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // P6：柔和阴影和电影感的色调映射（只影响显示）
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new Scene();
  scene.background = new Color(0xbfd8ee);

  const camera = new PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(2.6, 1.7, 3.6);
  camera.lookAt(0, 0.9, 0);

  const hemi = new HemisphereLight(0xffffff, 0x7a6a55, 1.4);
  hemi.name = 'hemi-light';
  scene.add(hemi);
  const sun = new DirectionalLight(0xffffff, 2);
  sun.name = 'sun-light';
  sun.position.set(3, 6, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  if (options.ground ?? true) {
    const ground = new Mesh(new PlaneGeometry(40, 40), new MeshStandardMaterial({ color: 0x8fae7a, roughness: 1 }));
    ground.name = 'Ground';
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const grid = new GridHelper(40, 40, 0x557744, 0x6d8f5c);
    grid.position.y = 0.002;
    scene.add(grid);
  }

  const resize = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const callbacks: FrameCallback[] = [];
  let frames = 0;
  let last: number | null = null;
  let drawCalls = 0;
  let triangles = 0;
  renderer.setAnimationLoop((time: number) => {
    // 帧间隔上限 0.1 s，避免切到后台再回来时动画跳一大步。
    const delta = last === null ? 0 : Math.min((time - last) / 1000, 0.1);
    last = time;
    for (const cb of callbacks) cb(delta);
    renderer.render(scene, camera);
    drawCalls = renderer.info.render.calls;
    triangles = renderer.info.render.triangles;
    frames++;
  });

  return {
    renderer,
    scene,
    camera,
    onFrame: (callback) => callbacks.push(callback),
    stats: () => ({ frames, drawCalls, triangles, canvasWidth: canvas.width, canvasHeight: canvas.height }),
  };
}

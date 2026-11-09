// 把模拟、渲染、输入、HUD 接在一起。模拟按固定步长推进（advance），渲染层每帧只读最新状态。

import type { LevelLayout } from './level/schema';
import type { GameAppSnapshot, OverlayKind } from './appTypes';
import { Controls } from './input/controls';
import { CameraRig } from './render/cameraRig';
import { CharacterView } from './render/characterView';
import { PLAYER_PALETTE } from './render/humanoid';
import { LevelView } from './render/levelView';
import {
  advance,
  createInitialState,
  restartGame,
  setPaused,
  snapshotGame,
  startGame,
  type GameState,
  type Phase,
} from './sim';
import { Hud } from './ui/hud';
import type { SceneApp } from '../scene/createScene';

export type { GameAppSnapshot } from './appTypes';

export interface GameApp {
  snapshot(): GameAppSnapshot;
}

function overlayFor(phase: Phase): OverlayKind | null {
  switch (phase) {
    case 'ready':
      return 'start';
    case 'paused':
      return 'pause';
    case 'won':
      return 'won';
    case 'lost':
      return 'lost';
    case 'playing':
      return null;
  }
}

export function startGameApp(scene: SceneApp, level: LevelLayout, uiRoot: HTMLElement): GameApp {
  let state: GameState = createInitialState(level);
  let accumulator = 0;
  let renderTime = 0;

  const levelView = new LevelView(scene.scene, state);
  const player = new CharacterView('player', PLAYER_PALETTE);
  scene.scene.add(player.root);
  const cameraRig = new CameraRig(scene.camera, level.spawn.yaw);
  cameraRig.reset(level.spawn.yaw, state.player.position);

  const setState = (next: GameState) => {
    const before = state.phase;
    state = next;
    if (state.phase !== before) {
      hud.showOverlay(overlayFor(state.phase), state);
      if (state.phase === 'playing') controls.engage();
      else controls.release();
    }
  };

  const hud = new Hud(uiRoot, {
    onStart: () => {
      setState(startGame(state));
    },
    onResume: () => {
      setState(setPaused(state, false));
    },
    onRestart: () => {
      const fresh = restartGame(state);
      cameraRig.reset(fresh.level.spawn.yaw, fresh.player.position);
      setState(startGame(fresh));
    },
  });

  const controls = new Controls(scene.renderer.domElement, {
    onPauseKey: () => {
      if (state.phase === 'playing') setState(setPaused(state, true));
      else if (state.phase === 'paused') setState(setPaused(state, false));
    },
    onLook: (dx, dy) => {
      if (state.phase === 'playing') cameraRig.look(dx, dy);
    },
    onPointerLockLost: () => {
      // 浏览器在指针锁定时用 Esc 退出锁定，不一定把 Esc 发给页面：锁定丢失就当作暂停。
      if (state.phase === 'playing') setState(setPaused(state, true));
    },
  });

  hud.showOverlay(overlayFor(state.phase), state);

  scene.onFrame((delta) => {
    // 暂停时连装饰性的动画（宝石旋转、待机呼吸）也停下
    if (state.phase !== 'paused') renderTime += delta;
    if (state.phase === 'playing') {
      const look = controls.lookKeys();
      cameraRig.turn(look.turn, look.tilt, delta);
      const axes = controls.axes();
      const result = advance(state, { ...axes, cameraYaw: cameraRig.yaw }, accumulator, delta);
      accumulator = result.accumulator;
      if (result.steps > 0) controls.consumeJump();
      setState(result.state);
    } else {
      accumulator = 0;
      controls.consumeJump();
    }
    const p = state.player;
    player.update(
      { position: p.position, facing: p.facing, horizontalSpeed: state.phase === 'playing' ? p.horizontalSpeed : 0, grounded: p.grounded, vy: p.vy },
      state.phase === 'paused' ? 0 : delta,
      renderTime,
    );
    levelView.update(state, state.phase === 'paused' ? 0 : delta, renderTime);
    cameraRig.update(p.position, delta);
    hud.update(state);
  });

  return {
    snapshot: () => ({
      game: snapshotGame(state),
      camera: { yaw: cameraRig.yaw, pitch: cameraRig.pitch, lookMode: controls.lookMode(), pointerLocked: controls.pointerLocked() },
      overlay: hud.currentOverlay(),
      render: scene.stats(),
    }),
  };
}

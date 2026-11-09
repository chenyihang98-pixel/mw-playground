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
  setCompanions,
  setPaused,
  snapshotGame,
  startGame,
  type GameState,
  type Phase,
} from './sim';
import { Hud } from './ui/hud';
import type { SceneApp } from '../scene/createScene';
import { InstanceRegistry, type ImportedAsset } from '../import/asset';
import { ImportPanel, type HostResult } from '../import/ui/importPanel';
import { assignCast } from '../roster/cast';
import { isPlayerRole } from '../roster/config';
import { CastDirector } from '../roster/director';
import { IndexedDbRosterStore } from '../roster/idbStore';
import { Roster } from '../roster/roster';
import { RosterPanel } from '../roster/ui/rosterPanel';

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

  // ---------- 导入角色（P3）和名册（P4）----------
  const registry = new InstanceRegistry();
  const roster = new Roster(new IndexedDbRosterStore());
  const director = new CastDirector(
    { player, guards: levelView.guards, guardIds: state.guards.map((g) => g.id), parent: scene.scene },
    registry,
  );

  const importPanel = new ImportPanel(uiRoot, {
    isPlaying: () => state.phase === 'playing',
    addPerson: (asset, file): HostResult => {
      if (!roster.has(asset.id) && !file) return { ok: false, error: '缺少原文件，请重新导入这个文件' };
      const result = roster.add(asset, file ?? new Blob());
      return result.ok ? { ok: true, message: `已加入名册：${asset.fileName}（分工：不出场）` } : { ok: false, error: result.error };
    },
    setPlayer: (asset, file): HostResult => {
      // 还不在名册里就先加入，再设为主角；同一个文件已在名册里时直接用名册里的那一项
      if (!roster.has(asset.id)) {
        if (!file) return { ok: false, error: '缺少原文件，请重新导入这个文件' };
        const added = roster.add(asset, file);
        if (!added.ok) return { ok: false, error: added.error };
      }
      const result = roster.setRole(asset.id, 'player');
      if (!result.ok) return result;
      return { ok: true, message: `已设为主角：${roster.nameOf(asset.id)}` };
    },
    retains: (asset: ImportedAsset) => roster.owns(asset),
    inRoster: (asset: ImportedAsset) => roster.has(asset.id),
    isPlayer: (asset: ImportedAsset) => {
      const role = roster.roleOf(asset.id);
      return role !== null && isPlayerRole(role);
    },
    canonical: (asset: ImportedAsset) => roster.assetOf(asset.id) ?? asset,
    rosterStatus: (asset: ImportedAsset) => {
      if (roster.owns(asset)) return 'owned';
      const status = roster.statusOf(asset.id);
      if (status === null) return 'absent';
      return status === 'failed' ? 'failed' : 'pending';
    },
  });

  const rosterPanel = new RosterPanel(uiRoot, roster, {
    isPlaying: () => state.phase === 'playing',
    openCard: (key) => {
      const asset = roster.assetOf(key);
      if (asset) importPanel.openAsset(asset);
    },
    remove: (key) => {
      // 卡片上正打开着这个人物时先关掉卡片（名册负责释放资产）
      const asset = roster.assetOf(key);
      if (asset && importPanel.currentAsset() === asset) importPanel.close();
      void roster.remove(key);
    },
    castNotices: () => director.notices,
  });

  /** 名册变了：重新分配出场的人物，换模型，同步模拟里的同伴。 */
  const recast = () => {
    const cast = assignCast(roster.members(), state.guards.length, registry.max);
    const companions = director.apply(cast, (id) => roster.assetOf(id));
    setState(setCompanions(state, companions));
    rosterPanel.refresh();
    importPanel.refreshCard();
  };
  roster.onChange(recast);
  // 页面加载时恢复名册：每个人物的原文件重新走一遍导入流程
  void roster.restore();

  scene.onFrame((delta) => {
    importPanel.update(delta);
    rosterPanel.update();
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
    director.updateCompanions(state.companions, state.phase === 'playing', state.phase === 'paused' ? 0 : delta, renderTime);
    cameraRig.update(p.position, delta);
    hud.update(state);
  });

  return {
    snapshot: () => ({
      game: snapshotGame(state),
      camera: { yaw: cameraRig.yaw, pitch: cameraRig.pitch, lookMode: controls.lookMode(), pointerLocked: controls.pointerLocked() },
      overlay: hud.currentOverlay(),
      render: scene.stats(),
      import: importPanel.snapshot(),
      player: director.playerSnapshot(),
      instances: registry.count,
      roster: roster.snapshot(),
      cast: director.snapshot(),
    }),
  };
}

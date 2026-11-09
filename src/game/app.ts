// 把模拟、渲染、输入、HUD 接在一起。模拟按固定步长推进（advance），渲染层每帧只读最新状态。
// P5 起可以在页面里换关卡（内置、随机、已保存）：换关卡时释放旧的关卡视图和出场实例，按新的布局、规则和视觉预设重建。

import type { GameAppSnapshot, OverlayKind } from './appTypes';
import { Controls } from './input/controls';
import { builtinEntries, builtinPackage, fallbackPackage } from './levels/catalog';
import type { LevelPackage } from './levels/package';
import { RandomLevelJob } from './levels/randomJob';
import { SAVED_LEVELS_DB, SavedLevels } from './levels/saved';
import { CameraRig } from './render/cameraRig';
import { CharacterView } from './render/characterView';
import { Environment } from './render/environment';
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
import { Hud, type LevelIntro } from './ui/hud';
import { LevelSelectPanel } from './ui/levelSelect';
import type { SceneApp } from '../scene/createScene';
import { InstanceRegistry, type ImportedAsset } from '../import/asset';
import { ImportPanel, type HostResult } from '../import/ui/importPanel';
import { STAND_IN_PREFIX, assignLevelCast } from '../roster/cast';
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

/** “随机一关”的根种子：来自浏览器的密码学随机数（生成器本身只用种子，不读随机源）。 */
function randomSeed(): string {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(8, '0')).join('');
}

export function startGameApp(scene: SceneApp, initial: LevelPackage, uiRoot: HTMLElement): GameApp {
  let current: LevelPackage = initial;
  let state: GameState = createInitialState(initial.layout, [], initial.rules);
  let accumulator = 0;
  let renderTime = 0;

  const environment = new Environment(scene.scene);
  environment.apply(initial.visual);
  let levelView = new LevelView(scene.scene, state, initial.visual.theme);
  const player = new CharacterView('player', PLAYER_PALETTE);
  scene.scene.add(player.root);
  const cameraRig = new CameraRig(scene.camera, initial.layout.spawn.yaw);
  cameraRig.reset(initial.layout.spawn.yaw, state.player.position);

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

  // ---------- 导入角色（P3）和名册（P4）----------
  const registry = new InstanceRegistry();
  const roster = new Roster(new IndexedDbRosterStore());
  let director = new CastDirector({ player, guards: levelView.guards, guardIds: state.guards.map((g) => g.id), parent: scene.scene }, registry);

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

  /** 开始面板里的开场白、台词和提示。 */
  const introOf = (pkg: LevelPackage, notices: readonly string[]): LevelIntro => ({
    opening: pkg.brief?.opening ?? '',
    lines: (pkg.brief?.cast ?? [])
      .filter((c) => c.line !== '')
      .map((c) => ({
        name: roster.has(c.personId) ? roster.nameOf(c.personId) : '（已不在名册里的人物）',
        role: c.role === 'guard' ? '守卫' : '同伴',
        line: c.line,
      })),
    notices: notices.filter((n) => n.includes('默认替身')),
  });

  /**
   * 名册或关卡变了：重新分配出场的人物，换模型，同步模拟里的同伴。主角按名册；关卡说明书列了出场人物时，
   * 同伴和守卫按说明书，人物已不在名册里就用默认替身并提示（名册还在恢复时先不提示）。
   */
  const recast = () => {
    const levelCast = (current.brief?.cast ?? []).map((c) => ({ personId: c.personId, role: c.role }));
    const cast = assignLevelCast(roster.members(), levelCast, state.guards.length, registry.max);
    const shown = roster.restoring ? { ...cast, notices: cast.notices.filter((n) => !n.includes('默认替身')) } : cast;
    const companions = director.apply(shown, (id) => (id.startsWith(STAND_IN_PREFIX) ? null : roster.assetOf(id)));
    setState(setCompanions(state, companions));
    hud.setIntro(introOf(current, shown.notices));
    if (hud.currentOverlay() === 'start') hud.showOverlay('start', state);
    rosterPanel.refresh();
    importPanel.refreshCard();
  };
  roster.onChange(recast);

  // ---------- 关卡（P5）----------
  const savedLevels = new SavedLevels(new IndexedDbRosterStore(SAVED_LEVELS_DB));

  /** 换一关：释放旧的关卡视图和出场实例，按新的布局、规则和视觉预设重建，回到开始面板。不重新生成，也不重算时间。 */
  const loadLevel = (pkg: LevelPackage) => {
    director.releaseAll();
    levelView.dispose();
    current = pkg;
    controls.release();
    accumulator = 0;
    state = createInitialState(pkg.layout, [], pkg.rules);
    levelView = new LevelView(scene.scene, state, pkg.visual.theme);
    environment.apply(pkg.visual);
    director = new CastDirector({ player, guards: levelView.guards, guardIds: state.guards.map((g) => g.id), parent: scene.scene }, registry);
    cameraRig.reset(pkg.layout.spawn.yaw, state.player.position);
    hud.showOverlay('start', state);
    recast();
    levelSelect.refresh();
  };

  const levelSelect = new LevelSelectPanel(uiRoot, {
    isPlaying: () => state.phase === 'playing',
    current: () => current,
    builtins: () => builtinEntries(),
    loadBuiltin: (id) => {
      const pkg = builtinPackage(id);
      if (pkg) loadLevel(pkg);
    },
    loadPackage: (pkg) => {
      loadLevel(pkg);
    },
    startRandom: (onUpdate) => {
      const people = roster
        .members()
        .filter((m) => m.available)
        .map((m) => ({ id: m.id, name: m.name }));
      const job = new RandomLevelJob(
        {
          seed: randomSeed(),
          people,
          schedule: (step) => {
            setTimeout(step, 0);
          },
        },
        onUpdate,
      );
      job.start();
      return job;
    },
    loadFallback: () => {
      const pkg = fallbackPackage();
      loadLevel(pkg);
      return pkg;
    },
    saved: savedLevels,
  });

  hud.setIntro(introOf(current, []));
  hud.showOverlay(overlayFor(state.phase), state);
  recast();
  // 页面加载时恢复名册（每个人物的原文件重新走一遍导入流程）和已保存的关卡
  void roster.restore();
  void savedLevels.load();

  scene.onFrame((delta) => {
    importPanel.update(delta);
    rosterPanel.update();
    levelSelect.update();
    // 暂停时连装饰性的动画（宝石旋转、待机呼吸、雨）也停下
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
    const dt = state.phase === 'paused' ? 0 : delta;
    player.update(
      { position: p.position, facing: p.facing, horizontalSpeed: state.phase === 'playing' ? p.horizontalSpeed : 0, grounded: p.grounded, vy: p.vy },
      dt,
      renderTime,
    );
    levelView.update(state, dt, renderTime);
    director.updateCompanions(state.companions, state.phase === 'playing', dt, renderTime);
    environment.update(dt, p.position);
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
      level: {
        key: current.key,
        source: current.source,
        title: current.title,
        layoutHash: current.layoutHash,
        seed: current.seed,
        brief: current.brief,
        visual: current.visual,
        rules: current.rules,
        schemaVersion: current.schemaVersion,
        generatorVersion: current.generatorVersion,
        adjustment: current.adjustment ? { reason: current.adjustment.reason, change: current.adjustment.change } : null,
      },
      levels: {
        select: levelSelect.snapshot(),
        saved: savedLevels.list(),
        loading: savedLevels.loading,
        storage: { ok: savedLevels.storageProblem === null, problem: savedLevels.storageProblem },
        notices: [...savedLevels.notices],
      },
      environment: environment.snapshot(),
    }),
  };
}

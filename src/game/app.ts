// 把模拟、渲染、输入、HUD 接在一起。模拟按固定步长推进（advance），渲染层每帧只读最新状态。
// P5 起可以在页面里换关卡（内置、随机、已保存）：换关卡时释放旧的关卡视图和出场实例，按新的布局、规则和视觉预设重建。
// P6：开始界面、顶栏、主面板（同时只显示一个，见 ui/panels.ts）、音效。界面只读游戏状态，不改玩法规则。

import { Box3, Vector3, type Object3D } from 'three';
import type { GameAppSnapshot, OverlayKind, ScreenRect } from './appTypes';
import { SoundBoard } from './audio/sound';
import { Controls } from './input/controls';
import { builtinEntries, builtinPackage, fallbackPackage } from './levels/catalog';
import type { LevelPackage } from './levels/package';
import { RandomLevelJob } from './levels/randomJob';
import { SAVED_LEVELS_DB, SavedLevels } from './levels/saved';
import { builtinTitle, displayOpening, displayTitle } from './levels/titles';
import { setBeforeLangSwitch } from '../i18n/browser';
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
import { estimateDifficulty, sourceBadge } from './ui/levelInfo';
import { LevelSelectPanel } from './ui/levelSelect';
import { WorkshopPanel } from './ui/workshopPanel';
import type { SceneApp } from '../scene/createScene';
import { InstanceRegistry, type ImportedAsset } from '../import/asset';
import { ImportPanel, type HostResult } from '../import/ui/importPanel';
import { STAND_IN_PREFIX, assignLevelCast, isStandInNotice } from '../roster/cast';
import { isPlayerRole } from '../roster/config';
import { CastDirector } from '../roster/director';
import { IndexedDbRosterStore } from '../roster/idbStore';
import { Roster } from '../roster/roster';
import { RosterPanel } from '../roster/ui/rosterPanel';
import { ThumbnailRenderer } from '../roster/ui/thumbnails';
import { PanelManager } from '../ui/panels';
import { HomeScreen, TopBar } from '../ui/shell';
import { t } from '../i18n';

export type { GameAppSnapshot } from './appTypes';

export interface GameApp {
  snapshot(): GameAppSnapshot;
}

export interface GameAppOptions {
  /** 先显示开始界面（没有 ?level= 时）；为 false 时直接进入这一关的开始面板（开发和测试用的 ?level=）。 */
  readonly home: boolean;
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

/** 屏幕上的包围框：物体的世界包围盒的 8 个角投影到画面上（CSS 像素）。 */
function screenRectOf(object: Object3D, scene: SceneApp, box: Box3, corner: Vector3): { rect: ScreenRect; depth: number } | null {
  box.setFromObject(object);
  if (box.isEmpty()) return null;
  const canvas = scene.renderer.domElement;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(scene.camera);
    const x = ((corner.x + 1) / 2) * w;
    const y = ((1 - corner.y) / 2) * h;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const depth = box.getCenter(corner).distanceTo(scene.camera.position);
  return { rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, depth };
}

export function startGameApp(scene: SceneApp, initial: LevelPackage, uiRoot: HTMLElement, options: GameAppOptions = { home: false }): GameApp {
  let current: LevelPackage = initial;
  let state: GameState = createInitialState(initial.layout, [], initial.rules);
  let accumulator = 0;
  let renderTime = 0;
  /** 处在开始界面这一层（P6）：开始界面本身，或者从开始界面打开的面板。 */
  let homeMode = options.home;

  const sound = new SoundBoard();
  const panels = new PanelManager();
  const environment = new Environment(scene.scene);
  environment.apply(initial.visual);
  environment.setLevelSize(initial.layout.size.width, initial.layout.size.depth);
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
      if (state.phase === 'won') sound.play('win');
      if (state.phase === 'lost') sound.play('lose');
      syncLayout();
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
    onHome: () => {
      // 回到开始界面：关掉打开着的主面板（名册、导入卡片等），这一关重置到开局（和“重开”一样），
      // 停在开始面板，开始界面盖在上面
      panels.closeAll();
      homeMode = true;
      const fresh = restartGame(state);
      cameraRig.reset(fresh.level.spawn.yaw, fresh.player.position);
      accumulator = 0;
      setState(fresh);
      syncLayout();
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
    cardOpened: () => {
      panels.open('import');
    },
    cardClosed: () => {
      panels.close('import');
    },
    addPerson: (asset, file): HostResult => {
      if (!roster.has(asset.id) && !file) return { ok: false, error: t('app.missingFile') };
      const result = roster.add(asset, file ?? new Blob());
      return result.ok ? { ok: true, message: t('app.addedToRoster', { name: asset.fileName }) } : { ok: false, error: result.error };
    },
    setPlayer: (asset, file): HostResult => {
      // 还不在名册里就先加入，再设为主角；同一个文件已在名册里时直接用名册里的那一项
      if (!roster.has(asset.id)) {
        if (!file) return { ok: false, error: t('app.missingFile') };
        const added = roster.add(asset, file);
        if (!added.ok) return { ok: false, error: added.error };
      }
      const result = roster.setRole(asset.id, 'player');
      if (!result.ok) return result;
      return { ok: true, message: t('app.setAsPlayer', { name: roster.nameOf(asset.id) }) };
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

  const thumbnails = new ThumbnailRenderer();
  const rosterPanel = new RosterPanel(
    uiRoot,
    roster,
    {
      close: () => {
        panels.close('roster');
      },
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
    },
    thumbnails,
  );

  /** 开始面板里的开场白、台词和提示。 */
  const introOf = (pkg: LevelPackage, notices: readonly string[]): LevelIntro => ({
    // 内置关卡的开场白按 id 翻译；其他关卡的开场白是生成的文字，原样显示（F6）
    opening: displayOpening(pkg).text,
    openingRaw: displayOpening(pkg).raw,
    lines: (pkg.brief?.cast ?? [])
      .filter((c) => c.line !== '')
      .map((c) => ({
        name: roster.has(c.personId) ? roster.nameOf(c.personId) : t('app.notInRoster'),
        role: c.role === 'guard' ? t('role.guard') : t('role.companion'),
        line: c.line,
      })),
    notices: notices.filter((n) => isStandInNotice(n)),
  });

  /**
   * 名册或关卡变了：重新分配出场的人物，换模型，同步模拟里的同伴。主角按名册；关卡说明书列了出场人物时，
   * 同伴和守卫按说明书，人物已不在名册里就用默认替身并提示（名册还在恢复时先不提示）。
   * F3：工坊生成的关卡（来源 model）出场人物以说明书为准，没列人物就没有同伴、守卫用默认小人（没勾选的人不出场）。
   */
  const recast = () => {
    const levelCast = (current.brief?.cast ?? []).map((c) => ({ personId: c.personId, role: c.role }));
    const cast = assignLevelCast(roster.members(), levelCast, state.guards.length, registry.max, { castIsExplicit: current.source === 'model' });
    const shown = roster.restoring ? { ...cast, notices: cast.notices.filter((n) => !isStandInNotice(n)) } : cast;
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
  // 切换语言会刷新页面：先等名册和已保存关卡的写入同时做完（F6 第 1、2 轮审查后）
  setBeforeLangSwitch({
    idle: () => !roster.saving && !savedLevels.saving,
    waitIdle: () => Promise.all([roster.whenIdle(), savedLevels.whenIdle()]),
  });

  const builtinKindOf = (pkg: LevelPackage) => builtinEntries().find((e) => pkg.key === `builtin:${e.id}`)?.kind;

  /** 当前关卡的来源和难度估计：顶栏、开始界面、开始面板都显示。 */
  const showLevelInfo = () => {
    const source = sourceBadge(current, builtinKindOf(current));
    const difficulty = estimateDifficulty(current).label;
    hud.setBadges({ source, difficulty });
    // 内置关卡按 id 翻译名字；其他关卡的标题原样显示（F6）
    const title = displayTitle(current);
    hud.setTitle(title.text, title.raw);
    topBar.setLevel(title.text, title.raw);
    home.setLevel({ title: title.text, titleRaw: title.raw, source, difficulty });
  };

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
    environment.setLevelSize(pkg.layout.size.width, pkg.layout.size.depth);
    director = new CastDirector({ player, guards: levelView.guards, guardIds: state.guards.map((g) => g.id), parent: scene.scene }, registry);
    cameraRig.reset(pkg.layout.spawn.yaw, state.player.position);
    // 选好一关就离开开始界面，显示这一关的开始面板
    homeMode = false;
    showLevelInfo();
    hud.showOverlay('start', state);
    recast();
    levelSelect.refresh();
    syncLayout();
  };

  // ---------- 关卡工坊（P8）：模型填说明书，程序生成并检查；确认后用 P5 的保存模块写进浏览器 ----------
  const workshop = new WorkshopPanel({
    people: () => roster.members().filter((m) => m.available).map((m) => ({ id: m.id, name: m.name })),
    applyLevel: (pkg) => {
      const result = savedLevels.save(pkg);
      const saved = result.ok ? savedLevels.get(result.id) : null;
      loadLevel(saved ?? pkg);
      panels.close('levels');
    },
    applyFallback: () => {
      const pkg = fallbackPackage();
      loadLevel(pkg);
      return pkg;
    },
    startRandom: () => {
      levelSelect.startRandom();
    },
  });

  const levelSelect = new LevelSelectPanel(uiRoot, {
    workshop: {
      root: workshop.root,
      onShown: () => {
        workshop.refresh();
      },
    },
    current: () => current,
    builtins: () => builtinEntries().map((e) => ({ ...e, title: builtinTitle(e.id) ?? e.title })),
    builtinPackage: (id) => builtinPackage(id),
    close: () => {
      panels.close('levels');
    },
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

  // ---------- 外壳（P6）：顶栏、开始界面、主面板 ----------
  const topBar = new TopBar(
    uiRoot,
    {
      onLevels: () => {
        panels.toggle('levels');
      },
      onRoster: () => {
        panels.toggle('roster');
      },
    },
    importPanel.importButton,
    sound,
  );
  const home = new HomeScreen(
    uiRoot,
    {
      onStart: () => {
        homeMode = false;
        syncLayout();
      },
      onLevels: () => {
        panels.open('levels');
      },
      onRoster: () => {
        panels.open('roster');
      },
      onImport: () => {
        importPanel.chooseFile();
      },
    },
    sound,
  );
  panels.register('levels', {
    setShown: (shown) => {
      levelSelect.setShown(shown);
    },
    focusFirst: () => {
      levelSelect.focusFirst();
    },
  });
  panels.register('roster', {
    setShown: (shown) => {
      rosterPanel.setShown(shown);
    },
    focusFirst: () => {
      rosterPanel.focusFirst();
    },
  });
  panels.register('import', {
    setShown: (shown) => {
      importPanel.setShown(shown);
    },
    focusFirst: () => {
      importPanel.focusFirst();
    },
    dismiss: () => {
      importPanel.close();
    },
  });

  /**
   * 按当前状态摆放界面：同时只显示一个主面板（M7）。关卡选择打开时开始面板隐藏；名册（左）和导入卡片（右）打开时，
   * 开始面板、暂停菜单和结算让到另一侧。开始界面这一层不显示顶栏和 HUD。游玩中只显示 HUD。
   */
  function syncLayout(): void {
    const playing = state.phase === 'playing';
    panels.setSuspended(playing);
    const shown = panels.shown;
    home.setVisible(homeMode && shown === null && !playing, true);
    topBar.setVisible(!homeMode && !playing);
    topBar.setPanel(shown === 'levels', shown === 'roster');
    hud.setHudVisible(!homeMode);
    hud.setDock(shown === 'roster' ? 'right' : shown === 'import' ? 'left' : 'center');
    hud.setSuppressed(homeMode || shown === 'levels');
  }
  panels.onChange(syncLayout);

  // 按钮的音效：页面里任何按钮被点击（鼠标或键盘）都响一下
  // （捕获阶段：覆盖层的按钮会阻止点击继续冒泡）
  uiRoot.addEventListener(
    'click',
    (e) => {
      if (e.target instanceof Element && e.target.closest('button')) sound.play('button');
    },
    { capture: true },
  );

  hud.setIntro(introOf(current, []));
  showLevelInfo();
  hud.showOverlay(overlayFor(state.phase), state);
  syncLayout();
  recast();
  // 页面加载时恢复名册（每个人物的原文件重新走一遍导入流程）和已保存的关卡
  void roster.restore();
  void savedLevels.load();

  const box = new Box3();
  const corner = new Vector3();

  scene.onFrame((delta) => {
    importPanel.update(delta);
    // 暂停时连装饰性的动画（宝石旋转、待机呼吸、雨）也停下
    if (state.phase !== 'paused') renderTime += delta;
    if (state.phase === 'playing') {
      const look = controls.lookKeys();
      cameraRig.turn(look.turn, look.tilt, delta);
      const axes = controls.axes();
      const collectedBefore = state.collected.length;
      const result = advance(state, { ...axes, cameraYaw: cameraRig.yaw }, accumulator, delta);
      accumulator = result.accumulator;
      if (result.steps > 0) controls.consumeJump();
      if (result.state.collected.length > collectedBefore) sound.play('collect');
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
    cameraRig.update(p.position, delta);
    environment.update(dt, p.position, scene.camera.position);
    if (hud.update(state)) sound.play('penalty');
  });

  /** 主角和同伴在屏幕上的包围框（只读）。 */
  const screenSnapshot = (): GameAppSnapshot['screen'] => {
    scene.scene.updateMatrixWorld();
    const canvas = scene.renderer.domElement;
    const playerBox = screenRectOf(player.root, scene, box, corner);
    const companions = director.companionRoots().map((root) => screenRectOf(root, scene, box, corner));
    return {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      player: playerBox?.rect ?? null,
      companions: companions.map((c) => c?.rect ?? null),
      depth: { player: playerBox?.depth ?? null, companions: companions.map((c) => c?.depth ?? null) },
    };
  };

  return {
    snapshot: () => ({
      game: snapshotGame(state),
      camera: { yaw: cameraRig.yaw, pitch: cameraRig.pitch, lookMode: controls.lookMode(), pointerLocked: controls.pointerLocked() },
      overlay: hud.currentOverlay(),
      render: scene.stats(),
      import: importPanel.snapshot(),
      player: director.playerSnapshot(),
      instances: registry.count,
      importedInstances: director.importedInstances(),
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
        sourceLabel: sourceBadge(current, builtinKindOf(current)).text,
        difficulty: estimateDifficulty(current).label,
      },
      levels: {
        select: levelSelect.snapshot(),
        saved: savedLevels.list(),
        loading: savedLevels.loading,
        storage: { ok: savedLevels.storageProblem === null, problem: savedLevels.storageProblem },
        notices: [...savedLevels.notices],
        workshop: workshop.snapshot(),
      },
      environment: environment.snapshot(),
      ui: {
        home: home.visible,
        homeMode,
        panel: panels.shown,
        panelStack: panels.stack,
        overlayVisible: hud.overlayShown,
        overlayDock: hud.dock,
        topBar: !topBar.root.hidden,
        hud: hud.hudShown,
        thumbnails: thumbnails.snapshot(),
      },
      audio: sound.snapshot(),
      screen: screenSnapshot(),
    }),
  };
}

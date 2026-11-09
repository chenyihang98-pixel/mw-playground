// P6 界面的端到端测试：开始界面和 ?level= 直接进入、只用键盘操作主菜单、静音开关（含 localStorage 抛错）、
// 1280×720 和 1920×1080 下的布局（主要元素看得见、不重叠、不溢出；关卡选择和关卡开始面板不同时显示）、
// 同伴不挡住主角、名册缩略图不写进存储、各界面的截图（存到 Playwright 的输出目录，不提交）。
// 夹具先写到系统临时目录，再经文件选择框导入；测试结束后删除。只读测试钩子，不改状态。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildFixture, type FixtureId } from '../../src/asset/fixtures';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import type { GameAppSnapshot, ScreenRect } from '../../src/game/appTypes';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

/** 同伴的包围框盖住主角包围框的面积，不能超过主角包围框面积的这个比例（docs/status.md 的 P6 一节有说明）。 */
const OCCLUSION_LIMIT = 0.1;

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
] as const;

let dir: string;
const files: Record<string, string> = {};

/**
 * 同一个 GLB 的另一份字节不同的副本：JSON 块末尾多补 4n 个空格（JSON 内容不变）。SHA-256 不同，名册里算不同的人物，
 * 用来得到三个人形的同伴。
 */
function glbVariant(bytes: Uint8Array, n: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const extra = 4 * n;
  const out = new Uint8Array(bytes.byteLength + extra);
  out.set(bytes.subarray(0, 20 + jsonLength), 0);
  out.fill(0x20, 20 + jsonLength, 20 + jsonLength + extra);
  out.set(bytes.subarray(20 + jsonLength), 20 + jsonLength + extra);
  const outView = new DataView(out.buffer);
  outView.setUint32(8, out.byteLength, true);
  outView.setUint32(12, jsonLength + extra, true);
  return out;
}

const COMPANIONS = ['companion-a.glb', 'companion-b.glb', 'companion-c.glb'] as const;

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-playground-ui-e2e-'));
  COMPANIONS.forEach((name, i) => {
    const path = join(dir, name);
    writeFileSync(path, glbVariant(buildFixture('skinned-humanoid'), i + 1));
    files[name] = path;
  });
  const fixtures: [string, FixtureId][] = [
    ['skinned-humanoid.glb', 'skinned-humanoid'],
    ['static-mesh.glb', 'static-mesh'],
    ['textured.glb', 'textured'],
  ];
  for (const [name, id] of fixtures) {
    const path = join(dir, name);
    writeFileSync(path, buildFixture(id));
    files[name] = path;
  }
});

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(page: Page): Promise<GameAppSnapshot> {
  return page.evaluate(() => {
    const hooks = window.__MW_TEST__ as Hooks | undefined;
    if (hooks?.kind !== 'game') throw new Error('游戏测试钩子不存在');
    return hooks.getState();
  });
}

/** 打开页面，等测试钩子装好、名册和已保存的关卡读完。 */
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
  await expect
    .poll(async () => {
      const s = await read(page);
      return !s.roster.restoring && !s.levels.loading;
    })
    .toBe(true);
}

async function chooseFile(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入角色' }).click();
  await (await chooser).setFiles(files[name] ?? '');
  await expect.poll(async () => (await read(page)).import.busy).toBe(false);
}

async function openRoster(page: Page) {
  await page.getByRole('button', { name: '名册', exact: true }).click();
  await expect.poll(async () => (await read(page)).ui.panel).toBe('roster');
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const locator = page.locator(selector);
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${selector} 不可见`);
  return box;
}

function overlapArea(a: Box | ScreenRect, b: Box | ScreenRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 几个元素都在窗口里、两两不重叠。 */
async function expectLayout(page: Page, selectors: readonly string[], size: { width: number; height: number }) {
  const boxes = await Promise.all(selectors.map(async (s) => [s, await boxOf(page, s)] as const));
  for (const [s, b] of boxes) {
    expect(b.x, `${s} 左边超出窗口`).toBeGreaterThanOrEqual(-0.5);
    expect(b.y, `${s} 上边超出窗口`).toBeGreaterThanOrEqual(-0.5);
    expect(b.x + b.width, `${s} 右边超出窗口`).toBeLessThanOrEqual(size.width + 0.5);
    expect(b.y + b.height, `${s} 下边超出窗口`).toBeLessThanOrEqual(size.height + 0.5);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [sa, a] = boxes[i] ?? ['', { x: 0, y: 0, width: 0, height: 0 }];
      const [sb, b] = boxes[j] ?? ['', { x: 0, y: 0, width: 0, height: 0 }];
      expect(overlapArea(a, b), `${sa} 和 ${sb} 重叠`).toBe(0);
    }
  }
  // 页面不横向滚动，主面板里没有横向溢出
  const overflow = await page.evaluate((list) => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push('页面');
    for (const s of list) {
      const el = document.querySelector(s);
      if (el && el.scrollWidth > el.clientWidth + 1) out.push(s);
    }
    return out;
  }, selectors);
  expect(overflow).toEqual([]);
}

const TOP_LEFT = '#mw-topbar-left';
const TOP_RIGHT = '#mw-topbar-right';
const HUD = '#hud';
const OVERLAY = '#game-overlay .panel';

let consoleErrors: string[];

test.beforeEach(({ page }) => {
  consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`pageerror: ${error.message}`);
  });
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

test('没有 ?level= 时先显示开始界面，“开始”进入当前关卡（默认草地）的开始面板', async ({ page }) => {
  await open(page, '/');
  const home = await read(page);
  expect(home.ui).toMatchObject({ home: true, homeMode: true, overlayVisible: false, topBar: false, hud: false, panel: null });
  expect(home.level.key).toBe('builtin:meadow');
  expect(home.game.phase).toBe('ready');
  await expect(page.getByRole('heading', { name: '宝石游乐场' })).toBeVisible();
  for (const name of ['开始', '选择关卡', '名册', '导入角色', '操作说明', '静音']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('dialog')).toBeHidden();
  // 操作说明可以展开
  await page.getByRole('button', { name: '操作说明', exact: true }).click();
  await expect(page.locator('#home-help')).toContainText('按相机方向移动');

  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect.poll(async () => (await read(page)).ui.home).toBe(false);
  const start = await read(page);
  expect(start.ui).toMatchObject({ homeMode: false, overlayVisible: true, topBar: true, hud: true });
  expect(start.overlay).toBe('start');
  expect(start.game.phase).toBe('ready');
  await expect(page.getByRole('dialog')).toContainText('草地');
  await expect(page.getByRole('dialog')).toContainText('难度估计');
});

test('?level= 直接进入这一关的开始面板（开发和测试用），不经过开始界面', async ({ page }) => {
  await open(page, '/?level=test-b');
  const s = await read(page);
  expect(s.ui).toMatchObject({ home: false, homeMode: false, overlayVisible: true, topBar: true });
  expect(s.level.key).toBe('builtin:test-b');
  await expect(page.locator('#mw-home')).toBeHidden();
  await expect(page.getByRole('dialog')).toContainText('测试小关 B');
  // 结算后“返回”回到开始界面
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  await page.getByRole('button', { name: '返回开始界面' }).click();
  await expect.poll(async () => (await read(page)).ui.home).toBe(true);
  const back = await read(page);
  expect(back.game.phase).toBe('ready');
  expect(back.game.simTime).toBe(0);
  expect(back.level.key).toBe('builtin:test-b');
});

test('暂停时打开名册、结算时打开导入卡片，再“返回开始界面”：主面板一起关掉，开始界面出现', async ({ page }) => {
  await open(page, '/?level=test-a');
  // 暂停菜单 + 名册（暂停菜单让到右边）
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  await openRoster(page);
  expect((await read(page)).ui.overlayDock).toBe('right');
  await page.getByRole('button', { name: '返回开始界面' }).click();
  await expect.poll(async () => (await read(page)).ui.home).toBe(true);
  let s = await read(page);
  expect(s.ui).toMatchObject({ homeMode: true, panel: null, panelStack: [], topBar: false });
  expect(s.game.phase).toBe('ready');
  await expect(page.locator('#roster-panel')).toBeHidden();
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeFocused();

  // 结算 + 导入卡片（结算让到左边），名册也在栈里
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
  await page.keyboard.up('KeyW');
  await openRoster(page);
  await chooseFile(page, 'static-mesh.glb');
  s = await read(page);
  expect(s.ui).toMatchObject({ panel: 'import', panelStack: ['roster', 'import'], overlayDock: 'left' });
  await page.getByRole('button', { name: '返回开始界面' }).click();
  await expect.poll(async () => (await read(page)).ui.home).toBe(true);
  s = await read(page);
  expect(s.ui).toMatchObject({ homeMode: true, panel: null, panelStack: [] });
  // 没加入名册的导入卡片随之关掉（和点“关闭”一样）
  expect(s.import.card).toBeNull();
  await expect(page.locator('#import-card')).toBeHidden();
  // 从开始界面再进入：开始面板正常显示
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect.poll(async () => (await read(page)).ui.overlayVisible).toBe(true);
  expect((await read(page)).game.phase).toBe('ready');
});

test('导入卡片上的贴图尺寸逐张完整显示（不截断）', async ({ page }) => {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await open(page, '/?level=test-a');
    await chooseFile(page, 'textured.glb');
    const card = (await read(page)).import.card;
    const textures = (card?.textures ?? []).map((t) => `${String(t.width)}×${String(t.height)}`);
    expect(textures.length).toBeGreaterThan(0);
    const stat = page.locator('#import-card .card-stat--wide');
    await expect(stat).toContainText(`贴图（${String(textures.length)} 张）`);
    await expect(stat.locator('dd')).toHaveText(textures.join('、'));
    // 文字没有被裁掉：内容不比格子宽，也不比格子高
    const clipped = await stat.locator('dd').evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    expect(clipped).toBe(false);
  }
});

test('只用键盘：开始界面 → 选关 → 加载一关 → 开始 → 暂停 → 继续；Esc 关掉主面板；焦点看得见', async ({ page }) => {
  await open(page, '/');
  const focusRing = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el === document.body) return null;
      return { label: el.getAttribute('aria-label') ?? el.textContent.trim(), ring: getComputedStyle(el).boxShadow, visible: el.matches(':focus-visible') };
    });
  // 开始界面一出现焦点就在“开始”上
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '选择关卡' })).toBeFocused();
  /** 按 Tab 直到焦点到达名字为 label 的控件（最多 max 次）。 */
  const tabTo = async (label: string, max = 12) => {
    for (let i = 0; i < max; i++) {
      if ((await focusRing())?.label === label) return;
      await page.keyboard.press('Tab');
    }
  };
  const ring = await focusRing();
  expect(ring?.visible).toBe(true);
  expect(ring?.ring).toContain('rgb(255, 215, 106)');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await read(page)).ui.panel).toBe('levels');
  // 焦点进到关卡选择里（当前关卡），用 Tab 走到“测试小关 A”
  await expect(page.getByRole('button', { name: '加载内置关卡 草地' })).toBeFocused();
  await tabTo('加载内置关卡 测试小关 A');
  await expect(page.getByRole('button', { name: '加载内置关卡 测试小关 A' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await read(page)).level.key).toBe('builtin:test-a');
  const loaded = await read(page);
  expect(loaded.ui).toMatchObject({ panel: null, home: false, overlayVisible: true });
  // 开始面板出现时焦点在“开始”上
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  // P 暂停；Tab 进入暂停菜单，焦点在“继续”上，Enter 继续
  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  await expect.poll(async () => (await read(page)).camera.pointerLocked).toBe(false);
  await tabTo('继续');
  await expect(page.getByRole('button', { name: '继续' })).toBeFocused();
  expect((await focusRing())?.visible).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  // 焦点在暂停菜单的按钮上时，P 仍然是继续
  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  await expect.poll(async () => (await read(page)).camera.pointerLocked).toBe(false);
  await tabTo('重开');
  await expect(page.getByRole('button', { name: '重开' })).toBeFocused();
  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  // 再暂停，用 Tab 走到顶栏的“名册”，Enter 打开，Esc 关掉，焦点回到“名册”
  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  await expect.poll(async () => (await read(page)).camera.pointerLocked).toBe(false);
  await tabTo('名册');
  await expect(page.getByRole('button', { name: '名册', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await read(page)).ui.panel).toBe('roster');
  await expect(page.getByRole('button', { name: '关闭名册' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).ui.panel).toBeNull();
  // Esc 只关面板，游戏仍在暂停
  expect((await read(page)).game.phase).toBe('paused');
  await expect(page.getByRole('button', { name: '名册', exact: true })).toBeFocused();
});

test('静音开关存进 localStorage，刷新后还在；音效按事件触发', async ({ page }) => {
  await open(page, '/?level=test-a');
  const before = await read(page);
  expect(before.audio).toMatchObject({ muted: false, persisted: true });
  const mute = page.getByRole('button', { name: '静音', exact: true });
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  expect((await read(page)).audio).toMatchObject({ muted: true, persisted: true });
  expect(await page.evaluate(() => localStorage.getItem('mw-playground:muted'))).toBe('1');
  await page.reload();
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
  expect((await read(page)).audio.muted).toBe(true);
  await expect(page.getByRole('button', { name: '静音', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '静音', exact: true }).click();
  expect((await read(page)).audio.muted).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('mw-playground:muted'))).toBe('0');

  // 音效：点按钮、收集、胜利各触发一次（静音时也计数）
  const played = (await read(page)).audio.played;
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
  await page.keyboard.up('KeyW');
  const after = (await read(page)).audio.played;
  expect(after.button).toBeGreaterThan(played.button);
  expect(after.collect).toBe(played.collect + 1);
  expect(after.win).toBe(played.win + 1);
  expect(after.lose).toBe(played.lose);
});

test('localStorage 读写都抛错：按没有静音处理（点静音也不静音），游戏照常', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('测试：禁止使用 localStorage', 'SecurityError');
      },
    });
  });
  await open(page, '/?level=test-a');
  expect((await read(page)).audio).toMatchObject({ muted: false, persisted: false });
  await page.getByRole('button', { name: '静音', exact: true }).click();
  expect((await read(page)).audio).toMatchObject({ muted: false, persisted: false });
  await expect(page.getByRole('button', { name: '静音', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
  await page.keyboard.up('KeyW');
  expect((await read(page)).game.collectedCount).toBe(1);
});

test('同伴不挡住主角：三个同伴分别在左后、右后、更靠后的左后，屏幕上的包围框盖住主角不超过 10%', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, '/?level=test-a');
  for (const name of COMPANIONS) {
    await chooseFile(page, name);
    await page.getByRole('button', { name: '加入为新人物' }).click();
  }
  await expect.poll(async () => (await read(page)).roster.entries.length).toBe(3);
  await openRoster(page);
  for (const name of COMPANIONS) {
    await page.getByRole('combobox', { name: `${name} 的分工` }).selectOption('companion');
  }
  await expect.poll(async () => (await read(page)).game.companions.length).toBe(3);
  // 改分工会重新分配、重画开始面板，但焦点留在名册的下拉框上（不被开始面板抢走）
  const third = page.getByRole('combobox', { name: `${COMPANIONS[2]} 的分工` });
  await third.focus();
  await third.selectOption('none');
  await expect.poll(async () => (await read(page)).game.companions.length).toBe(2);
  await third.selectOption('companion');
  await expect.poll(async () => (await read(page)).game.companions.length).toBe(3);
  await expect(third).toBeFocused();
  await page.keyboard.press('Escape'); // 关名册，导入卡片回来
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect.poll(async () => (await read(page)).ui.panel).toBeNull();

  const coverage = (s: GameAppSnapshot) => {
    const player = s.screen.player;
    if (!player) throw new Error('主角不在屏幕上');
    return s.screen.companions.map((c) => (c ? overlapArea(player, c) / (player.width * player.height) : 0));
  };
  // 开局：同伴站在跟随目标点上
  const ready = await read(page);
  expect(ready.screen.companions).toHaveLength(3);
  console.log(`开局的遮挡比例：${coverage(ready).map((r) => r.toFixed(3)).join(' / ')}`);
  for (const ratio of coverage(ready)) expect(ratio).toBeLessThanOrEqual(OCCLUSION_LIMIT);

  // 往前走一段再停下：同伴跟上来，停在目标点附近
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.player.z, { timeout: 5_000 }).toBeGreaterThan(-4.5);
  await page.keyboard.up('KeyW');
  await expect
    .poll(async () => (await read(page)).game.companions.every((c) => !c.following), { timeout: 10_000 })
    .toBe(true);
  const stopped = await read(page);
  const ratios = coverage(stopped);
  console.log(`停下后的遮挡比例：${ratios.map((r) => r.toFixed(3)).join(' / ')}`);
  for (const ratio of ratios) expect(ratio).toBeLessThanOrEqual(OCCLUSION_LIMIT);
  // 同伴 0 在左后方，同伴 1 在右后方（屏幕上：主角面向画面里面，左边在屏幕左侧）
  const player = stopped.screen.player;
  const [c0, c1, c2] = stopped.screen.companions;
  if (!player || !c0 || !c1 || !c2) throw new Error('包围框缺失');
  const center = (r: ScreenRect) => r.x + r.width / 2;
  expect(center(c0)).toBeLessThan(center(player));
  expect(center(c1)).toBeGreaterThan(center(player));
  expect(center(c2)).toBeLessThan(center(player));
  await page.screenshot({ path: testInfo.outputPath('companions-three.png') });
});

test('导入卡片：没有骨骼的模型说“静止姿态”，不说“绑定姿态”；提示分三级（M3）', async ({ page }) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, 'static-mesh.glb');
  const card = (await read(page)).import.card;
  expect(card?.skinned).toBe(false);
  expect(card?.plan.idle).toBe('静止姿态');
  expect(card?.notices).toContain('没有“待机”的片段：使用静止姿态');
  expect(card?.notices.some((n) => n.includes('绑定姿态'))).toBe(false);
  expect(card?.noticeLevels.map((n) => n.level)).toEqual(expect.arrayContaining(['warning', 'info']));
  await expect(page.locator('#import-card')).toContainText('静止姿态');
  await expect(page.locator('#import-card')).not.toContainText('绑定姿态');
  await expect(page.locator('#import-notices [data-level="warning"]').first()).toBeVisible();
  await expect(page.locator('#import-notices [data-level="info"]').first()).toBeVisible();
  // 导入失败是错误级的提示
  writeFileSync(join(dir, 'broken.glb'), buildFixture('corrupt-truncated'));
  files['broken.glb'] = join(dir, 'broken.glb');
  await chooseFile(page, 'broken.glb');
  await expect(page.getByRole('alert').filter({ hasText: '导入失败' })).toBeVisible();
});

test('名册卡片的缩略图在名册恢复完以后生成，只在内存里，不写进存储', async ({ page }) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, 'skinned-humanoid.glb');
  await page.getByRole('button', { name: '加入为新人物' }).click();
  await chooseFile(page, 'static-mesh.glb');
  await page.getByRole('button', { name: '加入为新人物' }).click();
  await expect.poll(async () => (await read(page)).roster.saving).toBe(false);
  await page.reload();
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
  // 恢复期间不画
  await expect.poll(async () => (await read(page)).roster.restoring).toBe(false);
  await expect.poll(async () => (await read(page)).ui.thumbnails.rendered).toBe(2);
  await openRoster(page);
  await expect(page.locator('#roster-list .person-thumb img')).toHaveCount(2);
  for (const img of await page.locator('#roster-list .person-thumb img').all()) await expect(img).toBeVisible();
  // 存储里的记录没有缩略图
  const stored = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('mw-playground');
        request.onerror = () => {
          reject(new Error('打不开 IndexedDB'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const all = db.transaction('roster', 'readonly').objectStore('roster').getAll();
          all.onsuccess = () => {
            const text = JSON.stringify(all.result);
            db.close();
            resolve(text);
          };
          all.onerror = () => {
            reject(new Error('读不了名册'));
          };
        };
      }),
  );
  expect(stored).toContain('skinned-humanoid.glb');
  expect(stored).not.toContain('data:image');
  expect(stored.toLowerCase()).not.toContain('thumb');
});

for (const size of SIZES) {
  const tag = `${String(size.width)}x${String(size.height)}`;
  test(`布局和截图 ${tag}：主要元素不重叠、不溢出，关卡选择和开始面板不同时显示`, async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`p6-${tag}-${name}.png`) });
    await page.setViewportSize(size);

    // 开始界面
    await open(page, '/');
    await expectLayout(page, ['#mw-home .home-card'], size);
    await shot('01-home');

    // 关卡选择（从开始界面打开）：开始面板不显示
    await page.getByRole('button', { name: '选择关卡' }).click();
    await expect.poll(async () => (await read(page)).ui.panel).toBe('levels');
    await expect(page.getByRole('dialog')).toBeHidden();
    expect((await read(page)).ui.overlayVisible).toBe(false);
    await expectLayout(page, ['#level-panel'], size);
    const entries = (await read(page)).levels.select.entries;
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const e of entries) {
      expect(e.source).not.toBe('');
      expect(e.difficulty).not.toBeNull();
    }
    await shot('02-level-select');

    // 选一关：关卡选择关掉，开始面板出现
    await page.getByRole('button', { name: '加载内置关卡 晨光草地' }).click();
    await expect.poll(async () => (await read(page)).level.key).toBe('builtin:gen-1');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#level-panel')).toBeHidden();
    await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, OVERLAY], size);
    await shot('03-start-panel');

    // 开始面板显示时再打开关卡选择：开始面板让位（隐藏），两者不同时显示（M7）
    await page.getByRole('button', { name: '选择关卡' }).click();
    await expect(page.locator('#level-panel')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();
    expect((await read(page)).ui).toMatchObject({ panel: 'levels', overlayVisible: false });
    await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, '#level-panel'], size);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeVisible();

    // 导入卡片（带骨骼）：开始面板让到左边
    await chooseFile(page, 'skinned-humanoid.glb');
    await expect.poll(async () => (await read(page)).ui.overlayDock).toBe('left');
    await expect(page.locator('#import-status')).toBeVisible();
    await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, OVERLAY, '#import-card', '#mw-toasts'], size);
    await shot('04-import-skinned');
    await page.getByRole('button', { name: '加入为新人物' }).click();

    // 导入卡片（静态模型）
    await chooseFile(page, 'static-mesh.glb');
    await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, OVERLAY, '#import-card'], size);
    await shot('05-import-static');
    await page.getByRole('button', { name: '加入为新人物' }).click();

    // 名册：导入卡片让位（隐藏），开始面板让到右边；带骨骼的人物设为同伴
    await openRoster(page);
    await expect(page.locator('#import-card')).toBeHidden();
    expect((await read(page)).ui.overlayDock).toBe('right');
    await page.getByRole('combobox', { name: 'skinned-humanoid.glb 的分工' }).selectOption('companion');
    await expect.poll(async () => (await read(page)).ui.thumbnails.rendered).toBeGreaterThanOrEqual(2);
    await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, OVERLAY, '#roster-panel'], size);
    await shot('06-roster');
    await page.getByRole('button', { name: '关闭名册' }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect.poll(async () => (await read(page)).ui.panel).toBeNull();

    // 游玩中的 HUD，同伴跟随
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
    expect((await read(page)).ui.topBar).toBe(false);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(900);
    await page.keyboard.up('KeyW');
    await expect.poll(async () => (await read(page)).game.companions.every((c) => !c.following), { timeout: 10_000 }).toBe(true);
    await expectLayout(page, [HUD], size);
    await expect(page.locator('#hud-hint')).toContainText('Esc 暂停');
    await shot('07-hud-companion');

    // 暂停菜单
    await page.keyboard.press('KeyP');
    await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
    await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, OVERLAY], size);
    await shot('08-pause');

    // 守卫扣时的反馈（测试小关 B：站着不动）
    await open(page, '/?level=test-b');
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(async () => (await read(page)).game.hits.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    const penalty = (await read(page)).level.rules.penaltySeconds;
    await expect(page.locator('#hud-penalty')).toHaveText(`−${String(penalty)} 秒`);
    await shot('09-hud-penalty');

    // 胜利结算
    await open(page, '/?level=test-a');
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await page.keyboard.down('KeyW');
    await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
    await page.keyboard.up('KeyW');
    await expect(page.getByRole('dialog')).toContainText('胜利');
    await expect(page.getByRole('dialog')).toContainText('用时');
    await expect(page.getByRole('button', { name: '返回开始界面' })).toBeVisible();
    await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, OVERLAY], size);
    await shot('10-won');

    // 失败结算（只在开发和测试模式下能打开的限时小关）
    await open(page, '/?level=test-timeout');
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('lost');
    await expect(page.getByRole('dialog')).toContainText('失败');
    await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, OVERLAY], size);
    await shot('11-lost');
  });
}

test('窗口大小变化时画布和 HUD 跟着调整', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, '/?level=test-a');
  const dpr = await page.evaluate(() => Math.min(window.devicePixelRatio, 2));
  await expect.poll(async () => (await read(page)).render.canvasWidth).toBe(Math.round(1280 * dpr));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await read(page)).render.canvasWidth).toBe(Math.round(1920 * dpr));
  expect((await read(page)).render.canvasHeight).toBe(Math.round(1080 * dpr));
  expect((await read(page)).screen).toMatchObject({ width: 1920, height: 1080 });
  const hud = await boxOf(page, HUD);
  expect(Math.abs(hud.x + hud.width / 2 - 960)).toBeLessThan(2);
  await expectLayout(page, [TOP_LEFT, TOP_RIGHT, HUD, OVERLAY], { width: 1920, height: 1080 });
});

// 导入（P3）的端到端测试：先把 P1 的夹具写到系统临时目录，再经文件选择框导入。只读测试钩子，不改状态。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildFixture, type FixtureId } from '../../src/asset/fixtures';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import type { GameAppSnapshot } from '../../src/game/appTypes';
import { NO_MOVEMENT_NOTICE } from '../../src/import/clipRules';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

let dir: string;
const files: Record<string, string> = {};

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-playground-import-e2e-'));
  const write = (name: string, bytes: Uint8Array) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    files[name] = path;
  };
  const fixtures: [string, FixtureId][] = [
    ['skinned-humanoid.glb', 'skinned-humanoid'],
    ['broken.glb', 'corrupt-truncated'],
    ['external.glb', 'external-buffer'],
  ];
  for (const [name, id] of fixtures) write(name, buildFixture(id));
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

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
}

/** 点“导入角色”，在文件选择框里选文件。 */
async function chooseFile(page: Page, path: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入角色' }).click();
  await (await chooser).setFiles(path);
  await expect.poll(async () => (await read(page)).import.busy).toBe(false);
}

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

test('带骨骼的夹具经文件选择框导入，出现在预览里并且在播放', async ({ page }, testInfo) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, files['skinned-humanoid.glb'] ?? '');
  await expect.poll(async () => (await read(page)).import.card?.fileName).toBe('skinned-humanoid.glb');
  const first = await read(page);
  const card = first.import.card;
  if (!card) throw new Error('没有导入卡片');
  expect(first.import.error).toBeNull();
  expect(card.skinned).toBe(true);
  expect(card.bones).toBe(5);
  expect(card.bindPose).toEqual({ convention: 'scene', basis: 'clips' });
  expect(card.clips.map((c) => [c.index, c.name, c.purpose, c.playback, c.playbackSource])).toEqual([
    [0, 'idle', 'idle', 'loop', 'explicit'],
    [1, 'walk', 'walk', 'loop', 'explicit'],
    [2, 'run', 'run', 'loop', 'inferred'],
  ]);
  expect(card.clips.every((c) => c.key === `${card.assetId}#${String(c.index)}`)).toBe(true);
  expect(card.size.height).toBeCloseTo(1.75, 5);
  expect(card.bounds.min[1]).toBeCloseTo(0, 5);
  await expect(page.locator('#import-preview')).toBeVisible();
  // 预览在播放：mixer 时间在前进
  expect(card.preview.playing).toBe(true);
  await expect.poll(async () => (await read(page)).import.card?.preview.mixerTime ?? 0).toBeGreaterThan(card.preview.mixerTime + 0.3);
  // 单独预览另一个片段
  await page.getByRole('button', { name: '预览片段 2' }).click();
  await expect.poll(async () => (await read(page)).import.card?.preview.clipIndex).toBe(2);
  // 身高滑块和旋转按钮只影响显示
  await page.getByRole('slider', { name: '显示身高' }).fill('2.2');
  await expect.poll(async () => (await read(page)).import.card?.size.height ?? 0).toBeCloseTo(2.2, 5);
  await page.getByRole('button', { name: '向右转 90°' }).click();
  await expect.poll(async () => (await read(page)).import.card?.quarterTurns).toBe(3);
  const turned = await read(page);
  expect(turned.import.card?.bounds.min[1]).toBeCloseTo(0, 5);
  await expect(page.getByRole('button', { name: '加入为新人物（P4 实现）' })).toBeDisabled();
  expect(turned.player.model).toBe('default');
  await page.screenshot({ path: testInfo.outputPath('import-preview.png') });
});

test('身高滑块可以连续按方向键、连续拖动调整（调整过程中滑块不被重建）', async ({ page }) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, files['skinned-humanoid.glb'] ?? '');
  await expect.poll(async () => (await read(page)).import.card?.displayHeight).toBe(1.75);
  const slider = page.getByRole('slider', { name: '显示身高' });
  // 连续按 5 次方向键：每次 0.01 m，焦点一直在滑块上
  await slider.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await read(page)).import.card?.displayHeight ?? 0).toBeCloseTo(1.8, 5);
  await expect(slider).toBeFocused();
  // 按住拖到最右端：拖动途中值持续变化，最后到上限 2.4 m
  const box = await slider.boundingBox();
  if (!box) throw new Error('滑块不可见');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  const seen = new Set<number>();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + box.width * (0.5 + i * 0.05), y);
    seen.add((await read(page)).import.card?.displayHeight ?? 0);
  }
  await page.mouse.up();
  expect(seen.size).toBeGreaterThan(5);
  expect((await read(page)).import.card?.displayHeight ?? 0).toBeGreaterThan(2.35);
  expect((await read(page)).import.card?.size.height ?? 0).toBeGreaterThan(2.35);
});

test('导入损坏的文件：提示错误，当前主角保持不变', async ({ page }, testInfo) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, files['broken.glb'] ?? '');
  const broken = await read(page);
  expect(broken.import.error).toContain('文件损坏');
  expect(broken.import.card).toBeNull();
  expect(broken.player.model).toBe('default');
  await expect(page.getByRole('alert').filter({ hasText: '导入失败' })).toBeVisible();

  // 先把好的角色设为主角，再导入坏文件：主角和已有的卡片都不受影响
  await chooseFile(page, files['skinned-humanoid.glb'] ?? '');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  const before = await read(page);
  await chooseFile(page, files['external.glb'] ?? '');
  const after = await read(page);
  expect(after.import.error).toBe('文件引用了外部资源，请导出为自包含的 GLB');
  expect(after.player.assetId).toBe(before.player.assetId);
  expect(after.import.card?.assetId).toBe(before.import.card?.assetId);
  // 场景照常渲染
  await expect.poll(async () => (await read(page)).render.frames).toBeGreaterThan(after.render.frames + 5);
  await page.screenshot({ path: testInfo.outputPath('import-error.png') });
});

test('点“设为主角”后，在测试小关 A 里只用键盘走到收集点，用导入的角色赢下这一关', async ({ page }, testInfo) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, files['skinned-humanoid.glb'] ?? '');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  const ready = await read(page);
  expect(ready.instances).toBe(1);
  expect(ready.player.animator?.clipName).toBe('idle');

  await page.getByRole('button', { name: '开始' }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.keyboard.down('KeyW');
  // 走起来时切到导入角色的 walk 片段
  await expect.poll(async () => (await read(page)).player.animator?.clipName, { timeout: 5_000 }).toBe('walk');
  await page.screenshot({ path: testInfo.outputPath('imported-walking.png') });
  await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
  await page.keyboard.up('KeyW');
  const end = await read(page);
  expect(end.game.collectedCount).toBe(1);
  expect(end.player.model).toBe('imported');
  expect(end.player.assetId).toBe(ready.player.assetId);
  await expect(page.getByRole('dialog').filter({ hasText: '胜利' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('imported-won.png') });
});

test('把 STL 文件拖进窗口：静态模型，默认材质，移动时整体摆动', async ({ page }) => {
  await open(page, '/?level=test-a');
  const stl = 'solid t\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 2 0\n  endloop\n endfacet\nendsolid t\n';
  await page.evaluate((content) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], 'statue.stl', { type: 'model/stl' }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
  }, stl);
  await expect.poll(async () => (await read(page)).import.card?.fileName).toBe('statue.stl');
  const card = (await read(page)).import.card;
  expect(card?.format).toBe('stl');
  expect(card?.skinned).toBe(false);
  expect(card?.notices).toContain('STL 使用默认材质');
  expect(card?.notices).toContain(NO_MOVEMENT_NOTICE);
  expect(card?.plan.sway).toBe(true);
  expect(card?.size.height).toBeCloseTo(1.75, 5);
});

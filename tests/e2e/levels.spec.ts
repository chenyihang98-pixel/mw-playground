// 关卡（P5）的端到端测试：随机一关（预览、确认、保存、刷新后还在、加载出来的布局与预览一致）、取消不加载回退关卡、
// 出场人物已被删除时用默认替身并提示、内置的冻结关卡和视觉预设。只读测试钩子，不改状态；IndexedDB 是真实读写。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildFixture } from '../../src/asset/fixtures';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import type { GameAppSnapshot } from '../../src/game/appTypes';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

let dir: string;
let humanoidPath = '';

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-playground-levels-e2e-'));
  humanoidPath = join(dir, 'skinned-humanoid.glb');
  writeFileSync(humanoidPath, buildFixture('skinned-humanoid'));
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
  await expect.poll(async () => {
    const s = await read(page);
    return !s.roster.restoring && !s.levels.loading;
  }).toBe(true);
}

/** 打开关卡选择，点“随机一关”（或“重新随机一关”），等到出预览；随机生成全部失败（极少见）时再试，最多 5 次。 */
async function randomPreview(page: Page, accept: (s: GameAppSnapshot) => boolean = () => true): Promise<GameAppSnapshot> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const s = await read(page);
    if (!s.levels.select.open) await page.getByRole('button', { name: '选择关卡' }).click();
    const again = page.getByRole('button', { name: '重新随机一关' });
    if (await again.isVisible()) await again.click();
    else await page.getByRole('button', { name: '随机一关' }).click();
    await expect.poll(async () => (await read(page)).levels.select.random.kind, { timeout: 20_000 }).toMatch(/preview|failed/);
    const after = await read(page);
    if (after.levels.select.random.kind === 'preview' && accept(after)) return after;
  }
  throw new Error('随机一关一直没有得到想要的预览');
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

test('随机一关：预览，确认；关卡出现在“已保存”里，刷新后还在，加载出来的布局与预览一致', async ({ page }, testInfo) => {
  await open(page, '/');
  expect((await read(page)).level.key).toBe('builtin:meadow');
  const preview = await randomPreview(page);
  const hash = preview.levels.select.random.previewHash;
  expect(hash).toMatch(/^[0-9a-f]{16}$/);
  // 预览时还没有加载，也没有保存
  expect(preview.level.key).toBe('builtin:meadow');
  expect(preview.levels.saved).toEqual([]);
  await expect(page.locator('#level-preview-map')).toBeVisible();
  await expect(page.locator('#level-panel')).toContainText('空间与规则检查通过，难度为估计。');
  await page.screenshot({ path: testInfo.outputPath('random-preview.png') });

  await page.getByRole('button', { name: '确认这一关' }).click();
  await expect.poll(async () => (await read(page)).level.layoutHash).toBe(hash);
  const loaded = await read(page);
  expect(loaded.level.key).toBe(`saved:${String(hash)}`);
  expect(['random', 'adjusted']).toContain(loaded.level.source);
  expect(loaded.levels.saved.map((e) => e.id)).toEqual([hash]);
  expect(loaded.level.rules.timeLimit).toBe(loaded.game.timeLimit);
  expect(loaded.overlay).toBe('start');
  await expect.poll(async () => (await read(page)).levels.select.open).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('random-loaded.png') });

  // 刷新：已保存的关卡还在；加载它，布局的哈希与预览一致，时间限制不变
  await open(page, '/');
  const reloaded = await read(page);
  expect(reloaded.level.key).toBe('builtin:meadow');
  expect(reloaded.levels.saved).toEqual([expect.objectContaining({ id: hash, status: 'ready', layoutHash: hash, timeLimit: loaded.level.rules.timeLimit })]);
  await page.getByRole('button', { name: '选择关卡' }).click();
  await page.getByRole('button', { name: `加载已保存的关卡 ${loaded.level.title}` }).click();
  await expect.poll(async () => (await read(page)).level.layoutHash).toBe(hash);
  const replay = await read(page);
  expect(replay.level.rules).toEqual(loaded.level.rules);
  expect(replay.level.seed).toBe(loaded.level.seed);
  expect(replay.game.levelId).toBe(loaded.game.levelId);

  // 已保存的关卡可以删除
  await page.getByRole('button', { name: '选择关卡' }).click();
  await page.getByRole('button', { name: `删除已保存的关卡 ${loaded.level.title}` }).click();
  await expect.poll(async () => (await read(page)).levels.saved.length).toBe(0);
});

test('取消随机生成：结束这次生成，不加载回退关卡', async ({ page }) => {
  await open(page, '/?level=test-a');
  const before = await read(page);
  await page.getByRole('button', { name: '选择关卡' }).click();
  await page.getByRole('button', { name: '随机一关' }).click();
  // 还在生成就点“取消生成”，已经出了预览就点“放弃”：两者都结束这次生成
  await page.getByRole('button', { name: /取消生成|放弃这一关/ }).click();
  await expect.poll(async () => (await read(page)).levels.select.random.kind).toBe('cancelled');
  // 再等一会儿：生成不会在后台继续，也不会加载回退关卡
  await page.waitForTimeout(500);
  const after = await read(page);
  expect(after.levels.select.random).toMatchObject({ kind: 'cancelled', fallbackKey: null, previewHash: null });
  expect(after.level.key).toBe('builtin:test-a');
  expect(after.level.layoutHash).toBe(before.level.layoutHash);
  expect(after.levels.saved).toEqual([]);
  await expect(page.locator('#level-panel')).toContainText('已取消这次生成。');
});

test('加载一个出场人物已被删除的关卡：用默认替身代替，并给出提示', async ({ page }, testInfo) => {
  await open(page, '/');
  // 名册里放一个人物，随机到一关把他列为出场人物，确认保存
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入角色' }).click();
  await (await chooser).setFiles(humanoidPath);
  await expect.poll(async () => (await read(page)).import.busy).toBe(false);
  await page.getByRole('button', { name: '加入为新人物' }).click();
  await expect.poll(async () => (await read(page)).roster.entries.length).toBe(1);
  await page.getByRole('button', { name: '关闭' }).click();
  const person = (await read(page)).roster.entries[0]?.key ?? '';
  const preview = await randomPreview(page, (s) => s.levels.select.random.previewCast.length > 0);
  const listed = preview.levels.select.random.previewCast[0];
  expect(listed?.personId).toBe(person);
  await page.getByRole('button', { name: '确认这一关' }).click();
  await expect.poll(async () => (await read(page)).level.key).toMatch(/^saved:/);
  const withPerson = await read(page);
  if (listed?.role === 'companion') expect(withPerson.cast.companions).toContainEqual({ personId: person, model: 'imported' });
  else expect(withPerson.cast.guards.map((g) => g.personId)).toContain(person);

  // 从名册里删除这个人物，刷新后再加载这一关（P6：名册在顶栏的“名册”里打开）
  await page.getByRole('button', { name: '名册', exact: true }).click();
  await page.getByRole('button', { name: '删除 skinned-humanoid.glb' }).click();
  await page.getByRole('button', { name: '确认删除 skinned-humanoid.glb' }).click();
  await expect.poll(async () => (await read(page)).roster.entries.length).toBe(0);
  await expect.poll(async () => (await read(page)).roster.saving).toBe(false);
  await open(page, '/');
  await page.getByRole('button', { name: '选择关卡' }).click();
  await page.getByRole('button', { name: `加载已保存的关卡 ${withPerson.level.title}` }).click();
  await expect.poll(async () => (await read(page)).level.key).toBe(withPerson.level.key);
  const replay = await read(page);
  if (listed?.role === 'companion') {
    expect(replay.cast.companions[0]).toEqual({ personId: null, model: 'default' });
    expect(replay.game.companions).toHaveLength(1);
  } else {
    expect(replay.cast.guards.every((g) => g.personId === null && g.model === 'default')).toBe(true);
  }
  expect(replay.cast.notices.some((n) => n.includes('已不在名册里，用默认替身代替'))).toBe(true);
  await expect(page.getByRole('dialog')).toContainText('用默认替身代替');
  await page.screenshot({ path: testInfo.outputPath('stand-in.png') });
});

test('内置的冻结关卡：从关卡选择加载，视觉预设生效；回到 P2 的手工地图', async ({ page }, testInfo) => {
  await open(page, '/');
  await page.getByRole('button', { name: '选择关卡' }).click();
  await page.getByRole('button', { name: '加载内置关卡 雪夜高台' }).click();
  await expect.poll(async () => (await read(page)).level.key).toBe('builtin:gen-3');
  const snow = await read(page);
  expect(snow.environment).toMatchObject({ theme: 'snow', time: 'night', weather: 'rain', rain: true });
  expect(snow.level.source).toBe('builtin');
  await page.screenshot({ path: testInfo.outputPath('builtin-snow-night-rain.png') });
  await page.getByRole('button', { name: '选择关卡' }).click();
  await page.getByRole('button', { name: '加载内置关卡 沙丘黄昏' }).click();
  await expect.poll(async () => (await read(page)).environment.weather).toBe('fog');
  expect((await read(page)).environment).toMatchObject({ theme: 'sand', time: 'dusk', rain: false });
  await page.screenshot({ path: testInfo.outputPath('builtin-sand-dusk-fog.png') });
  await page.getByRole('button', { name: '选择关卡' }).click();
  await page.getByRole('button', { name: '加载内置关卡 草地' }).click();
  await expect.poll(async () => (await read(page)).level.key).toBe('builtin:meadow');
  expect((await read(page)).environment).toMatchObject({ theme: 'grass', time: 'day', weather: 'clear', fog: null, rain: false });
});

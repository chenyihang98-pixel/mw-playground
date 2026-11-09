// 名册（P4）的端到端测试：IndexedDB 真实读写（刷新后恢复）、同伴跟随、删除主角、导入失败时名册不变、存储被禁用。
// 夹具先写到系统临时目录，再经文件选择框导入；测试结束后删除。只读测试钩子，不改状态。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildFixture, type FixtureId } from '../../src/asset/fixtures';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import type { GameAppSnapshot } from '../../src/game/appTypes';
import { SPEC } from '../../src/game/spec';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

let dir: string;
const files: Record<string, string> = {};

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-playground-roster-e2e-'));
  const fixtures: [string, FixtureId][] = [
    ['skinned-humanoid.glb', 'skinned-humanoid'],
    ['static-mesh.glb', 'static-mesh'],
    ['broken.glb', 'corrupt-truncated'],
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

/** 打开页面，等测试钩子装好、名册恢复完。 */
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
  await expect.poll(async () => (await read(page)).roster.restoring).toBe(false);
}

async function chooseFile(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入角色' }).click();
  await (await chooser).setFiles(files[name] ?? '');
  await expect.poll(async () => (await read(page)).import.busy).toBe(false);
}

/** 打开名册（P6：名册是顶栏“名册”打开的主面板）。 */
async function openRoster(page: Page) {
  await page.getByRole('button', { name: '名册', exact: true }).click();
  await expect.poll(async () => (await read(page)).ui.panel).toBe('roster');
}

/** 等名册写完（刷新页面前）。 */
async function settled(page: Page) {
  await expect.poll(async () => (await read(page)).roster.saving).toBe(false);
}

function keyOf(state: GameAppSnapshot, fileName: string): string {
  const entry = state.roster.entries.find((e) => e.fileName === fileName);
  if (!entry) throw new Error(`名册里没有 ${fileName}`);
  return entry.key;
}

/** 点“开始”，按住 W 直到赢下测试小关 A。 */
async function walkToWin(page: Page) {
  await page.getByRole('button', { name: '开始' }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
  await page.keyboard.up('KeyW');
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

test('设为主角、设为守卫，刷新后名册和分工都还在；在测试小关 A 里只用键盘取胜，主角是导入的人物', async ({ page }, testInfo) => {
  await open(page, '/?level=test-a');
  expect((await read(page)).roster.entries).toEqual([]);

  // 第一个：设为主角（还不在名册里，先加入）
  await chooseFile(page, 'skinned-humanoid.glb');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  // 第二个：加入为新人物，再在名册里设为守卫
  await chooseFile(page, 'static-mesh.glb');
  await page.getByRole('button', { name: '加入为新人物' }).click();
  await expect.poll(async () => (await read(page)).roster.entries.length).toBe(2);
  // 同一个文件再加入一次：不新增，提示“已在名册里”，名册里标出那一项
  // （P6：同时只显示一个主面板，先在卡片上点，再打开名册设分工）
  await page.getByRole('button', { name: '已在名册里' }).click();
  await expect.poll(async () => (await read(page)).roster.highlight).not.toBeNull();
  const marked = await read(page);
  expect(marked.roster.entries).toHaveLength(2);
  expect(marked.roster.highlight).toBe(keyOf(marked, 'static-mesh.glb'));
  expect(marked.roster.notices).toContain('“static-mesh.glb”已在名册里');
  await openRoster(page);
  await page.getByRole('combobox', { name: 'static-mesh.glb 的分工' }).selectOption('guard');
  await expect.poll(async () => (await read(page)).roster.entries[1]?.role).toBe('guard');
  await settled(page);
  const before = await read(page);
  const hero = keyOf(before, 'skinned-humanoid.glb');
  const statue = keyOf(before, 'static-mesh.glb');

  // 刷新：名册和分工都从 IndexedDB 恢复（文件重新走一遍导入流程）
  await page.reload();
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
  await expect.poll(async () => (await read(page)).roster.restoring).toBe(false);
  const after = await read(page);
  expect(after.roster.storage.ok).toBe(true);
  expect(after.roster.entries.map((e) => [e.key, e.displayName, e.role, e.status])).toEqual([
    [hero, 'skinned-humanoid.glb', 'player', 'ready'],
    [statue, 'static-mesh.glb', 'guard', 'ready'],
  ]);
  for (const [i, entry] of after.roster.entries.entries()) {
    const was = before.roster.entries[i];
    expect(entry.size?.height).toBeCloseTo(was?.size?.height ?? NaN, 6);
    expect(entry.size?.width).toBeCloseTo(was?.size?.width ?? NaN, 6);
    expect(entry.quarterTurns).toBe(was?.quarterTurns);
    expect(entry.slots).toEqual(was?.slots);
  }
  expect(after.player).toMatchObject({ model: 'imported', personId: hero });
  // 测试小关 A 没有守卫：守卫人物不出场，并给出提示
  expect(after.cast.guards).toEqual([]);
  expect(after.cast.notices).toContain('关卡里只有 0 个守卫：“static-mesh.glb” 不出场');
  await page.screenshot({ path: testInfo.outputPath('roster-restored.png') });

  await walkToWin(page);
  const end = await read(page);
  expect(end.game.collectedCount).toBe(1);
  expect(end.player).toMatchObject({ model: 'imported', personId: hero });
  await expect(page.getByRole('dialog').filter({ hasText: '胜利' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('roster-won.png') });

  // 测试小关 B 有一个守卫：换成名册里的守卫人物，守卫的数量和路线不变
  await open(page, '/?level=test-b');
  const levelB = await read(page);
  expect(levelB.cast.guards).toEqual([{ guardId: 'guard-b', personId: statue, model: 'imported' }]);
  expect(levelB.game.guards.map((g) => g.id)).toEqual(['guard-b']);
  await page.screenshot({ path: testInfo.outputPath('roster-guard.png') });
});

test('再次导入名册里已有的文件：卡片打开的是名册里的那一项，在卡片上的修改会保存', async ({ page }) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, 'skinned-humanoid.glb');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  await page.getByRole('button', { name: '关闭' }).click();

  // 同一个文件再导入一次
  await chooseFile(page, 'skinned-humanoid.glb');
  const card = (await read(page)).import.card;
  expect(card).toMatchObject({ inRoster: true, rosterOwned: true, isPlayer: true });
  await expect(page.locator('#import-status')).toContainText('已在名册里');
  await page.getByRole('slider', { name: '显示身高' }).fill('2.2');
  await page.getByRole('button', { name: '向右转 90°' }).click();
  await expect.poll(async () => (await read(page)).roster.entries[0]?.quarterTurns).toBe(3);
  expect((await read(page)).roster.entries[0]?.displayHeight).toBeCloseTo(2.2, 6);
  // 再点一次（显示“已设为主角”）：仍是同一个人物
  await page.getByRole('button', { name: '已设为主角' }).click();
  expect((await read(page)).roster.entries).toHaveLength(1);
  await settled(page);

  await open(page, '/?level=test-a');
  const after = await read(page);
  expect(after.roster.entries.map((e) => [e.role, e.quarterTurns, e.displayHeight])).toEqual([['player', 3, 2.2]]);
  expect(after.roster.entries[0]?.size?.height).toBeCloseTo(2.2, 6);
  expect(after.player.model).toBe('imported');
});

test('名册里的人物还在恢复时再次导入同一个文件：卡片上的设置先禁用，恢复好后换成名册里的那一份，修改会保存', async ({ page }) => {
  // 只用于这个测试的页面脚本：设了标记的那次加载，把第一次读 Blob（恢复名册里保存的文件）挂起，直到测试放行。
  // 标记读过就清掉，之后的加载照常。不经过游戏的测试钩子，也不改名册本身。
  await page.addInitScript(() => {
    if (sessionStorage.getItem('mw-hold-restore') !== '1') return;
    sessionStorage.removeItem('mw-hold-restore');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    (window as unknown as { mwReleaseRestore: () => void }).mwReleaseRestore = release;
    let first = true;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      // 经 Response 读出内容（不再调用被替换的 arrayBuffer）
      const read = () => new Response(this).arrayBuffer();
      if (!first) return read();
      first = false;
      return held.then(read);
    };
  });
  await open(page, '/?level=test-a');
  await chooseFile(page, 'skinned-humanoid.glb');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  await settled(page);

  // 刷新，恢复挂起：名册里那一项停在“正在恢复”
  await page.evaluate(() => {
    sessionStorage.setItem('mw-hold-restore', '1');
  });
  await page.reload();
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
  await expect.poll(async () => (await read(page)).roster.entries[0]?.status).toBe('loading');

  // 这时再导入同一个文件：卡片上是另一份副本，设置被禁用并说明原因
  await chooseFile(page, 'skinned-humanoid.glb');
  const pending = (await read(page)).import.card;
  expect(pending).toMatchObject({ inRoster: true, rosterOwned: false });
  expect(pending?.settingsLockedReason).toContain('还在恢复');
  await expect(page.getByRole('slider', { name: '显示身高' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '向右转 90°' })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '片段 0 的用途' })).toBeDisabled();
  await expect(page.getByRole('note')).toContainText('还在恢复');

  // 放行恢复：卡片换成名册里的那一份，设置可以改，改了会保存
  await page.evaluate(() => {
    (window as unknown as { mwReleaseRestore: () => void }).mwReleaseRestore();
  });
  await expect.poll(async () => (await read(page)).import.card?.rosterOwned).toBe(true);
  expect((await read(page)).import.card?.settingsLockedReason).toBeNull();
  await expect(page.getByRole('slider', { name: '显示身高' })).toBeEnabled();
  await page.getByRole('slider', { name: '显示身高' }).fill('2.2');
  await page.getByRole('button', { name: '向右转 90°' }).click();
  await expect.poll(async () => (await read(page)).roster.entries[0]?.quarterTurns).toBe(3);
  await settled(page);

  await open(page, '/?level=test-a');
  const after = await read(page);
  expect(after.roster.entries.map((e) => [e.role, e.quarterTurns, e.displayHeight])).toEqual([['player', 3, 2.2]]);
});

test('同伴：在测试小关 A 里移动时跟随主角；结算不受同伴影响', async ({ page }, testInfo) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, 'skinned-humanoid.glb');
  await page.getByRole('button', { name: '加入为新人物' }).click();
  await openRoster(page);
  await page.getByRole('combobox', { name: 'skinned-humanoid.glb 的分工' }).selectOption('companion');
  await expect.poll(async () => (await read(page)).game.companions.length).toBe(1);
  // 关掉名册，导入卡片回来，再关掉卡片
  await page.getByRole('button', { name: '关闭名册' }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const ready = await read(page);
  expect(ready.cast.companions).toEqual([{ personId: keyOf(ready, 'skinned-humanoid.glb'), model: 'imported' }]);
  expect(ready.player.model).toBe('default');
  const start = ready.game.companions[0];
  if (!start) throw new Error('没有同伴');
  // 开局在主角的左后方（P6：同伴 0 在左后方；测试小关 A 的主角面向 +Z，左边是 +X）
  const offset = SPEC.companion.follow[0];
  expect(start.x).toBeCloseTo(ready.game.player.x - offset.right, 5);
  expect(start.z).toBeCloseTo(ready.game.player.z - offset.back, 5);

  await page.getByRole('button', { name: '开始' }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  // 往前走一小段（还碰不到收集点），停下：同伴跟上来，停在主角身后
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.player.z, { timeout: 5_000 }).toBeGreaterThan(-5);
  await page.keyboard.up('KeyW');
  await expect
    .poll(async () => {
      const c = (await read(page)).game.companions.at(0);
      return c !== undefined && !c.following && c.z > start.z + 0.5;
    })
    .toBe(true);
  const followed = await read(page);
  const c = followed.game.companions[0];
  expect(followed.game.phase).toBe('playing');
  expect(Math.hypot((c?.x ?? 0) - followed.game.player.x, (c?.z ?? 0) - followed.game.player.z)).toBeLessThan(Math.hypot(offset.back, offset.right) + SPEC.companion.resumeRadius);
  await page.screenshot({ path: testInfo.outputPath('companion-following.png') });

  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
  await page.keyboard.up('KeyW');
  const end = await read(page);
  // 结算只看主角：收集 1 个，没有扣时；同伴没有收集
  expect(end.game.result).toMatchObject({ outcome: 'won', reason: 'collected' });
  expect(end.game.collectedCount).toBe(1);
  expect(end.game.hits).toEqual([]);
});

test('恢复默认主角；删除主角后恢复默认主角，实例和名册记录一起清掉', async ({ page }, testInfo) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, 'skinned-humanoid.glb');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  expect((await read(page)).instances).toBe(1);

  // 恢复默认主角：原来的主角改为不出场
  await openRoster(page);
  await page.getByRole('button', { name: '恢复默认主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('default');
  expect((await read(page)).roster.entries[0]?.role).toBe('none');
  expect((await read(page)).instances).toBe(0);

  // 再在名册里设为主角，然后删除（二次确认）
  await page.getByRole('combobox', { name: 'skinned-humanoid.glb 的分工' }).selectOption('player');
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  await page.getByRole('button', { name: '删除 skinned-humanoid.glb' }).click();
  expect((await read(page)).roster.entries).toHaveLength(1); // 还没确认
  await page.getByRole('button', { name: '确认删除 skinned-humanoid.glb' }).click();
  await expect.poll(async () => (await read(page)).roster.entries.length).toBe(0);
  const removed = await read(page);
  expect(removed.player).toMatchObject({ model: 'default', personId: null });
  expect(removed.instances).toBe(0);
  expect(removed.import.card).toBeNull(); // 卡片上正打开着它，一起关掉
  await settled(page);
  await page.screenshot({ path: testInfo.outputPath('roster-deleted.png') });

  await open(page, '/?level=test-a');
  const reloaded = await read(page);
  expect(reloaded.roster.entries).toEqual([]);
  expect(reloaded.player.model).toBe('default');
});

test('导入损坏的文件：名册和主角都不变', async ({ page }) => {
  await open(page, '/?level=test-a');
  await chooseFile(page, 'skinned-humanoid.glb');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  await settled(page);
  const before = await read(page);
  await chooseFile(page, 'broken.glb');
  const after = await read(page);
  expect(after.import.error).toContain('文件损坏');
  expect(after.roster.entries).toEqual(before.roster.entries);
  expect(after.player.personId).toBe(before.player.personId);
  expect(after.cast).toEqual(before.cast);
  expect(after.import.card?.assetId).toBe(before.import.card?.assetId);
});

test('存储被禁用（IndexedDB 抛错）：给出提示，游戏照常，名册在本次会话里能用', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException('测试：禁止使用 IndexedDB', 'SecurityError');
    };
  });
  await open(page, '/?level=test-a');
  const blocked = await read(page);
  expect(blocked.roster.storage.ok).toBe(false);
  await expect(page.locator('#roster-storage')).toContainText('浏览器禁止使用本地存储');
  await expect(page.locator('#roster-storage')).toContainText('游戏照常运行');

  await chooseFile(page, 'skinned-humanoid.glb');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  await settled(page);
  expect((await read(page)).roster.entries).toHaveLength(1);
  await page.getByRole('button', { name: '关闭' }).click();
  await page.screenshot({ path: testInfo.outputPath('roster-storage-blocked.png') });
  await walkToWin(page);
  expect((await read(page)).player.model).toBe('imported');
});

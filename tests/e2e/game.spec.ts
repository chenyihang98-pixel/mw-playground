// 端到端（Chromium）：只用鼠标和键盘玩；断言时只通过测试钩子读状态，不改状态。

import { expect, test, type Page } from '@playwright/test';
import type { GameAppSnapshot } from '../../src/game/appTypes';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import { SPEC } from '../../src/game/spec';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

function read(page: Page): Promise<GameAppSnapshot> {
  return page.evaluate(() => {
    const hooks = window.__MW_TEST__ as Hooks | undefined;
    if (hooks?.kind !== 'game') throw new Error('游戏测试钩子不存在');
    return hooks.getState();
  });
}

async function open(page: Page, url: string, levelId: string) {
  await page.goto(url);
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
  const state = await read(page);
  expect(state.game.levelId).toBe(levelId);
  expect(state.game.phase).toBe('ready');
  expect(state.overlay).toBe('start');
  return state;
}

/** 用鼠标点“开始”。 */
async function clickStart(page: Page) {
  await page.getByRole('button', { name: '开始' }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
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

test('测试小关 A：点“开始”，按住 W 走到收集点，出现胜利结算', async ({ page }, testInfo) => {
  const start = await open(page, '/?level=test-a', 'test-a');
  expect(start.game.collectedCount).toBe(0);
  expect(start.game.target).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('test-a-start.png') });

  await clickStart(page);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
  await page.keyboard.up('KeyW');

  const end = await read(page);
  expect(end.game.collectedCount).toBe(1);
  expect(end.game.result).toMatchObject({ outcome: 'won', reason: 'collected' });
  expect(end.game.player.z - start.game.player.z).toBeGreaterThan(2); // 确实是走过去的
  expect(end.overlay).toBe('won');
  await expect(page.getByRole('dialog')).toContainText('胜利');
  await expect(page.locator('#hud-collect')).toHaveText('收集 1 / 1');
  await page.screenshot({ path: testInfo.outputPath('test-a-won.png') });
});

test('测试小关 B：站着不动，守卫经过出生点时扣一次时间，两次扣时的间隔不短于冷却时长', async ({ page }, testInfo) => {
  const start = await open(page, '/?level=test-b', 'test-b');
  await clickStart(page);

  await expect.poll(async () => (await read(page)).game.hits.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  // 能看见的反馈：冷却期间 HUD 的时间变色
  await expect(page.locator('#hud-time')).toHaveClass(/cooldown/);
  await page.screenshot({ path: testInfo.outputPath('test-b-hit.png') });
  const first = await read(page);
  const hit1 = first.game.hits[0];
  if (!hit1) throw new Error('没有扣时记录');
  // 扣时 = 经过的模拟时间 + 一次惩罚
  expect(hit1.timeLeftAfter).toBeCloseTo(start.game.timeLimit - hit1.at - SPEC.guard.penaltySeconds, 6);

  await expect.poll(async () => (await read(page)).game.hits.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  const second = await read(page);
  const [a, b] = second.game.hits;
  if (!a || !b) throw new Error('扣时记录不足两次');
  expect(b.at - a.at).toBeGreaterThanOrEqual(SPEC.guard.cooldownSeconds);
  // 没按任何键：玩家没动，扣掉的时间正好是 次数 × 惩罚
  expect(second.game.player.x).toBe(start.game.player.x);
  expect(second.game.player.z).toBe(start.game.player.z);
  expect(second.game.timeLeft).toBeCloseTo(
    start.game.timeLimit - second.game.simTime - second.game.hits.length * SPEC.guard.penaltySeconds,
    6,
  );
});

test('固定地图：暂停后剩余时间不变，继续后时间开始减少', async ({ page }, testInfo) => {
  await open(page, '/', 'meadow');
  await clickStart(page);
  await expect.poll(async () => (await read(page)).game.timeLeft).toBeLessThan(119.5);

  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  // 暂停时释放指针锁定（exitPointerLock 是异步的，等它生效）
  await expect.poll(async () => (await read(page)).camera.pointerLocked).toBe(false);
  const paused = await read(page);
  expect(paused.overlay).toBe('pause');
  await page.waitForTimeout(1500);
  const still = await read(page);
  expect(still.game.timeLeft).toBe(paused.game.timeLeft);
  expect(still.game.simTime).toBe(paused.game.simTime);
  expect(still.game.steps).toBe(paused.game.steps);
  expect(still.game.guards).toEqual(paused.game.guards);
  await page.screenshot({ path: testInfo.outputPath('meadow-paused.png') });

  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await expect.poll(async () => (await read(page)).game.timeLeft).toBeLessThan(paused.game.timeLeft - 0.2);
  await page.screenshot({ path: testInfo.outputPath('meadow-playing.png') });
});

test('固定地图：只用键盘沿坡道走上高台，收集高台上的宝石', async ({ page }, testInfo) => {
  await open(page, '/', 'meadow');
  await clickStart(page);
  // 相机看向 +Z 时，A 朝 +X。先横着走到坡道正下方（x ≈ 9），再按 W 沿坡道往 +Z 走上高台。
  // 坡道 x ∈ [7.8, 10.2]：每 50 毫秒查一次，松键时最多多走十几厘米，仍在坡道范围内。
  await page.keyboard.down('KeyA');
  await expect
    .poll(async () => (await read(page)).game.player.x, { timeout: 10_000, intervals: [50] })
    .toBeGreaterThanOrEqual(8.8);
  await page.keyboard.up('KeyA');
  expect((await read(page)).game.player.x).toBeLessThan(9.6);
  await page.keyboard.down('KeyW');
  await expect
    .poll(async () => (await read(page)).game.collectedIds, { timeout: 20_000 })
    .toContain('gem-2');
  await page.keyboard.up('KeyW');
  const top = await read(page);
  expect(top.game.player.y).toBeCloseTo(SPEC.terrain.platformHeight, 6);
  expect(top.game.player.grounded).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('meadow-plateau.png') });
});

test('暂停面板的“继续”按钮和 Esc 键', async ({ page }) => {
  await open(page, '/?level=meadow', 'meadow');
  await clickStart(page);
  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  await page.getByRole('button', { name: '继续' }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  // 点按钮重新进入游玩，会重新锁定指针（无头 Chromium 支持指针锁定）。
  await expect.poll(async () => (await read(page)).camera.pointerLocked).toBe(true);
  // 锁定时按 Esc：浏览器用它退出锁定，游戏把“游玩中丢失锁定”当作暂停，不会暂停后又马上继续。
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  await expect.poll(async () => (await read(page)).camera.pointerLocked).toBe(false);
  await page.waitForTimeout(600);
  expect((await read(page)).game.phase).toBe('paused');
  // 不在锁定状态时，Esc 直接交给页面：再按一次继续
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  // 连按两次 P（暂停后马上继续）：游戏自己释放锁定的过程不能被误当成“浏览器解除锁定”而又暂停
  await page.locator('#scene').click(); // 点画面重新锁定指针
  await page.keyboard.press('KeyP');
  await page.keyboard.press('KeyP');
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.waitForTimeout(800);
  expect((await read(page)).game.phase).toBe('playing');
});

test('测试钩子只能读状态：快照是冻结的副本，改它不影响游戏；钩子没有改状态的方法', async ({ page }) => {
  await open(page, '/?level=test-a', 'test-a');
  const result = await page.evaluate(() => {
    const hooks = window.__MW_TEST__ as Hooks | undefined;
    if (!hooks) throw new Error('没有钩子');
    const snapshot = hooks.getState() as unknown as { game: { timeLeft: number; collectedCount: number; player: { x: number } } };
    const frozen = Object.isFrozen(snapshot) && Object.isFrozen(snapshot.game) && Object.isFrozen(snapshot.game.player);
    // 页面脚本不是严格模式：给冻结对象赋值不会报错，只是不生效
    try {
      snapshot.game.timeLeft = 0;
      snapshot.game.collectedCount = 99;
      snapshot.game.player.x = 100;
    } catch {
      // 严格模式下会抛 TypeError，同样说明改不了
    }
    try {
      (window as unknown as { __MW_TEST__: unknown }).__MW_TEST__ = {};
    } catch {
      // 同上
    }
    return {
      frozen,
      localAfterWrite: snapshot.game.timeLeft,
      keys: Object.keys(hooks).sort(),
      after: hooks.getState().game,
      sameHooks: window.__MW_TEST__ === hooks,
      levels: hooks.listLevels(),
    };
  });
  expect(result.frozen).toBe(true);
  expect(result.localAfterWrite).toBe(120);
  expect(result.keys).toEqual(['getState', 'kind', 'listLevels', 'version']);
  expect(result.after.timeLeft).toBe(120);
  expect(result.after.collectedCount).toBe(0);
  expect(result.after.player.x).toBe(0);
  expect(result.sameHooks).toBe(true);
  expect(result.levels.map((l) => l.id)).toEqual(['meadow', 'test-a', 'test-b']);
});

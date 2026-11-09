// 关卡工坊（P8）的端到端测试。Playwright 同时起 Vite 和工坊的本机服务（假模型模式，见 playwright.config.ts）。
// - 输入一句话，预览，确认：关卡出现在“已保存”里，连续点确认只保存一次；
// - 取消：不回退，不换关卡；
// - 提供方是 off：界面说明原因，并提供随机一关（测试里另起一个 off 的服务，把 /api/workshop 转过去）；
// - 连不上服务（只起了 Vite）：工坊按“服务不可用”显示，游戏照常；
// - 服务重启后确认：提示“工坊服务重启过，未确认的预览已失效”。
// 在测试里起的服务由测试关闭；统计写到系统临时目录，由测试删除。只读测试钩子，不改状态。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import type { GameAppSnapshot } from '../../src/game/appTypes';
import { loadConfig } from '../../server/config';
import { Redactor } from '../../server/errors';
import { FakeProvider } from '../../server/fakeProvider';
import { createWorkshopServer, listen } from '../../server/http';
import { createLogger } from '../../server/log';
import { createProvider } from '../../server/providers';
import { JsonlStats } from '../../server/stats';
import { Workshop } from '../../server/workshop';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

let dir: string;

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-playground-workshop-e2e-'));
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

/** 打开选关界面，等工坊查完服务状态。 */
async function openWorkshop(page: Page) {
  await page.getByRole('button', { name: '选择关卡' }).click();
  await expect.poll(async () => (await read(page)).levels.workshop.health.kind, { timeout: 10_000 }).not.toBe('checking');
}

/** 在测试里起一个工坊服务（只监听 127.0.0.1 的随机端口），由测试关闭。 */
async function startService(provider: 'off' | 'fake', delayMs = 0) {
  const loaded = loadConfig({ MW_LLM_PROVIDER: provider, MW_WORKSHOP_PORT: '0', MW_WORKSHOP_STATS: join(dir, `stats-${provider}.jsonl`), MW_FAKE_DELAY_MS: String(delayMs) });
  if (!loaded.ok) throw new Error(loaded.problems.join('；'));
  const config = loaded.config;
  const workshop = new Workshop({
    config,
    provider: provider === 'fake' ? new FakeProvider({ delayMs }) : createProvider(config),
    stats: new JsonlStats(config.statsPath),
    log: createLogger(new Redactor([]), () => undefined),
  });
  const server = createWorkshopServer(workshop, { maxBodyBytes: config.limits.maxBodyBytes }, createLogger(new Redactor([]), () => undefined));
  const port = await listen(server, 0);
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** 把页面的 /api/workshop 请求转到另一个服务。 */
async function routeTo(page: Page, port: number) {
  await page.unroute('**/api/workshop/**');
  await page.route('**/api/workshop/**', async (route) => {
    const url = new URL(route.request().url());
    url.host = `127.0.0.1:${String(port)}`;
    const response = await route.fetch({ url: url.toString() });
    await route.fulfill({ response });
  });
}

let consoleErrors: string[];
/** 这个测试里允许出现的控制台错误（例如故意断开服务时浏览器打印的“Failed to load resource”）。 */
let allowed: RegExp | null;

test.beforeEach(({ page }) => {
  consoleErrors = [];
  allowed = null;
  page.on('console', (message) => {
    if (message.type() === 'error' && !(allowed?.test(message.text()) ?? false)) consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`pageerror: ${error.message}`);
  });
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

test('输入一句话，预览，确认：关卡出现在“已保存”里；连续点确认只保存一次', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, '/?level=test-a');
  await openWorkshop(page);
  const before = await read(page);
  expect(before.levels.workshop.health).toMatchObject({ kind: 'ok', provider: 'fake', model: 'fake-scripted', available: true });
  await page.getByRole('textbox', { name: '一句话描述想玩的关卡' }).fill('想要一个下雨的夜晚，宝石藏在高台上，两个守卫来回巡逻');
  await page.getByRole('button', { name: '生成关卡' }).click();
  await expect.poll(async () => (await read(page)).levels.workshop.view).toBe('running');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect.poll(async () => (await read(page)).levels.workshop.view, { timeout: 15_000 }).toBe('preview');
  const preview = (await read(page)).levels.workshop;
  expect(preview.outcome).toBe('model-first');
  expect(preview.repairs).toBe(0);
  expect(preview.previewHash).toMatch(/^[0-9a-f]{16}$/);
  await expect(page.locator('#workshop-preview-map')).toBeVisible();
  await expect(page.locator('#level-workshop')).toContainText('模型生成');
  await expect(page.locator('#level-workshop')).toContainText('模型首次通过');
  await expect(page.locator('#level-workshop')).toContainText('空间与规则检查通过，难度为估计。');
  // 预览时还没有保存，也没有换关卡
  expect((await read(page)).levels.saved).toEqual([]);
  expect((await read(page)).level.key).toBe('builtin:test-a');
  await page.screenshot({ path: testInfo.outputPath('workshop-preview.png') });

  // 连续点两次确认：只保存一次
  const confirm = page.getByRole('button', { name: '确认工坊关卡' });
  await confirm.dblclick();
  await expect.poll(async () => (await read(page)).levels.saved.length).toBe(1);
  await expect.poll(async () => (await read(page)).level.key).toBe(`saved:${String(preview.previewHash)}`);
  const after = await read(page);
  expect(after.levels.saved).toEqual([expect.objectContaining({ id: preview.previewHash, source: 'model', status: 'ready' })]);
  expect(after.level.source).toBe('model');
  expect(after.level.layoutHash).toBe(preview.previewHash);
  expect(after.levels.workshop.saves).toBe(1);
  // 选关界面关掉，显示这一关的开始面板
  expect(after.ui.panel).toBeNull();
  await expect(page.getByRole('dialog')).toBeVisible();
  // 刷新后还在“已保存”里，来源是模型生成
  await open(page, '/?level=test-a');
  await openWorkshop(page);
  expect((await read(page)).levels.saved).toEqual([expect.objectContaining({ id: preview.previewHash, source: 'model' })]);
  await expect(page.locator('#level-saved')).toContainText('模型生成');
});

test('取消：结束这次请求，不回退，也不换关卡；之后可以重新生成', async ({ page }) => {
  await open(page, '/?level=test-a');
  await openWorkshop(page);
  await page.getByRole('textbox', { name: '一句话描述想玩的关卡' }).fill('雪地黄昏的大地图');
  await page.getByRole('button', { name: '生成关卡' }).click();
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect.poll(async () => (await read(page)).levels.workshop.view).toBe('cancelled');
  await expect(page.locator('#level-workshop')).toContainText('已取消这次生成');
  // 等过假模型的两次调用：迟到的响应也不会改变界面，不回退，不换关卡
  await page.waitForTimeout(2200);
  const after = await read(page);
  expect(after.levels.workshop.view).toBe('cancelled');
  expect(after.level.key).toBe('builtin:test-a');
  expect(after.levels.saved).toEqual([]);
  // 服务那边也结束了：再生成一次能出预览
  await page.getByRole('button', { name: '生成关卡' }).click();
  await expect.poll(async () => (await read(page)).levels.workshop.view, { timeout: 15_000 }).toBe('preview');
  // 放弃：回到输入状态，不保存
  await page.getByRole('button', { name: '放弃工坊关卡' }).click();
  expect((await read(page)).levels.workshop.view).toBe('idle');
  expect((await read(page)).levels.saved).toEqual([]);
});

test('提供方是 off：工坊说明原因，并提供“随机一关”；游戏照常', async ({ page }, testInfo) => {
  const service = await startService('off');
  try {
    await routeTo(page, service.port);
    await open(page, '/?level=test-a');
    await openWorkshop(page);
    const s = await read(page);
    expect(s.levels.workshop.health).toMatchObject({ kind: 'ok', provider: 'off', available: false });
    await expect(page.locator('#level-workshop')).toContainText('工坊没有启用模型（MW_LLM_PROVIDER=off）');
    await expect(page.getByRole('button', { name: '生成关卡' })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('workshop-off.png') });
    await page.getByRole('button', { name: '改用随机一关', exact: true }).click();
    await expect.poll(async () => (await read(page)).levels.select.random.kind, { timeout: 20_000 }).toMatch(/preview|failed/);
    // 关掉选关界面，照常开始游戏
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  } finally {
    await service.close();
  }
});

test('连不上服务（只起了 Vite 时）：工坊按“服务不可用”显示，提供随机一关，游戏照常', async ({ page }) => {
  allowed = /Failed to load resource/;
  await page.route('**/api/workshop/**', (route) => route.abort('connectionrefused'));
  await open(page, '/?level=test-a');
  await openWorkshop(page);
  expect((await read(page)).levels.workshop.health.kind).toBe('unreachable');
  await expect(page.locator('#level-workshop')).toContainText('连不上工坊服务');
  await expect(page.getByRole('button', { name: '改用随机一关', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
  await page.keyboard.up('KeyW');
});

test('服务重启过：确认时提示“工坊服务重启过，未确认的预览已失效”，不保存', async ({ page }) => {
  // 服务按约定返回 410（预览失效），浏览器会在控制台记一条
  allowed = /Failed to load resource: the server responded with a status of 410/;
  const first = await startService('fake');
  const second = await startService('fake');
  try {
    await routeTo(page, first.port);
    await open(page, '/?level=test-a');
    await openWorkshop(page);
    await page.getByRole('textbox', { name: '一句话描述想玩的关卡' }).fill('起雾的晚上');
    await page.getByRole('button', { name: '生成关卡' }).click();
    await expect.poll(async () => (await read(page)).levels.workshop.view, { timeout: 15_000 }).toBe('preview');
    // 第一个服务停掉，换成另一个进程（新的服务标识，没有这次预览的检查点）
    await first.close();
    await routeTo(page, second.port);
    await page.getByRole('button', { name: '确认工坊关卡' }).click();
    await expect.poll(async () => (await read(page)).levels.workshop.view).toBe('message');
    expect((await read(page)).levels.workshop.message).toBe('工坊服务重启过，未确认的预览已失效');
    await expect(page.locator('#level-workshop')).toContainText('工坊服务重启过，未确认的预览已失效');
    expect((await read(page)).levels.saved).toEqual([]);
  } finally {
    await first.close().catch(() => undefined);
    await second.close();
  }
});

// 关卡工坊（P8）的端到端测试。Playwright 同时起 Vite 和工坊的本机服务（假模型模式，见 playwright.config.ts）。
// - 输入一句话，预览，确认：关卡出现在“已保存”里，连续点确认只保存一次；
// - 取消：不回退，不换关卡；
// - 提供方是 off：界面说明原因，并提供随机一关（测试里另起一个 off 的服务，把 /api/workshop 转过去）；
// - 连不上服务（只起了 Vite）：工坊按“服务不可用”显示，游戏照常；
// - 服务重启后确认：提示“工坊服务重启过，未确认的预览已失效”；
// - 工坊生成的关卡保存后刷新再重玩：不再请求工坊服务，假模型不再被调用（F2）；
// - 出场人物（F3）：工坊里一个都不勾选时没有同伴、守卫用默认小人，主角仍按名册；内置关卡照旧按名册的分工；
//   只勾选同伴时只有他出场。名册里的人物用夹具生成（写到系统临时目录，由测试删除），不用真实文件。
// 在测试里起的服务由测试关闭；统计写到系统临时目录，由测试删除。只读测试钩子，不改状态。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildFixture, type FixtureId } from '../../src/asset/fixtures';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import type { GameAppSnapshot } from '../../src/game/appTypes';
import { loadConfig } from '../../server/config';
import { Redactor } from '../../server/errors';
import { FakeProvider, type FakeScript } from '../../server/fakeProvider';
import { createWorkshopServer, listen } from '../../server/http';
import { createLogger } from '../../server/log';
import { createProvider } from '../../server/providers';
import { JsonlStats } from '../../server/stats';
import { Workshop } from '../../server/workshop';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

let dir: string;
/** 名册用的夹具（F3）：主角、同伴、守卫各一个，内容不同（SHA-256 不同）。 */
const fixtureFiles: Record<string, string> = {};

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-playground-workshop-e2e-'));
  const fixtures: [string, FixtureId][] = [
    ['hero.glb', 'skinned-humanoid'],
    ['friend.glb', 'node-animation'],
    ['guard.glb', 'static-mesh'],
  ];
  for (const [name, id] of fixtures) {
    const path = join(dir, name);
    writeFileSync(path, buildFixture(id));
    fixtureFiles[name] = path;
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

/** 在测试里起一个工坊服务（只监听 127.0.0.1 的随机端口），由测试关闭。fake 模式时一并返回假模型（读调用次数用）。 */
async function startService(provider: 'off' | 'fake', delayMs = 0, script: FakeScript = {}) {
  const loaded = loadConfig({ MW_LLM_PROVIDER: provider, MW_WORKSHOP_PORT: '0', MW_WORKSHOP_STATS: join(dir, `stats-${provider}.jsonl`), MW_FAKE_DELAY_MS: String(delayMs) });
  if (!loaded.ok) throw new Error(loaded.problems.join('；'));
  const config = loaded.config;
  const fake = provider === 'fake' ? new FakeProvider({ delayMs, ...script }) : null;
  const workshop = new Workshop({
    config,
    provider: fake ?? createProvider(config),
    stats: new JsonlStats(config.statsPath),
    log: createLogger(new Redactor([]), () => undefined),
  });
  const server = createWorkshopServer(workshop, { maxBodyBytes: config.limits.maxBodyBytes }, createLogger(new Redactor([]), () => undefined));
  const port = await listen(server, 0);
  return {
    port,
    fake,
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

test('工坊生成的关卡：保存后刷新页面再重玩，不再请求工坊服务，也不再调用模型', async ({ page }, testInfo) => {
  const service = await startService('fake');
  const fake = service.fake;
  if (!fake) throw new Error('应该有假模型');
  try {
    await routeTo(page, service.port);
    await open(page, '/?level=test-a');
    await openWorkshop(page);
    await page.getByRole('textbox', { name: '一句话描述想玩的关卡' }).fill('沙漠的白天，宝石集中在一起，一个守卫');
    await page.getByRole('button', { name: '生成关卡' }).click();
    await expect.poll(async () => (await read(page)).levels.workshop.view, { timeout: 15_000 }).toBe('preview');
    const hash = (await read(page)).levels.workshop.previewHash;
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    await page.getByRole('button', { name: '确认工坊关卡' }).click();
    await expect.poll(async () => (await read(page)).level.key).toBe(`saved:${String(hash)}`);
    const saved = await read(page);
    expect(saved.levels.saved).toEqual([expect.objectContaining({ id: hash, source: 'model', status: 'ready' })]);
    expect(saved.level.source).toBe('model');
    expect(saved.level.layoutHash).toBe(hash);
    const rules = saved.level.rules;
    const title = saved.level.title;
    const callsBefore = { ...fake.calls, prepare: fake.prepareCalls };
    expect(callsBefore.structured).toBeGreaterThan(0);

    // 刷新页面：从这时起记录页面发出的所有请求
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await open(page, '/?level=test-a');
    await page.getByRole('button', { name: '选择关卡' }).click();
    await page.getByRole('button', { name: `加载已保存的关卡 ${title}` }).click();
    await expect.poll(async () => (await read(page)).level.key).toBe(`saved:${String(hash)}`);
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
    const replay = await read(page);
    expect(replay.level.source).toBe('model');
    expect(replay.level.layoutHash).toBe(hash);
    expect(replay.level.rules).toEqual(rules);
    expect(replay.game.timeLimit).toBe(rules.timeLimit);
    await page.screenshot({ path: testInfo.outputPath('workshop-replay.png') });

    const workshopCalls = requests.map((u) => new URL(u).pathname).filter((p) => p.startsWith('/api/workshop/'));
    // 只允许健康检查（打开选关界面时工坊查一次服务状态；看得到它，说明请求确实记下来了）
    expect(workshopCalls).toContain('/api/workshop/health');
    expect(workshopCalls.filter((p) => /\/api\/workshop\/(generate|confirm|cancel|discard)$/.test(p))).toEqual([]);
    expect(workshopCalls.every((p) => p === '/api/workshop/health')).toBe(true);
    // 假模型的调用次数在刷新前后不变
    expect({ ...fake.calls, prepare: fake.prepareCalls }).toEqual(callsBefore);
  } finally {
    await service.close();
  }
});

// ---------- F3：工坊生成的关卡，没勾选的人不出场 ----------

/** 工坊面板出场人物区的说明（第 4 条）。 */
const CAST_HINT = '一个都不勾选时，这一关没有同伴，守卫用默认小人；主角仍按名册。';

/** 假模型写的说明书：中地图、2 个守卫；cast 由测试给（人物用代号 r1…，服务换回 ID）。 */
function scriptedBrief(cast: { personId: string; role: 'companion' | 'guard'; line: string }[]) {
  return {
    schemaVersion: 1,
    tier: 'medium',
    density: 'low',
    platforms: 1,
    collectibles: 3,
    distribution: 'scattered',
    guards: 2,
    patrol: 'loop',
    intent: 'normal',
    visual: { theme: 'grass', time: 'day', weather: 'clear' },
    title: '出场人物测试',
    opening: '看看谁出场。',
    cast,
  };
}

async function chooseFixture(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入角色' }).click();
  await (await chooser).setFiles(fixtureFiles[name] ?? '');
  await expect.poll(async () => (await read(page)).import.busy).toBe(false);
  expect((await read(page)).import.error).toBeNull();
}

/** 名册：hero 是主角，friend 是同伴，guard 是守卫（都是夹具）。返回三人的 key。 */
async function setupRoster(page: Page) {
  await chooseFixture(page, 'hero.glb');
  await page.getByRole('button', { name: '设为主角' }).click();
  await expect.poll(async () => (await read(page)).player.model).toBe('imported');
  await chooseFixture(page, 'friend.glb');
  await page.getByRole('button', { name: '加入为新人物' }).click();
  await expect.poll(async () => (await read(page)).roster.entries.length).toBe(2);
  await chooseFixture(page, 'guard.glb');
  await page.getByRole('button', { name: '加入为新人物' }).click();
  await expect.poll(async () => (await read(page)).roster.entries.length).toBe(3);
  await page.getByRole('button', { name: '名册', exact: true }).click();
  await page.getByRole('combobox', { name: 'friend.glb 的分工' }).selectOption('companion');
  await page.getByRole('combobox', { name: 'guard.glb 的分工' }).selectOption('guard');
  await expect
    .poll(async () => {
      const s = await read(page);
      return s.roster.saving ? null : s.roster.entries.map((e) => [e.fileName, e.role, e.status]);
    })
    .toEqual([
      ['hero.glb', 'player', 'ready'],
      ['friend.glb', 'companion', 'ready'],
      ['guard.glb', 'guard', 'ready'],
    ]);
  const entries = (await read(page)).roster.entries;
  const keyOf = (name: string) => entries.find((e) => e.fileName === name)?.key ?? '';
  return { hero: keyOf('hero.glb'), friend: keyOf('friend.glb'), guard: keyOf('guard.glb') };
}

/** 在工坊里生成、确认（加载这一关），再点“开始”。 */
async function generateConfirmStart(page: Page, text: string) {
  await page.getByRole('textbox', { name: '一句话描述想玩的关卡' }).fill(text);
  await page.getByRole('button', { name: '生成关卡' }).click();
  await expect.poll(async () => (await read(page)).levels.workshop.view, { timeout: 15_000 }).toBe('preview');
  const hash = (await read(page)).levels.workshop.previewHash;
  await page.getByRole('button', { name: '确认工坊关卡' }).click();
  await expect.poll(async () => (await read(page)).level.key).toBe(`saved:${String(hash)}`);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  return read(page);
}

test('出场人物（F3）：工坊里一个都不勾选——没有同伴，守卫用默认小人，主角按名册；换成内置关卡时照旧按名册的分工', async ({ page }, testInfo) => {
  const service = await startService('fake', 0, { briefs: [{ kind: 'json', value: scriptedBrief([]) }] });
  try {
    await routeTo(page, service.port);
    await open(page, '/?level=test-a');
    const keys = await setupRoster(page);
    await openWorkshop(page);
    // 出场人物区的标题和说明（第 4 条）；一个都不勾选
    await expect(page.locator('#level-workshop')).toContainText('出场人物（没勾选的人不出场）');
    await expect(page.locator('#level-workshop').getByText(CAST_HINT)).toBeVisible();
    for (const name of ['hero.glb', 'friend.glb', 'guard.glb']) {
      await expect(page.getByRole('checkbox', { name: `让 ${name} 出场` })).not.toBeChecked();
    }
    await page.screenshot({ path: testInfo.outputPath('workshop-cast-hint.png') });

    const s = await generateConfirmStart(page, '中等大小的草地，两个守卫绕圈巡逻');
    expect(s.level.source).toBe('model');
    expect(s.level.brief?.cast).toEqual([]);
    expect(s.game.guards).toHaveLength(2);
    expect(s.cast.player).toEqual({ personId: keys.hero, model: 'imported' });
    expect(s.player).toMatchObject({ model: 'imported', personId: keys.hero });
    expect(s.cast.companions).toEqual([]);
    expect(s.game.companions).toEqual([]);
    expect(s.cast.guards.map((g) => g.personId)).toEqual([null, null]);
    expect(s.cast.guards.every((g) => g.model === 'default')).toBe(true);
    // 名册里的分工没有被改
    expect(s.roster.entries.map((e) => e.role)).toEqual(['player', 'companion', 'guard']);
    expect(s.instances).toBe(1);

    // 同一个名册，换成内置关卡（晨光草地：说明书没有出场人物）：同伴和守卫照旧按名册的分工出场
    await open(page, '/?level=gen-1');
    await expect.poll(async () => (await read(page)).cast.guards[0]?.personId).toBe(keys.guard);
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
    const builtin = await read(page);
    expect(builtin.level.source).toBe('builtin');
    expect(builtin.level.brief?.cast).toEqual([]);
    expect(builtin.cast.player.personId).toBe(keys.hero);
    expect(builtin.cast.companions).toEqual([{ personId: keys.friend, model: 'imported' }]);
    expect(builtin.game.companions.map((c) => c.id)).toEqual([keys.friend]);
    expect(builtin.cast.guards.map((g) => g.personId)).toEqual([keys.guard]);
  } finally {
    await service.close();
  }
});

test('出场人物（F3）：工坊里只勾选同伴（只当同伴）——只有他作为同伴出场，名册里的守卫不出场', async ({ page }) => {
  const service = await startService('fake', 0, { briefs: [{ kind: 'json', value: scriptedBrief([{ personId: 'r1', role: 'companion', line: '我跟着你。' }]) }] });
  const fake = service.fake;
  if (!fake) throw new Error('应该有假模型');
  try {
    await routeTo(page, service.port);
    await open(page, '/?level=test-a');
    const keys = await setupRoster(page);
    await openWorkshop(page);
    await page.getByRole('checkbox', { name: '让 friend.glb 出场' }).check();
    await page.getByRole('combobox', { name: 'friend.glb 可以当' }).selectOption('companion');

    const s = await generateConfirmStart(page, '中等大小的草地，让朋友跟着我');
    // 发给服务的名册快照里只有勾选的人
    const prompt = fake.prompts.join('\n');
    expect(prompt).toContain('friend.glb');
    expect(prompt).not.toContain('hero.glb');
    expect(prompt).not.toContain('guard.glb');
    expect(s.level.source).toBe('model');
    expect(s.level.brief?.cast).toEqual([expect.objectContaining({ personId: keys.friend, role: 'companion' })]);
    expect(s.cast.player).toEqual({ personId: keys.hero, model: 'imported' });
    expect(s.cast.companions).toEqual([{ personId: keys.friend, model: 'imported' }]);
    expect(s.game.companions.map((c) => c.id)).toEqual([keys.friend]);
    expect(s.cast.guards.map((g) => g.personId)).toEqual([null, null]);
    expect(s.instances).toBe(2);
  } finally {
    await service.close();
  }
});

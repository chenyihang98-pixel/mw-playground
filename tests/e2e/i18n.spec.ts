// 界面语言（F6）的端到端测试。浏览器语言固定为 zh-CN（playwright.config.ts），在开始界面的语言选择里切换。
// - ja、en 各走一遍完整流程（工坊用假模型）：开始界面 → 导入夹具角色 → 设为主角 → 加入名册 → 关卡工坊生成 → 预览 → 确认
//   → 开始面板 → HUD → 暂停菜单 → 胜利面板（测试小关 A 按住 W）→ 刷新后语言保持；
//   每个画面检查界面文字（en：没有汉字和假名；ja：没有和日语不同的中文界面文字），检查按钮、标签不溢出、面板没有横向滚动，
//   并截图到 test-results/i18n/（不提交）。用户数据和生成的文字所在的元素标了 data-i18n-raw，检查时跳过。
// - 切换：开始界面 zh → ja → en，界面跟着变，刷新后保持；名册、已保存的关卡、静音设置都还在；暂停菜单里也能切换。
// 夹具写到系统临时目录，测试结束后删除。只读测试钩子，不改状态。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildFixture } from '../../src/asset/fixtures';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import type { GameAppSnapshot } from '../../src/game/appTypes';
import { messagesOf, type MessageKey } from '../../src/i18n';
import { LANG_STORAGE_KEY, LANG_TAGS, type Lang } from '../../src/i18n/lang';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

const SHOTS = join(process.cwd(), 'test-results', 'i18n');
let dir: string;
const files: Record<string, string> = {};

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mw-playground-i18n-e2e-'));
  for (const [name, id] of [
    ['hero.glb', 'skinned-humanoid'],
    ['friend.glb', 'node-animation'],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, buildFixture(id));
    files[name] = path;
  }
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.describe.configure({ timeout: 180_000 });

function read(page: Page): Promise<GameAppSnapshot> {
  return page.evaluate(() => {
    const hooks = window.__MW_TEST__ as Hooks | undefined;
    if (hooks?.kind !== 'game') throw new Error('游戏测试钩子不存在');
    return hooks.getState();
  });
}

async function ready(page: Page) {
  await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
  await expect.poll(async () => {
    const s = await read(page);
    return !s.roster.restoring && !s.levels.loading;
  }).toBe(true);
}

/** 在开始界面的语言选择里切换（会刷新页面）。 */
async function switchOnHome(page: Page, lang: Lang) {
  await Promise.all([page.waitForEvent('load'), page.locator('#home-lang').selectOption(lang)]);
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('lang', LANG_TAGS[lang]);
}

/** 日语界面里不该出现的中文：中文词典里和日语不同的那些文字（按占位拆开，只留含汉字、至少两个字、日语词典里也没有的片段）。 */
function forbiddenForJa(): string[] {
  const zh = messagesOf('zh');
  const ja = messagesOf('ja');
  const jaText = Object.values(ja).join('\n');
  const out = new Set<string>();
  for (const key of Object.keys(zh) as MessageKey[]) {
    if (zh[key] === ja[key]) continue;
    for (const part of zh[key].split(/\{\w+\}/)) {
      const fragment = part.trim();
      if (fragment.length >= 2 && /[㐀-鿿]/.test(fragment) && !jaText.includes(fragment)) out.add(fragment);
    }
  }
  return [...out];
}

/** 屏幕上看得到的界面文字里不合要求的部分（跳过 data-i18n-raw）。 */
function textProblems(page: Page, lang: 'ja' | 'en', forbidden: readonly string[]): Promise<string[]> {
  return page.evaluate(
    ({ lang, forbidden }) => {
      const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
      const raw = (el: Element) => el.closest('[data-i18n-raw]') !== null;
      const shown = (el: Element) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;
      const texts: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim() ?? '';
        const parent = node.parentElement;
        if (!text || !parent || raw(parent) || parent.closest('script, style, option') || !shown(parent)) continue;
        texts.push(text);
      }
      for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]')) {
        if (shown(el) && !raw(el) && el.value === '') texts.push(el.placeholder);
      }
      for (const el of document.querySelectorAll('select')) {
        if (shown(el) && !raw(el)) texts.push(el.selectedOptions[0]?.text ?? '');
      }
      return lang === 'en' ? texts.filter((t) => CJK.test(t)) : texts.filter((t) => forbidden.some((f) => t.includes(f)));
    },
    { lang, forbidden },
  );
}

/** 可见的按钮、标签、表头文字不溢出、不被截断；面板和页面没有横向滚动。 */
function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const shown = (el: Element) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;
    const hasRaw = (el: Element) => el.closest('[data-i18n-raw]') !== null || el.querySelector('[data-i18n-raw]') !== null;
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : ''} “${el.textContent.trim().slice(0, 30)}”`;
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, label, .mw-tag, th, dt, summary, .mw-btn-label, .ws-label, .mw-section-title, .level-name')) {
      if (!shown(el) || hasRaw(el) || getComputedStyle(el).display === 'inline') continue;
      if (el.scrollWidth > el.clientWidth + 1) bad.push(`${name(el)} ${String(el.scrollWidth)} > ${String(el.clientWidth)}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>('.mw-panel, .mw-panel-body, .mw-scroll, [role="dialog"], .home-card, #hud')) {
      if (!shown(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        // 找出超出右边的元素，方便定位
        const right = el.getBoundingClientRect().right;
        const over = [...el.querySelectorAll('*')].filter((c) => shown(c) && c.getBoundingClientRect().right > right + 1).slice(-3).map(name);
        bad.push(`横向滚动 ${name(el)} ${String(el.scrollWidth)} > ${String(el.clientWidth)}：${over.join(' | ')}`);
      }
    }
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) bad.push(`页面横向滚动 ${String(root.scrollWidth)} > ${String(root.clientWidth)}`);
    return bad;
  });
}

/** 一个画面：检查界面文字和版面，截图。 */
async function screen(page: Page, lang: 'ja' | 'en', n: number, label: string, forbidden: readonly string[]) {
  await page.waitForTimeout(150); // 等界面画完（动画、淡入）
  expect(await textProblems(page, lang, forbidden), `${lang} ${label}：界面文字`).toEqual([]);
  expect(await layoutProblems(page), `${lang} ${label}：版面`).toEqual([]);
  await page.screenshot({ path: join(SHOTS, `${lang}-${String(n).padStart(2, '0')}-${label}.png`) });
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

for (const lang of ['ja', 'en'] as const) {
  test(`${lang}：开始界面 → 导入 → 主角 → 名册 → 关卡工坊 → 预览 → 确认 → 开始面板 → HUD → 暂停 → 胜利 → 刷新后语言保持`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const m = messagesOf(lang);
    const forbidden = lang === 'ja' ? forbiddenForJa() : [];
    if (lang === 'ja') expect(forbidden.length).toBeGreaterThan(100);
    let n = 0;

    // 开始界面（浏览器语言是 zh-CN），在语言选择里切换
    await page.goto('/');
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await switchOnHome(page, lang);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LANG_STORAGE_KEY)).toBe(lang);
    expect((await read(page)).ui.home).toBe(true);
    await expect(page.locator('#mw-home h1')).toHaveText(m['app.title']);
    await screen(page, lang, ++n, 'home', forbidden);

    // 导入夹具角色：卡片
    await page.locator('#import-file').setInputFiles(files['hero.glb'] ?? '');
    await expect.poll(async () => (await read(page)).import.card?.fileName).toBe('hero.glb');
    await screen(page, lang, ++n, 'import-card', forbidden);

    // 设为主角；再导入一个，加入名册
    await page.getByRole('button', { name: m['import.setPlayer'], exact: true }).click();
    await expect.poll(async () => (await read(page)).player.model).toBe('imported');
    await page.locator('#import-file').setInputFiles(files['friend.glb'] ?? '');
    await expect.poll(async () => (await read(page)).import.card?.fileName).toBe('friend.glb');
    await page.getByRole('button', { name: m['import.addPerson'], exact: true }).click();
    await expect.poll(async () => (await read(page)).roster.entries.length).toBe(2);
    // 从开始界面打开的导入卡片关掉后回到开始界面，再打开名册
    await page.getByRole('button', { name: m['common.close'], exact: true }).filter({ visible: true }).first().click();
    await expect.poll(async () => (await read(page)).ui.panel).toBeNull();
    await page.getByRole('button', { name: m['common.roster'], exact: true }).filter({ visible: true }).first().click();
    await expect.poll(async () => (await read(page)).ui.panel).toBe('roster');
    await expect.poll(async () => (await read(page)).roster.saving).toBe(false);
    await screen(page, lang, ++n, 'roster', forbidden);

    // 选择关卡（关卡工坊在右栏）：先关掉名册回到开始界面
    await page.getByRole('button', { name: m['roster.close'], exact: true }).click();
    await expect.poll(async () => (await read(page)).ui.panel).toBeNull();
    await page.getByRole('button', { name: m['levels.choose'] }).filter({ visible: true }).first().click();
    await expect.poll(async () => (await read(page)).ui.panel).toBe('levels');
    await expect.poll(async () => (await read(page)).levels.workshop.health.kind, { timeout: 10_000 }).not.toBe('checking');
    await screen(page, lang, ++n, 'levels', forbidden);

    // 关卡工坊：生成中（假模型每次调用前等 800 毫秒）→ 预览
    await page.getByRole('textbox', { name: m['workshop.inputLabel'] }).fill(lang === 'en' ? 'A rainy night with gems on the platforms' : '雨の夜、宝石は高台の上');
    await page.getByRole('button', { name: m['workshop.generate'], exact: true }).click();
    await expect.poll(async () => (await read(page)).levels.workshop.view).toBe('running');
    await expect(page.getByText(m['workshop.runningHint'])).toBeVisible();
    await screen(page, lang, ++n, 'workshop-running', forbidden);
    await expect.poll(async () => (await read(page)).levels.workshop.view, { timeout: 15_000 }).toBe('preview');
    await screen(page, lang, ++n, 'workshop-preview', forbidden);

    // 确认：保存并加载这一关，显示开始面板
    const hash = (await read(page)).levels.workshop.previewHash;
    await page.getByRole('button', { name: m['workshop.confirmLabel'], exact: true }).click();
    await expect.poll(async () => (await read(page)).level.key).toBe(`saved:${String(hash)}`);
    await expect.poll(async () => (await read(page)).overlay).toBe('start');
    await expect.poll(async () => (await read(page)).ui.panel).toBeNull();
    expect((await read(page)).level.sourceLabel).toBe(m['source.model']);
    await screen(page, lang, ++n, 'start-panel', forbidden);

    // 开始：HUD；暂停菜单（里面也有语言选择）
    await page.getByRole('button', { name: m['common.start'], exact: true }).filter({ visible: true }).click();
    await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
    await page.waitForTimeout(300);
    await screen(page, lang, ++n, 'hud', forbidden);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
    await expect(page.locator('#pause-lang')).toBeVisible();
    await expect(page.locator('#pause-lang')).toHaveValue(lang);
    await screen(page, lang, ++n, 'pause', forbidden);
    await page.getByRole('button', { name: m['hud.resume'], exact: true }).click();
    await expect.poll(async () => (await read(page)).game.phase).toBe('playing');

    // 胜利面板：测试小关 A，按住 W 走到收集点（语言来自保存的选择）
    await page.goto('/?level=test-a');
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('lang', LANG_TAGS[lang]);
    await page.getByRole('button', { name: m['common.start'], exact: true }).filter({ visible: true }).click();
    await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
    await page.keyboard.down('KeyW');
    await expect.poll(async () => (await read(page)).game.phase, { timeout: 15_000 }).toBe('won');
    await page.keyboard.up('KeyW');
    await expect(page.getByRole('dialog').filter({ hasText: m['hud.won'] })).toBeVisible();
    await screen(page, lang, ++n, 'won', forbidden);

    // 刷新后语言保持
    await page.reload();
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('lang', LANG_TAGS[lang]);
    await expect(page.getByRole('button', { name: m['common.start'], exact: true }).filter({ visible: true })).toBeVisible();
    await screen(page, lang, ++n, 'reloaded', forbidden);
  });
}

test('切换：开始界面 zh → ja → en，界面跟着变，刷新后保持；名册、已保存的关卡、静音设置都还在；暂停菜单里也能切换', async ({ page }) => {
  const zh = messagesOf('zh');
  // 准备数据：名册里一个人物、一关已保存的随机关卡、静音
  await page.goto('/');
  await ready(page);
  await page.locator('#import-file').setInputFiles(files['friend.glb'] ?? '');
  await expect.poll(async () => (await read(page)).import.card?.fileName).toBe('friend.glb');
  await page.getByRole('button', { name: zh['import.addPerson'], exact: true }).click();
  await expect.poll(async () => (await read(page)).roster.entries.length).toBe(1);
  await page.getByRole('button', { name: zh['common.close'], exact: true }).filter({ visible: true }).first().click();
  await expect.poll(async () => (await read(page)).ui.panel).toBeNull();
  await page.getByRole('button', { name: zh['levels.choose'] }).filter({ visible: true }).first().click();
  await page.getByRole('button', { name: zh['levels.random'], exact: true }).filter({ visible: true }).click();
  await expect.poll(async () => (await read(page)).levels.select.random.kind, { timeout: 20_000 }).toBe('preview');
  await page.getByRole('button', { name: zh['random.confirmLabel'], exact: true }).click();
  await expect.poll(async () => (await read(page)).levels.saved.length).toBe(1);
  await page.goto('/');
  await ready(page);
  await page.locator('#mw-home').getByRole('button', { name: zh['sound.mute'] }).click();
  await expect.poll(async () => (await read(page)).audio.muted).toBe(true);
  await expect.poll(async () => (await read(page)).roster.saving).toBe(false);
  const savedId = (await read(page)).levels.saved[0]?.id;

  const home = page.locator('#mw-home');
  await expect(home.getByRole('button', { name: zh['common.start'], exact: true })).toBeVisible();
  for (const lang of ['ja', 'en'] as const) {
    const m = messagesOf(lang);
    await switchOnHome(page, lang);
    await expect(home.locator('h1')).toHaveText(m['app.title']);
    await expect(home.getByRole('button', { name: m['common.start'], exact: true })).toBeVisible();
    await expect(home.locator('.home-tagline')).toHaveText(m['home.tagline']);
    await expect(page.locator('#home-lang')).toHaveValue(lang);
    const s = await read(page);
    expect(s.roster.entries.map((e) => [e.fileName, e.status])).toEqual([['friend.glb', 'ready']]);
    expect(s.levels.saved.map((e) => e.id)).toEqual([savedId]);
    expect(s.audio.muted).toBe(true);
  }

  // 刷新后保持 en
  await page.reload();
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(home.getByRole('button', { name: messagesOf('en')['common.start'], exact: true })).toBeVisible();

  // 暂停菜单里切回中文：刷新后在这一关的开始面板，界面是中文，数据都还在
  await page.goto('/?level=test-a');
  await ready(page);
  await page.getByRole('button', { name: messagesOf('en')['common.start'], exact: true }).filter({ visible: true }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');
  await Promise.all([page.waitForEvent('load'), page.locator('#pause-lang').selectOption('zh')]);
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('button', { name: zh['common.start'], exact: true }).filter({ visible: true })).toBeVisible();
  const after = await read(page);
  expect(after.game.phase).toBe('ready');
  expect(after.roster.entries.map((e) => e.fileName)).toEqual(['friend.glb']);
  expect(after.levels.saved.map((e) => e.id)).toEqual([savedId]);
  expect(after.audio.muted).toBe(true);
});

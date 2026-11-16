// 界面语言（F6）：浏览器语言固定 zh-CN，在语言选择里切换。ja、en 完整流程每个画面查文字和版面并截图到 test-results/i18n/
// （跳过 data-i18n-raw）；切换后数据都在；写入没做完时切换；空的 navigator.languages。夹具在系统临时目录，测试后删除。

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

/** 日语界面不该有的中文：和日语不同的中文词条按占位拆开，留含汉字、至少两字、日语词典里没有的片段。 */
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
    // 原生下拉框比自然宽度（容得下最长的选项）窄，就有选项被截断
    for (const select of document.querySelectorAll('select')) {
      if (!shown(select) || hasRaw(select)) continue;
      const clone = select.cloneNode(true) as HTMLSelectElement;
      clone.removeAttribute('id');
      Object.assign(clone.style, { position: 'absolute', visibility: 'hidden', left: '0', top: '0', width: 'auto', minWidth: '0', maxWidth: 'none', flex: 'none' });
      select.parentElement?.append(clone);
      const natural = clone.getBoundingClientRect().width;
      clone.remove();
      const actual = select.getBoundingClientRect().width;
      if (actual + 1 < natural) bad.push(`下拉框被截断 ${name(select)} ${actual.toFixed(0)} < ${natural.toFixed(0)}`);
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
  test(`${lang}：完整流程，每个画面的文字和版面`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const m = messagesOf(lang);
    const forbidden = lang === 'ja' ? forbiddenForJa() : [];
    if (lang === 'ja') expect(forbidden.length).toBeGreaterThan(100);
    let n = 0;

    await page.goto('/');
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await switchOnHome(page, lang);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LANG_STORAGE_KEY)).toBe(lang);
    expect((await read(page)).ui.home).toBe(true);
    await expect(page.locator('#mw-home h1')).toHaveText(m['app.title']);
    await screen(page, lang, ++n, 'home', forbidden);

    await page.locator('#import-file').setInputFiles(files['hero.glb'] ?? '');
    await expect.poll(async () => (await read(page)).import.card?.fileName).toBe('hero.glb');
    await screen(page, lang, ++n, 'import-card', forbidden);

    await page.getByRole('button', { name: m['import.setPlayer'], exact: true }).click();
    await expect.poll(async () => (await read(page)).player.model).toBe('imported');
    await page.locator('#import-file').setInputFiles(files['friend.glb'] ?? '');
    await expect.poll(async () => (await read(page)).import.card?.fileName).toBe('friend.glb');
    await page.getByRole('button', { name: m['import.addPerson'], exact: true }).click();
    await expect.poll(async () => (await read(page)).roster.entries.length).toBe(2);
    await page.getByRole('button', { name: m['common.close'], exact: true }).filter({ visible: true }).first().click();
    await expect.poll(async () => (await read(page)).ui.panel).toBeNull();
    await page.getByRole('button', { name: m['common.roster'], exact: true }).filter({ visible: true }).first().click();
    await expect.poll(async () => (await read(page)).ui.panel).toBe('roster');
    await expect.poll(async () => (await read(page)).roster.saving).toBe(false);
    await screen(page, lang, ++n, 'roster', forbidden);

    await page.getByRole('button', { name: m['roster.close'], exact: true }).click();
    await expect.poll(async () => (await read(page)).ui.panel).toBeNull();
    await page.getByRole('button', { name: m['levels.choose'] }).filter({ visible: true }).first().click();
    await expect.poll(async () => (await read(page)).ui.panel).toBe('levels');
    await expect.poll(async () => (await read(page)).levels.workshop.health.kind, { timeout: 10_000 }).not.toBe('checking');
    await screen(page, lang, ++n, 'levels', forbidden);

    // 假模型每次调用前等 800 毫秒
    await page.getByRole('textbox', { name: m['workshop.inputLabel'] }).fill(lang === 'en' ? 'A rainy night with gems on the platforms' : '雨の夜、宝石は高台の上');
    await page.getByRole('button', { name: m['workshop.generate'], exact: true }).click();
    await expect.poll(async () => (await read(page)).levels.workshop.view).toBe('running');
    await expect(page.getByText(m['workshop.runningHint'])).toBeVisible();
    await screen(page, lang, ++n, 'workshop-running', forbidden);
    await expect.poll(async () => (await read(page)).levels.workshop.view, { timeout: 15_000 }).toBe('preview');
    await screen(page, lang, ++n, 'workshop-preview', forbidden);

    const hash = (await read(page)).levels.workshop.previewHash;
    await page.getByRole('button', { name: m['workshop.confirmLabel'], exact: true }).click();
    await expect.poll(async () => (await read(page)).level.key).toBe(`saved:${String(hash)}`);
    await expect.poll(async () => (await read(page)).overlay).toBe('start');
    await expect.poll(async () => (await read(page)).ui.panel).toBeNull();
    expect((await read(page)).level.sourceLabel).toBe(m['source.model']);
    await screen(page, lang, ++n, 'start-panel', forbidden);

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

    // 胜利面板：测试小关 A 按住 W（语言来自保存的选择）
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

    await page.reload();
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('lang', LANG_TAGS[lang]);
    await expect(page.getByRole('button', { name: m['common.start'], exact: true }).filter({ visible: true })).toBeVisible();
    await screen(page, lang, ++n, 'reloaded', forbidden);
  });
}

test('切换 zh → ja → en 后刷新保持，数据都在；暂停菜单也能切换', async ({ page }) => {
  const zh = messagesOf('zh');
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

  await page.reload();
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(home.getByRole('button', { name: messagesOf('en')['common.start'], exact: true })).toBeVisible();

  // 暂停菜单里切回中文
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

/** 开一个读写事务占住对象仓库 ms 毫秒，游戏之后的写入排在后面（模拟写入还没做完）。事务开始后返回。 */
async function holdStore(page: Page, db: string, store: string, ms: number) {
  await page.evaluate(
    ({ db, store, ms }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(db);
        open.onerror = () => {
          reject(new Error(String(open.error)));
        };
        open.onsuccess = () => {
          const conn = open.result;
          const tx = conn.transaction(store, 'readwrite');
          const objects = tx.objectStore(store);
          const until = performance.now() + ms;
          let started = false;
          const spin = () => {
            const req = objects.get('__f6-hold__');
            req.onsuccess = () => {
              if (!started) {
                started = true;
                resolve();
              }
              if (performance.now() < until) spin();
            };
          };
          spin();
          tx.oncomplete = () => {
            conn.close();
          };
        };
      }),
    { db, store, ms },
  );
}

test('名册写入没做完时在开始界面切换：刷新后改动还在', async ({ page }) => {
  const zh = messagesOf('zh');
  await page.goto('/');
  await ready(page);
  await page.locator('#import-file').setInputFiles(files['friend.glb'] ?? '');
  await expect.poll(async () => (await read(page)).import.card?.fileName).toBe('friend.glb');
  await page.getByRole('button', { name: zh['import.addPerson'], exact: true }).click();
  await expect.poll(async () => (await read(page)).roster.saving).toBe(false);
  await page.getByRole('button', { name: zh['common.close'], exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('button', { name: zh['common.roster'], exact: true }).filter({ visible: true }).first().click();
  await expect.poll(async () => (await read(page)).ui.panel).toBe('roster');

  await holdStore(page, 'mw-playground', 'roster', 2500);
  await page.getByRole('combobox', { name: zh['roster.roleOf'].replace('{name}', 'friend.glb') }).selectOption('companion');
  await page.getByRole('button', { name: zh['roster.close'], exact: true }).click();
  expect((await read(page)).roster.saving).toBe(true);

  await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), page.locator('#home-lang').selectOption('en')]);
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect((await read(page)).roster.entries.map((e) => [e.fileName, e.role, e.status])).toEqual([['friend.glb', 'companion', 'ready']]);
});

test('关卡写入没做完时在暂停菜单切换：刷新后这一关还在', async ({ page }) => {
  const zh = messagesOf('zh');
  await page.goto('/?level=test-a');
  await ready(page);
  await page.getByRole('button', { name: zh['levels.choose'] }).filter({ visible: true }).first().click();
  await page.getByRole('button', { name: zh['levels.random'], exact: true }).filter({ visible: true }).click();
  await expect.poll(async () => (await read(page)).levels.select.random.kind, { timeout: 20_000 }).toBe('preview');

  await holdStore(page, 'mw-playground-levels', 'levels', 2500);
  await page.getByRole('button', { name: zh['random.confirmLabel'], exact: true }).click();
  await expect.poll(async () => (await read(page)).levels.saved.length).toBe(1);
  const savedId = (await read(page)).levels.saved[0]?.id;
  await page.getByRole('button', { name: zh['common.start'], exact: true }).filter({ visible: true }).click();
  await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).game.phase).toBe('paused');

  await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), page.locator('#pause-lang').selectOption('ja')]);
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  expect((await read(page)).levels.saved.map((e) => [e.id, e.status])).toEqual([[savedId, 'ready']]);
});

test('navigator.languages 为空时入口按 en，不看 navigator.language', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => [] });
    Object.defineProperty(Navigator.prototype, 'language', { get: () => 'ja-JP' });
  });
  await page.goto('/');
  await ready(page);
  expect(await page.evaluate(() => [navigator.languages.length, navigator.language])).toEqual([0, 'ja-JP']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#mw-home').getByRole('button', { name: messagesOf('en')['common.start'], exact: true })).toBeVisible();
});

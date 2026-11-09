// 端到端（Chromium）：页面无控制台错误、场景已渲染、夹具预览在播放片段。
// 测试钩子只用来观察状态和选择夹具。

import { expect, test, type Page } from '@playwright/test';
import type { MwTestState } from '../../src/dev/testHooks';

function getState(page: Page): Promise<MwTestState> {
  return page.evaluate(() => {
    const hooks = window.__MW_TEST__;
    if (!hooks) throw new Error('测试钩子不存在');
    return hooks.getState();
  });
}

async function waitForPreview(page: Page, fixtureId: string) {
  await page.waitForFunction((id) => {
    const state = window.__MW_TEST__?.getState();
    return state?.preview.status === 'ready' && state.preview.fixtureId === id;
  }, fixtureId);
}

test.describe('场景与夹具预览', () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(`pageerror: ${error.message}`);
    });
    await page.goto('/');
    await waitForPreview(page, 'skinned-humanoid');
  });

  test.afterEach(() => {
    expect(consoleErrors).toEqual([]);
  });

  test('场景已渲染，带骨骼的夹具在播放，截图存到输出目录', async ({ page }, testInfo) => {
    const canvas = await page.evaluate(() => {
      const el = document.querySelector<HTMLCanvasElement>('#scene');
      if (!el) return null;
      const gl = el.getContext('webgl2');
      return {
        width: el.width,
        height: el.height,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        webgl2: gl !== null,
        contextLost: gl?.isContextLost() ?? true,
      };
    });
    expect(canvas).not.toBeNull();
    expect(canvas?.width).toBeGreaterThan(0);
    expect(canvas?.height).toBeGreaterThan(0);
    expect(canvas?.clientWidth).toBeGreaterThan(0);
    expect(canvas?.webgl2).toBe(true);
    expect(canvas?.contextLost).toBe(false);

    const first = await getState(page);
    expect(first.mode).toBe('test');
    expect(first.preview.clips.map((c) => c.name)).toEqual(['idle', 'walk', 'run']);
    expect(first.preview.clips.map((c) => (c.hasLoop ? c.loop : '无 loop'))).toEqual([true, true, '无 loop']);
    expect(first.preview.activeClip).toBe(0);

    // 渲染循环在跑，画面里有三角形（地面 + 人形）
    await expect.poll(async () => (await getState(page)).render.frames).toBeGreaterThan(first.render.frames + 5);
    const rendered = await getState(page);
    expect(rendered.render.drawCalls).toBeGreaterThan(0);
    expect(rendered.render.triangles).toBeGreaterThan(60);

    // mixer 的时间在前进
    await expect.poll(async () => (await getState(page)).preview.mixerTime).toBeGreaterThan(first.preview.mixerTime + 0.2);
    const later = await getState(page);
    expect(later.preview.actionTime).not.toBeNull();

    await page.screenshot({ path: testInfo.outputPath('scene.png') });
  });

  test('通过测试钩子选择夹具：root-motion 和 extras-number', async ({ page }) => {
    const fixtures = await page.evaluate(() => window.__MW_TEST__?.listFixtures() ?? []);
    expect(fixtures.filter((f) => f.previewable).map((f) => f.id)).toContain('root-motion');

    const rootMotion = await page.evaluate(() => window.__MW_TEST__?.selectFixture('root-motion'));
    expect(rootMotion?.preview.fixtureId).toBe('root-motion');
    expect(rootMotion?.preview.clips.map((c) => c.name)).toEqual(['walk_forward']);
    await expect.poll(async () => (await getState(page)).preview.mixerTime).toBeGreaterThan((rootMotion?.preview.mixerTime ?? 0) + 0.1);

    // extras 不是对象：GLTFLoader 只打 warning（不是 error），加载后 userData 里没有 loop
    const extrasNumber = await page.evaluate(() => window.__MW_TEST__?.selectFixture('extras-number'));
    expect(extrasNumber?.preview.clips).toEqual([{ name: 'jump', duration: 1, hasLoop: false, loop: undefined }]);
  });

  test('不能预览的夹具被拒绝', async ({ page }) => {
    const message = await page.evaluate(async () => {
      try {
        await window.__MW_TEST__?.selectFixture('draco-required');
        return 'no error';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(message).toContain('不能在页面里预览');
    expect((await getState(page)).preview.fixtureId).toBe('skinned-humanoid');
  });
});

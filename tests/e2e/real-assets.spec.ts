// 可选的真实资产测试组：读取环境变量 MW_ASSET_DIR 指向的目录（项目外，只读），经文件选择框逐个导入。
// 没设 MW_ASSET_DIR 时整组跳过。真实文件不复制进项目；截图存到 Playwright 的输出目录（不提交）。

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { inspectGlb } from '../../src/asset/inspect';
import type { MwGameTestHooks } from '../../src/dev/gameTestHooks';
import type { GameAppSnapshot } from '../../src/game/appTypes';
import { NO_MOVEMENT_NOTICE } from '../../src/import/clipRules';

type Hooks = MwGameTestHooks<GameAppSnapshot>;

const SKIP_MESSAGE = '跳过：未提供真实资产目录';
const assetDir = process.env.MW_ASSET_DIR;

function read(page: Page): Promise<GameAppSnapshot> {
  return page.evaluate(() => {
    const hooks = window.__MW_TEST__ as Hooks | undefined;
    if (hooks?.kind !== 'game') throw new Error('游戏测试钩子不存在');
    return hooks.getState();
  });
}

if (!assetDir) {
  test.describe('真实资产（可选）', () => {
    test('真实资产', () => {
      console.log(`${SKIP_MESSAGE}（设置环境变量 MW_ASSET_DIR 后运行这一组）`);
      test.skip(true, SKIP_MESSAGE);
    });
  });
} else {
  const files = readdirSync(assetDir)
    .filter((name) => ['.glb', '.obj', '.stl', '.ply'].includes(extname(name).toLowerCase()))
    .sort();

  test.describe('真实资产（可选）', () => {
    test.describe.configure({ timeout: 120_000 });

    if (files.length === 0) {
      test('真实资产', () => {
        console.log(`跳过：${assetDir} 里没有 .glb / .obj / .stl / .ply 文件`);
        test.skip(true, '跳过：目录里没有可导入的文件');
      });
    }

    for (const name of files) {
      test(`真实资产：${name}`, async ({ page }, testInfo) => {
        const path = join(assetDir, name);
        const consoleErrors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

        // Node 这边只读文件做结构预期（是否有贴图、骨骼、片段），不写任何文件
        const report = extname(name).toLowerCase() === '.glb' ? inspectGlb(readFileSync(path)) : null;
        const expected = report?.ok ? report.report : null;

        await page.goto('/?level=test-a');
        await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: '导入角色' }).click();
        await (await chooser).setFiles(path);
        await expect.poll(async () => (await read(page)).import.busy, { timeout: 60_000 }).toBe(false);

        const state = await read(page);
        expect(state.import.error, '导入应该成功').toBeNull();
        const card = state.import.card;
        if (!card) throw new Error('没有导入卡片');
        console.log(
          `${name}：${String(card.triangles)} 三角面，${card.skinned ? `${String(card.bones)} 根骨骼` : '无骨骼'}，` +
            (card.bindPose ? `IBM 参照系 ${card.bindPose.convention}，` : '') +
            `尺寸 ${card.size.width.toFixed(2)} × ${card.size.height.toFixed(2)} × ${card.size.depth.toFixed(2)} m，${String(card.clips.length)} 个片段，贴图 ${card.textures.map((t) => `${String(t.width)}×${String(t.height)}`).join('、') || '无'}；` +
            `建议：待机 ${String(card.slots.idle)}、走 ${String(card.slots.walk)}、跑 ${String(card.slots.run)}、跳 ${String(card.slots.jump)}`,
        );
        for (const c of card.clips) {
          const motion =
            c.rootMotion.kind === 'identified'
              ? `${String(c.rootMotion.nodeName)} 位移 ${(c.rootMotion.maxHorizontal ?? 0).toFixed(3)} m${c.rootMotion.flagged ? '（带位移）' : ''}`
              : c.rootMotion.kind;
          console.log(
            `  #${String(c.index)} ${c.name}（${c.duration.toFixed(3)} s）：用途 ${c.purpose}，播放 ${c.playback}（${c.playbackSource}，loop=${c.loopRaw}），` +
              `${motion}${c.slot ? `，用于 ${c.slot}` : ''}${c.short ? '，极短' : ''}`,
          );
        }

        // 材质有贴图时贴图已加载（加载后能读到尺寸，且与文件里声明的图片尺寸一致）
        if (expected && expected.textures.textureCount > 0) {
          expect(card.textures.length).toBeGreaterThan(0);
          for (const t of card.textures) expect(t.width * t.height).toBeGreaterThan(0);
          const declared = expected.textures.images.flatMap((i) => (i.size.status === 'computed' ? [i.size.value] : []));
          for (const t of card.textures) expect(declared).toContainEqual({ width: t.width, height: t.height });
        }
        // 文件里有 skin 时：有骨骼
        if (expected && expected.skins.count > 0) {
          expect(card.skinned).toBe(true);
          expect(card.bones).toBeGreaterThan(0);
        }

        // 归一化：默认身高 1.75 m、脚底贴地、水平居中、默认不转（+Z 当正前方）
        expect(card.quarterTurns).toBe(0);
        expect(card.size.height).toBeCloseTo(1.75, 4);
        expect(card.bounds.min[1]).toBeCloseTo(0, 4);
        expect(((card.bounds.min[0] ?? 0) + (card.bounds.max[0] ?? 0)) / 2).toBeCloseTo(0, 4);
        expect(((card.bounds.min[2] ?? 0) + (card.bounds.max[2] ?? 0)) / 2).toBeCloseTo(0, 4);
        await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

        // 转 90°：宽和深互换，仍然贴地居中
        await page.getByRole('button', { name: '向右转 90°' }).click();
        await expect.poll(async () => (await read(page)).import.card?.quarterTurns).toBe(3);
        const turned = (await read(page)).import.card;
        expect(turned?.size.width).toBeCloseTo(card.size.depth, 4);
        expect(turned?.size.depth).toBeCloseTo(card.size.width, 4);
        expect(turned?.bounds.min[1]).toBeCloseTo(0, 4);
        await page.screenshot({ path: testInfo.outputPath(`${name}-turned.png`) });

        if (card.clips.length > 0) {
          // 至少有一个已有片段在播放
          expect(card.preview.clipIndex).not.toBeNull();
          await expect
            .poll(async () => (await read(page)).import.card?.preview.mixerTime ?? 0)
            .toBeGreaterThan(card.preview.mixerTime + 0.2);
          expect((await read(page)).import.card?.preview.playing).toBe(true);
        } else {
          expect(card.plan.sway).toBe(true);
          expect(card.notices).toContain(NO_MOVEMENT_NOTICE);
        }

        // 带位移的片段：勾选“锁定水平位移”后，游戏用的副本里不再有水平位移；取消勾选恢复
        for (const c of card.clips.filter((row) => row.rootMotion.flagged && row.lockAvailable)) {
          await page.getByRole('checkbox', { name: `锁定片段 ${String(c.index)} 的水平位移` }).check();
          await expect.poll(async () => (await read(page)).import.card?.clips[c.index]?.locked).toBe(true);
          const residual = (await read(page)).import.card?.clips[c.index]?.lockedResidual ?? NaN;
          console.log(`  锁定 #${String(c.index)} ${c.name}：位移 ${(c.rootMotion.maxHorizontal ?? 0).toFixed(3)} m → ${residual.toExponential(2)} m`);
          expect(residual).toBeLessThan(1e-4);
          await page.getByRole('checkbox', { name: `锁定片段 ${String(c.index)} 的水平位移` }).uncheck();
          await expect.poll(async () => (await read(page)).import.card?.clips[c.index]?.locked).toBe(false);
        }

        // 设为主角后在关卡里也在动
        await page.getByRole('button', { name: '设为主角' }).click();
        await expect.poll(async () => (await read(page)).player.model).toBe('imported');
        await page.getByRole('button', { name: '关闭' }).click();
        await page.screenshot({ path: testInfo.outputPath(`${name}-player.png`) });
        expect(consoleErrors).toEqual([]);
      });
    }

    // 名册（P4）：soldier 加入名册并设为主角，xingxuan 设为守卫，刷新页面后两者都恢复
    const SOLDIER = 'mw-character-g-armored-soldier.glb';
    const XINGXUAN = 'mw-static-xingxuan.glb';
    if (files.includes(SOLDIER) && files.includes(XINGXUAN)) {
      test('真实资产：名册（soldier 设为主角，xingxuan 设为守卫，刷新后恢复）', async ({ page }, testInfo) => {
        const consoleErrors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
        const ready = async () => {
          await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
          await expect.poll(async () => (await read(page)).roster.restoring, { timeout: 60_000 }).toBe(false);
        };
        const choose = async (name: string) => {
          const chooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: '导入角色' }).click();
          await (await chooser).setFiles(join(assetDir, name));
          await expect.poll(async () => (await read(page)).import.busy, { timeout: 60_000 }).toBe(false);
          expect((await read(page)).import.error).toBeNull();
        };

        // 测试小关 B 有一个守卫
        await page.goto('/?level=test-b');
        await ready();
        await choose(SOLDIER);
        await page.getByRole('button', { name: '设为主角' }).click();
        await expect.poll(async () => (await read(page)).player.model).toBe('imported');
        await choose(XINGXUAN);
        // xingxuan 面向 +X：转 90° 让它面朝 +Z，再加入名册、设为守卫
        await page.getByRole('button', { name: '向右转 90°' }).click();
        await expect.poll(async () => (await read(page)).import.card?.quarterTurns).toBe(3);
        await page.getByRole('button', { name: '加入为新人物' }).click();
        await page.getByRole('combobox', { name: `${XINGXUAN} 的分工` }).selectOption('guard');
        await expect.poll(async () => (await read(page)).roster.saving, { timeout: 30_000 }).toBe(false);
        const before = (await read(page)).roster.entries;
        expect(before.map((e) => [e.fileName, e.role, e.quarterTurns])).toEqual([
          [SOLDIER, 'player', 0],
          [XINGXUAN, 'guard', 3],
        ]);

        await page.reload();
        await ready();
        const after = await read(page);
        expect(after.roster.entries.map((e) => [e.fileName, e.role, e.status, e.quarterTurns])).toEqual([
          [SOLDIER, 'player', 'ready', 0],
          [XINGXUAN, 'guard', 'ready', 3],
        ]);
        after.roster.entries.forEach((entry, i) => {
          const was = before[i];
          expect(entry.size?.width).toBeCloseTo(was?.size?.width ?? NaN, 6);
          expect(entry.size?.height).toBeCloseTo(was?.size?.height ?? NaN, 6);
          expect(entry.size?.depth).toBeCloseTo(was?.size?.depth ?? NaN, 6);
          expect(entry.slots).toEqual(was?.slots);
          console.log(
            `名册恢复 ${String(entry.fileName)}：分工 ${String(entry.roleLabel)}，转 ${String((entry.quarterTurns ?? 0) * 90)}°，` +
              `尺寸 ${(entry.size?.width ?? 0).toFixed(2)} × ${(entry.size?.height ?? 0).toFixed(2)} × ${(entry.size?.depth ?? 0).toFixed(2)} m`,
          );
        });
        const soldierKey = after.roster.entries[0]?.key ?? '';
        const xingxuanKey = after.roster.entries[1]?.key ?? '';
        expect(after.player).toMatchObject({ model: 'imported', personId: soldierKey });
        // 关卡里的守卫换成了 xingxuan；守卫的数量不变
        expect(after.cast.guards).toEqual([{ guardId: 'guard-b', personId: xingxuanKey, model: 'imported' }]);
        expect(after.game.guards).toHaveLength(1);
        expect(after.instances).toBe(2);
        await page.screenshot({ path: testInfo.outputPath('real-roster-restored.png') });
        expect(consoleErrors).toEqual([]);
      });
    }
  });
}

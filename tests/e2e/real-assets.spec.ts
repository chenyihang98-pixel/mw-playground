// 可选的真实资产测试组：读取环境变量 MW_ASSET_DIR 指向的目录（项目外，只读），经文件选择框逐个导入。
// 没设 MW_ASSET_DIR 时整组跳过。真实文件不复制进项目；截图存到 Playwright 的输出目录（不提交）。
// F2 补的三项（目录里有 soldier 时）：soldier 当主角只用键盘赢下测试小关 A；同一个文件同时出两个实例（主角兼守卫）；
// soldier 当主角时导入一个坏文件（soldier 的前 64 KB，只在内存里截取）。

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
        // P6：名册是顶栏“名册”打开的主面板
        await page.getByRole('button', { name: '名册', exact: true }).click();
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

        // P6：两种窗口大小下各截两张：名册里 soldier 和 xingxuan 的卡片（缩略图画好以后），soldier 当主角在关卡里
        // （xingxuan 换下晨光草地的守卫）
        for (const [i, size] of [
          { width: 1280, height: 720 },
          { width: 1920, height: 1080 },
        ].entries()) {
          const tag = `${String(size.width)}x${String(size.height)}`;
          await page.setViewportSize(size);
          if (i > 0) {
            await page.goto('/?level=test-b');
            await ready();
          }
          await page.getByRole('button', { name: '名册', exact: true }).click();
          await expect.poll(async () => (await read(page)).ui.thumbnails.rendered, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
          await expect(page.locator('#roster-list .person-thumb img:not([hidden])')).toHaveCount(2);
          await expect(page.getByRole('textbox', { name: `${SOLDIER} 的显示名` })).toHaveValue(SOLDIER);
          await expect(page.getByRole('textbox', { name: `${XINGXUAN} 的显示名` })).toHaveValue(XINGXUAN);
          await page.screenshot({ path: testInfo.outputPath(`p6-real-${tag}-roster.png`) });
          // 主角在关卡里：换到“晨光草地”（守卫在远处巡逻，不挡镜头）
          await page.goto('/?level=gen-1');
          await ready();
          await page.getByRole('button', { name: '开始', exact: true }).click();
          await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
          await page.keyboard.down('KeyW');
          await page.waitForTimeout(700);
          await page.keyboard.up('KeyW');
          await page.waitForTimeout(400);
          expect((await read(page)).player).toMatchObject({ model: 'imported', personId: soldierKey });
          await page.screenshot({ path: testInfo.outputPath(`p6-real-${tag}-soldier.png`) });
        }
        expect(consoleErrors).toEqual([]);
      });
    }

    // F2：soldier 真的赢下一关；同一个真实文件同时出两个实例；soldier 当主角时导入失败
    if (files.includes(SOLDIER)) {
      /** 控制台错误和页面异常分开记。 */
      const watch = (page: Page) => {
        const log = { consoleErrors: [] as string[], pageErrors: [] as string[] };
        page.on('console', (message) => {
          if (message.type() === 'error') log.consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => log.pageErrors.push(error.message));
        return log;
      };
      const ready = async (page: Page) => {
        await page.waitForFunction(() => (window.__MW_TEST__ as Hooks | undefined)?.kind === 'game');
        await expect.poll(async () => (await read(page)).roster.restoring, { timeout: 60_000 }).toBe(false);
      };
      /** 经文件选择框导入 soldier，并设为主角，等名册保存完。返回它的人物 key。 */
      const soldierAsPlayer = async (page: Page): Promise<string> => {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: '导入角色' }).click();
        await (await chooser).setFiles(join(assetDir, SOLDIER));
        await expect.poll(async () => (await read(page)).import.busy, { timeout: 60_000 }).toBe(false);
        expect((await read(page)).import.error).toBeNull();
        await page.getByRole('button', { name: '设为主角' }).click();
        await expect.poll(async () => (await read(page)).player.model).toBe('imported');
        await expect.poll(async () => (await read(page)).roster.saving, { timeout: 30_000 }).toBe(false);
        const key = (await read(page)).player.personId;
        if (!key) throw new Error('主角应该是名册里的 soldier');
        return key;
      };

      test('真实资产：soldier 当主角，只用键盘赢下测试小关 A', async ({ page }, testInfo) => {
        const log = watch(page);
        await page.goto('/?level=test-a');
        await ready(page);
        const key = await soldierAsPlayer(page);
        const before = await read(page);
        const assetId = before.player.assetId;
        expect(assetId).not.toBeNull();
        const spawn = { x: before.game.player.x, z: before.game.player.z };

        await page.getByRole('button', { name: '开始', exact: true }).click();
        await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
        // 按住 W 一直走到收集点；走的过程中记下主角播放过的片段
        const clips = new Set<number | null>();
        await page.keyboard.down('KeyW');
        try {
          await expect
            .poll(
              async () => {
                const s = await read(page);
                clips.add(s.player.animator?.clipIndex ?? null);
                return s.game.phase;
              },
              { timeout: 20_000, intervals: [50] },
            )
            .toBe('won');
        } finally {
          await page.keyboard.up('KeyW');
        }
        const end = await read(page);
        expect(end.game.phase).toBe('won');
        expect(end.game.result).toMatchObject({ outcome: 'won', reason: 'collected' });
        expect(end.game.collectedCount).toBe(end.game.target);
        const moved = Math.hypot(end.game.player.x - spawn.x, end.game.player.z - spawn.z);
        expect(moved).toBeGreaterThan(0.5);
        expect(end.player).toMatchObject({ model: 'imported', personId: key, assetId });
        // P3 的自动建议：走是 #4
        expect([...clips]).toContain(4);
        console.log(`soldier 赢下测试小关 A：走了 ${moved.toFixed(2)} m，播放过的片段 ${[...clips].map(String).join('、')}`);
        await page.screenshot({ path: testInfo.outputPath('real-soldier-won.png') });
        expect(log.consoleErrors).toEqual([]);
        expect(log.pageErrors).toEqual([]);
      });

      test('真实资产：同一个文件同时出两个实例（soldier 主角兼守卫），骨骼和动画各自独立', async ({ page }, testInfo) => {
        const log = watch(page);
        // 测试小关 B 有 1 个守卫
        await page.goto('/?level=test-b');
        await ready(page);
        const key = await soldierAsPlayer(page);
        await page.getByRole('button', { name: '名册', exact: true }).click();
        await page.getByRole('combobox', { name: `${SOLDIER} 的分工` }).selectOption('playerGuard');
        await expect
          .poll(
            async () => {
              const s = await read(page);
              return !s.roster.saving && s.roster.entries[0]?.role === 'playerGuard' && s.cast.guards[0]?.personId === key;
            },
            { timeout: 30_000 },
          )
          .toBe(true);

        const s = await read(page);
        expect(s.cast.player.personId).toBe(key);
        expect(s.cast.guards[0]?.personId).toBe(key);
        expect(s.instances).toBe(2);
        expect(s.importedInstances.map((i) => [i.slot, i.slotId, i.personId])).toEqual([
          ['player', null, key],
          ['guard', 'guard-b', key],
        ]);
        const [player, guard] = s.importedInstances;
        if (!player || !guard) throw new Error('应该有两个实例');
        expect(player.rootUuid).not.toBe(guard.rootUuid);
        expect(player.boneUuids.length).toBeGreaterThan(0);
        expect(guard.boneUuids).toHaveLength(player.boneUuids.length);
        expect(player.boneUuids.filter((uuid) => guard.boneUuids.includes(uuid))).toEqual([]);

        // 开始后不按任何键：主角待机，守卫在巡逻；两个实例的动画各自在走
        await page.getByRole('button', { name: '开始', exact: true }).click();
        await expect.poll(async () => (await read(page)).game.phase).toBe('playing');
        // 等守卫从待机淡入到走路
        await page.waitForTimeout(400);
        const first = await read(page);
        const t0 = Date.now();
        await page.waitForTimeout(600);
        const second = await read(page);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
        const bySlot = (snap: GameAppSnapshot, slot: 'player' | 'guard') => snap.importedInstances.find((i) => i.slot === slot)?.animator;
        const [p1, p2, g1, g2] = [bySlot(first, 'player'), bySlot(second, 'player'), bySlot(first, 'guard'), bySlot(second, 'guard')];
        console.log(
          `两个实例各 ${String(player.boneUuids.length)} 个骨骼节点，没有相同的 uuid；` +
            `主角实例：片段 ${String(p1?.clipIndex)} → ${String(p2?.clipIndex)}，mixerTime ${String(p1?.mixerTime)} → ${String(p2?.mixerTime)}；` +
            `守卫实例：片段 ${String(g1?.clipIndex)} → ${String(g2?.clipIndex)}，mixerTime ${String(g1?.mixerTime)} → ${String(g2?.mixerTime)}`,
        );
        expect(p2?.mixerTime ?? 0).toBeGreaterThan(p1?.mixerTime ?? Infinity);
        expect(g2?.mixerTime ?? 0).toBeGreaterThan(g1?.mixerTime ?? Infinity);
        expect(p1?.clipIndex).toBe(1);
        expect(p2?.clipIndex).toBe(1);
        expect(g1?.clipIndex).not.toBe(1);
        expect(g2?.clipIndex).not.toBe(1);
        expect(g2?.clipIndex).not.toBeNull();
        // 守卫确实在巡逻路线上移动
        const [ga, gb] = [first.game.guards[0], second.game.guards[0]];
        expect(Math.hypot((gb?.x ?? 0) - (ga?.x ?? 0), (gb?.z ?? 0) - (ga?.z ?? 0))).toBeGreaterThan(0.1);
        await page.screenshot({ path: testInfo.outputPath('real-soldier-two-instances.png') });
        expect(log.consoleErrors).toEqual([]);
        expect(log.pageErrors).toEqual([]);
      });

      test('真实资产：soldier 当主角时导入一个坏文件，主角、名册和实例都不变', async ({ page }) => {
        const log = watch(page);
        await page.goto('/?level=test-a');
        await ready(page);
        const key = await soldierAsPlayer(page);
        const before = await read(page);
        const entries = (snap: GameAppSnapshot) => snap.roster.entries.map((e) => ({ key: e.key, role: e.role, status: e.status }));
        expect(entries(before)).toEqual([{ key, role: 'player', status: 'ready' }]);

        // soldier 文件的前 65,536 个字节：只在内存里截取，不写到磁盘
        const truncated = readFileSync(join(assetDir, SOLDIER)).subarray(0, 65_536);
        await page.locator('#import-file').setInputFiles({ name: 'broken-soldier.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(truncated) });
        await expect.poll(async () => (await read(page)).import.error, { timeout: 30_000 }).not.toBeNull();
        await expect.poll(async () => (await read(page)).import.busy).toBe(false);
        const after = await read(page);
        console.log(`导入 broken-soldier.glb：${String(after.import.error)}`);
        await expect(page.getByRole('alert').filter({ hasText: '导入失败' })).toBeVisible();
        expect(after.player).toMatchObject({ model: 'imported', personId: key });
        expect(after.player.assetId).toBe(before.player.assetId);
        expect(entries(after)).toEqual(entries(before));
        expect(after.instances).toBe(before.instances);
        expect(log.pageErrors).toEqual([]);
      });
    }
  });
}

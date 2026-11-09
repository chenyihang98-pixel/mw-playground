// 关卡工坊浏览器端的状态（P8，第 1 轮审查）：确认的响应回来时，如果预览已经不是当前的（放弃过、开始了新的生成），
// 丢弃这个迟到的响应：不保存、不加载、不覆盖新的界面。正常确认按生成标识只写入一次。用假的 fetch 驱动，不碰 DOM。

import { describe, expect, it } from 'vitest';
import { produceLevel } from '../../src/game/level/gen/pipeline';
import { randomBrief } from '../../src/game/level/gen/randomBrief';
import type { LevelPackage } from '../../src/game/levels/package';
import { packageOfProduced } from '../../src/game/levels/package';
import { WorkshopClient } from '../../src/workshop/client';
import { WorkshopController } from '../../src/workshop/controller';
import type { WireLevel } from '../../src/workshop/protocol';

function wire(seed: string): WireLevel {
  const result = produceLevel(randomBrief(seed), `${seed}-level`);
  if (!result.ok) throw new Error('应该能生成');
  const pkg = packageOfProduced(result.level);
  if (!pkg.brief || pkg.seed === null || pkg.schemaVersion === null || pkg.generatorVersion === null) throw new Error('缺字段');
  return {
    source: 'model',
    title: pkg.title,
    layout: pkg.layout,
    layoutHash: pkg.layoutHash,
    visual: pkg.visual,
    rules: pkg.rules,
    brief: pkg.brief,
    seed: pkg.seed,
    schemaVersion: pkg.schemaVersion,
    generatorVersion: pkg.generatorVersion,
    adjustment: null,
  };
}

const LEVELS: Record<string, WireLevel> = { 'gen-0001': wire('ctl-a'), 'gen-0002': wire('ctl-b'), 'gen-0003': wire('ctl-c') };

const HEALTH = { ok: true, serviceId: 'svc-1', provider: 'fake', model: 'fake-scripted', available: true, reason: null, maxRequestChars: 200, busy: false };

/** 假的服务：生成立刻出预览；确认可以挂起，直到测试放行。 */
function fakeService() {
  const held = new Map<string, () => void>();
  let holdConfirms = false;
  const calls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.split('/').at(-1) ?? '';
    calls.push(path);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { generationId?: string }) : {};
    const id = body.generationId ?? '';
    let reply: unknown = { ok: true };
    if (path === 'health') reply = HEALTH;
    if (path === 'generate') {
      reply = {
        ok: true,
        status: 'preview',
        generationId: id,
        version: 1,
        serviceId: 'svc-1',
        preview: { level: LEVELS[id], outcome: 'model-first', repairs: 0, adjustment: null, differences: [], history: [], provider: 'fake', model: 'fake-scripted' },
      };
    }
    if (path === 'confirm') {
      if (holdConfirms) {
        await new Promise<void>((resolve) => {
          held.set(id, resolve);
        });
      }
      reply = { ok: true, generationId: id, duplicate: false, level: LEVELS[id], provider: 'fake', model: 'fake-scripted' };
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    impl,
    calls,
    held,
    hold: (on: boolean) => {
      holdConfirms = on;
    },
  };
}

function setup() {
  const service = fakeService();
  let n = 0;
  const client = new WorkshopClient(service.impl, '/api/workshop', () => `gen-${String(++n).padStart(4, '0')}`);
  const applied: LevelPackage[] = [];
  const controller = new WorkshopController(
    client,
    {
      applyLevel: (pkg) => {
        applied.push(pkg);
      },
      applyFallback: () => '晨光草地',
    },
    () => undefined,
  );
  return { service, controller, applied };
}

describe('确认', () => {
  it('确认 A 还没回来时放弃、再生成 B：迟到的 A 不保存、不加载，界面保持 B 的预览', async () => {
    const { service, controller, applied } = setup();
    await controller.checkHealth();
    await controller.generate('雨夜', []);
    expect(controller.view).toMatchObject({ kind: 'preview', generationId: 'gen-0001' });
    service.hold(true);
    const confirming = controller.confirm();
    await expect.poll(() => service.held.has('gen-0001')).toBe(true);
    expect(controller.view).toMatchObject({ kind: 'preview', confirming: true });
    expect(controller.discard()).toBe(true);
    await controller.generate('雪夜', []);
    expect(controller.view).toMatchObject({ kind: 'preview', generationId: 'gen-0002' });
    service.held.get('gen-0001')?.();
    await confirming;
    expect(applied).toEqual([]);
    expect(controller.saves).toBe(0);
    expect(controller.view).toMatchObject({ kind: 'preview', generationId: 'gen-0002', confirming: false });
  });

  it('确认 A 还没回来时直接开始新的生成：迟到的 A 同样被丢弃', async () => {
    const { service, controller, applied } = setup();
    await controller.checkHealth();
    await controller.generate('雨夜', []);
    service.hold(true);
    const confirming = controller.confirm();
    await expect.poll(() => service.held.has('gen-0001')).toBe(true);
    await controller.generate('雪夜', []);
    service.held.get('gen-0001')?.();
    await confirming;
    expect(applied).toEqual([]);
    expect(controller.view).toMatchObject({ kind: 'preview', generationId: 'gen-0002' });
  });

  it('正常确认：保存并加载预览的那一份；连续点确认只发一次、只写入一次', async () => {
    const { service, controller, applied } = setup();
    await controller.checkHealth();
    await controller.generate('雨夜', []);
    await Promise.all([controller.confirm(), controller.confirm()]);
    await controller.confirm();
    expect(applied.map((p) => p.layoutHash)).toEqual([LEVELS['gen-0001']?.layoutHash]);
    expect(controller.saves).toBe(1);
    expect(service.calls.filter((c) => c === 'confirm')).toHaveLength(1);
    expect(controller.view).toMatchObject({ kind: 'saved', generationId: 'gen-0001' });
  });
});

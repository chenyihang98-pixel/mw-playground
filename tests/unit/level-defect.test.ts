// 生成器做出了本不该做出的布局（例如巡逻路线穿墙）是程序缺陷：检查器判为失败，流程直接返回 rejected，
// 不用别的子种子重试把它掩盖掉。这里把生成器替换成一个会做出穿墙路线的版本。

import { describe, expect, it, vi } from 'vitest';
import { handmade } from '../helpers/levels';

const calls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../src/game/level/gen/generator', () => ({
  generateLayout: () => {
    calls.count++;
    return {
      ok: true,
      layout: handmade({
        size: { width: 24, depth: 24 },
        boxes: [{ id: 'wall', center: { x: 0, z: 3 }, size: { x: 6, z: 0.6 }, height: 2 }],
        collectibles: [
          { id: 'gem-1', position: { x: 8, z: 8 } },
          { id: 'gem-2', position: { x: -8, z: 8 } },
        ],
        guards: [{ id: 'guard-1', route: [{ x: 0, z: 1 }, { x: 0, z: 5 }] }],
        spawn: { x: 0, z: -10, yaw: 0 },
        target: 2,
      }),
    };
  },
}));

const { produceLevel } = await import('../../src/game/level/gen/pipeline');
const { brief } = await import('../helpers/levels');

describe('程序缺陷不靠重试掩盖', () => {
  it('巡逻路线穿墙：检查器判为失败，第一次尝试后就返回 rejected，并带上具体原因', () => {
    calls.count = 0;
    const result = produceLevel(brief({ tier: 'small', collectibles: 2, guards: 1, platforms: 0 }), 'defect');
    expect(result).toMatchObject({ ok: false, kind: 'rejected', attempts: 1 });
    expect(calls.count).toBe(1);
    if (!result.ok && result.kind === 'rejected') {
      expect(result.problems).toContainEqual({ category: 'layout', code: 'patrol', message: '守卫 guard-1 的第 0 段路线穿过 wall（不在地面上）' });
    }
  });
});

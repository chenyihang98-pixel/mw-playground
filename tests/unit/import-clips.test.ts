// 片段：loop 的四种情况（false 和缺失不混淆）、同名和无名（按序号标识）、用途识别和建议、手动覆盖、兜底。

import { describe, expect, it } from 'vitest';
import { GltfBuilder } from '../../src/asset/fixtures';
import {
  NO_MOVEMENT_NOTICE,
  decideClips,
  planAnimations,
  recognizePurpose,
  type ClipFacts,
  type Slots,
} from '../../src/import/clipRules';
import { SPEC } from '../../src/game/spec';
import { importFixture, importGlb, triangleMesh } from '../helpers/import';

describe('播放方式：读 clip.userData.loop', () => {
  it('true / 缺失：skinned-humanoid 的 idle、walk 明确循环，run 的 loop 缺失按用途推断为循环', async () => {
    const asset = await importFixture('skinned-humanoid');
    const views = asset.clipViews();
    expect(views.map((v) => [v.name, v.loopRaw, v.decision.playback, v.decision.playbackSource])).toEqual([
      ['idle', 'true', 'loop', 'explicit'],
      ['walk', 'true', 'loop', 'explicit'],
      ['run', 'missing', 'loop', 'inferred'],
    ]);
  });

  it('false：明确只播一次', async () => {
    const [wave] = (await importFixture('loop-false')).clipViews();
    expect([wave?.loopRaw, wave?.decision.playback, wave?.decision.playbackSource]).toEqual(['false', 'once', 'explicit']);
  });

  it('非布尔值（字符串 "yes"）和 extras 不是对象：都算未知，按用途推断，标“推断”', async () => {
    const [dance] = (await importFixture('loop-string')).clipViews();
    expect([dance?.loopRaw, dance?.decision.purpose, dance?.decision.playback, dance?.decision.playbackSource]).toEqual([
      'other',
      'other',
      'once',
      'inferred',
    ]);
    const [jump] = (await importFixture('extras-number')).clipViews();
    expect([jump?.loopRaw, jump?.decision.purpose, jump?.decision.playback, jump?.decision.playbackSource]).toEqual([
      'missing',
      'jump',
      'once',
      'inferred',
    ]);
  });

  it('false 和缺失不混为一谈：同为待机，false 只播一次（明确），缺失推断为循环', async () => {
    const b = new GltfBuilder();
    const node = b.addNode({ name: 'N', mesh: triangleMesh(b) });
    b.addScene([node]);
    const channels = [{ node, path: 'scale' as const, times: [0, 1], values: [1, 1, 1, 1.2, 1.2, 1.2] }];
    b.addAnimation({ name: 'idle', extras: { designed: true, loop: false }, channels });
    b.addAnimation({ name: 'idle', extras: { designed: true }, channels });
    const [explicitFalse, missing] = (await importGlb(b.toGlb())).clipViews();
    expect([explicitFalse?.loopRaw, explicitFalse?.decision.playback, explicitFalse?.decision.playbackSource]).toEqual(['false', 'once', 'explicit']);
    expect([missing?.loopRaw, missing?.decision.playback, missing?.decision.playbackSource]).toEqual(['missing', 'loop', 'inferred']);
  });
});

describe('标识：文件 SHA-256 + 序号；名字只用来显示', () => {
  it('同名片段靠序号区分', async () => {
    const asset = await importFixture('duplicate-names');
    const views = asset.clipViews();
    expect(views.map((v) => v.name)).toEqual(['idle', 'idle', 'walk']);
    expect(asset.id).toMatch(/^[0-9a-f]{64}$/);
    expect(views.map((v) => v.key)).toEqual([`${asset.id}#0`, `${asset.id}#1`, `${asset.id}#2`]);
    // 手动改的是序号 1，不影响同名的序号 0
    asset.setPlayback(1, 'loop');
    expect(asset.clipViews().map((v) => v.decision.playbackSource)).toEqual(['explicit', 'manual', 'explicit']);
  });

  it('无名片段显示为 animation_<序号>', async () => {
    const views = (await importFixture('unnamed-clips')).clipViews();
    expect(views.map((v) => v.name)).toEqual(['named', 'animation_1', 'animation_2']);
  });

  it('同样的内容得到同样的标识', async () => {
    const a = await importFixture('loop-false');
    const b = await importFixture('loop-false');
    expect(a.key(0)).toBe(b.key(0));
  });
});

describe('用途识别', () => {
  it.each([
    ['Idle', 'idle'],
    ['IDLE_breath', 'idle'],
    ['Standing', 'idle'],
    ['待机', 'idle'],
    ['walk', 'walk'],
    ['Walking', 'walk'],
    ['行走', 'walk'],
    ['慢走', 'walk'],
    ['RUN', 'run'],
    ['Sprint', 'run'],
    ['jog_fast', 'run'],
    ['奔跑', 'run'],
    ['跑步', 'run'],
    ['JumpUp', 'jump'],
    ['跳跃', 'jump'],
    ['Grunt', 'other'],
    ['wave', 'other'],
    ['animation_3', 'other'],
  ])('%s → %s', (name, purpose) => {
    expect(recognizePurpose(name)).toBe(purpose);
  });

  it('真实资产（armored-soldier）的片段名', () => {
    const expected: [string, string][] = [
      ['GCustomArm', 'other'],
      ['mixamo soldier Idle', 'idle'],
      ['mixamo soldier Walk', 'walk'],
      ['mixamo soldier Run', 'run'],
      ['mixamo soldier TPose', 'other'],
      ['X Bot@Rifle Idle', 'idle'],
      ['X Bot@Rifle Aiming Idle', 'other'],
      ['X Bot@Rifle Walk', 'walk'],
      ['X Bot@Rifle Run', 'run'],
      ['X Bot@Rifle Jump', 'jump'],
      ['X Bot@Firing Rifle', 'other'],
      ['X Bot@Reloading', 'other'],
    ];
    for (const [name, purpose] of expected) expect([name, recognizePurpose(name)]).toEqual([name, purpose]);
  });
});

/** 按 P1 真实检查的结果构造的 armored-soldier 片段事实。 */
function soldierFacts(): ClipFacts[] {
  const rows: [string, number, 'true' | 'false'][] = [
    ['GCustomArm', 1.6, 'true'],
    ['mixamo soldier Idle', 1.97, 'true'],
    ['mixamo soldier Walk', 1.03, 'true'],
    ['mixamo soldier Run', 0.7, 'true'],
    ['mixamo soldier TPose', 0.033, 'true'],
    ['X Bot@Rifle Idle', 8.57, 'true'],
    ['X Bot@Rifle Aiming Idle', 3.1, 'true'],
    ['X Bot@Rifle Walk', 1.3, 'true'],
    ['X Bot@Rifle Run', 0.73, 'true'],
    ['X Bot@Rifle Jump', 0.6, 'false'],
    ['X Bot@Firing Rifle', 0.27, 'false'],
    ['X Bot@Reloading', 3.3, 'false'],
  ];
  return rows.map(([name, duration, loop], index) => ({
    index,
    name,
    duration,
    keyframes: duration < 0.05 ? 1 : 30,
    loopRaw: loop,
    loopValue: loop === 'true',
    rootMotionActive: false,
  }));
}

describe('建议和手动覆盖', () => {
  it('两套 Idle / Walk / Run：按规则各选一个（序号最小），其余可以手动选；TPose 不当待机', () => {
    const { clips, slots } = decideClips(soldierFacts());
    expect(slots).toEqual({ idle: 1, walk: 2, run: 3, jump: 9 });
    expect(clips[4]?.purpose).toBe('other'); // TPose
    expect(clips[5]?.slot).toBeNull(); // Rifle Idle：候选
    expect(clips[5]?.notes.join()).toContain('建议使用 #1');
    expect([0, 6, 10, 11].map((i) => clips[i]?.purpose)).toEqual(['other', 'other', 'other', 'other']);
  });

  it('只有一帧的片段即使名字是待机、loop=true，也不作为待机的自动建议', () => {
    const facts: ClipFacts[] = [
      { index: 0, name: 'Idle Pose', duration: 0.033, keyframes: 1, loopRaw: 'true', loopValue: true, rootMotionActive: false },
    ];
    const { slots, clips } = decideClips(facts);
    expect(slots.idle).toBeNull();
    expect(clips[0]?.recognized).toBe('idle');
    expect(clips[0]?.notes.join()).toContain('时长极短');
  });

  it('带位移的片段默认不作为移动动作的建议', () => {
    const facts = soldierFacts().map((f) => (f.index === 2 ? { ...f, rootMotionActive: true } : f));
    expect(decideClips(facts).slots.walk).toBe(7);
  });

  it('优先 loop 明确为 true 的候选，再按序号', () => {
    const facts = soldierFacts().map((f) => (f.index === 1 ? { ...f, loopRaw: 'missing' as const } : f));
    expect(decideClips(facts).slots.idle).toBe(5);
  });

  it('手动用途覆盖自动建议；用途和播放方式分开保存', () => {
    const purpose = new Map([[5, 'idle' as const]]);
    const playback = new Map([[5, 'once' as const]]);
    const { clips, slots } = decideClips(soldierFacts(), { purpose, playback });
    expect(slots.idle).toBe(5);
    expect(clips[5]?.purposeSource).toBe('manual');
    expect(clips[5]?.playback).toBe('once');
    expect(clips[5]?.playbackSource).toBe('manual');
    expect(clips[1]?.notes.join()).toContain('已被手动选择覆盖');
    // 只改播放方式，不改用途
    const onlyPlayback = decideClips(soldierFacts(), { purpose: new Map(), playback: new Map([[2, 'once' as const]]) });
    expect(onlyPlayback.slots.walk).toBe(2);
    expect(onlyPlayback.clips[2]?.purposeSource).toBe('auto');
    expect(onlyPlayback.clips[2]?.playback).toBe('once');
    // 手动改成“其他”：这个槽位换下一个候选
    const demoted = decideClips(soldierFacts(), { purpose: new Map([[3, 'other' as const]]), playback: new Map() });
    expect(demoted.slots.run).toBe(8);
  });

  it('资产上的手动覆盖按序号保存，改用途会让推断的播放方式跟着变', async () => {
    const asset = await importFixture('loop-string'); // dance：其他，loop 非布尔 → 推断只播一次
    expect(asset.clipViews()[0]?.decision.playback).toBe('once');
    asset.setPurpose(0, 'walk');
    const view = asset.clipViews()[0];
    expect([view?.decision.purpose, view?.decision.playback, view?.decision.playbackSource]).toEqual(['walk', 'loop', 'inferred']);
    expect(asset.decisions().slots.walk).toBe(0);
    asset.setPurpose(0, null);
    expect(asset.decisions().slots.walk).toBeNull();
  });
});

describe('兜底', () => {
  const speeds = SPEC.move;
  const slots = (s: Partial<Slots>): Slots => ({ idle: null, walk: null, run: null, jump: null, ...s });

  it('什么都有：直接用', () => {
    const plan = planAnimations(slots({ idle: 0, walk: 1, run: 2, jump: 3 }), speeds);
    expect(plan.idle).toEqual({ kind: 'clip', index: 0, timeScale: 1 });
    expect(plan.walk).toEqual({ kind: 'clip', index: 1, timeScale: 1 });
    expect(plan.run).toEqual({ kind: 'clip', index: 2, timeScale: 1 });
    expect(plan.jump).toEqual({ kind: 'clip', index: 3, timeScale: 1 });
    expect(plan.sway).toBe(false);
    expect(plan.notices).toEqual([]);
  });

  it('没有走：用跑，放慢播放', () => {
    const plan = planAnimations(slots({ idle: 0, run: 2 }), speeds);
    expect(plan.walk).toEqual({ kind: 'clip', index: 2, timeScale: speeds.walkSpeed / speeds.runSpeed });
    expect(plan.notices.join()).toContain('用“跑”的片段放慢播放');
  });

  it('没有跑：用走，加快播放', () => {
    const plan = planAnimations(slots({ idle: 0, walk: 1 }), speeds);
    expect(plan.run).toEqual({ kind: 'clip', index: 1, timeScale: speeds.runSpeed / speeds.walkSpeed });
    expect(plan.notices.join()).toContain('用“走”的片段加快播放');
  });

  it('没有待机：用走的第一帧静止', () => {
    expect(planAnimations(slots({ walk: 1, run: 2 }), speeds).idle).toEqual({ kind: 'firstFrame', index: 1 });
    // 走由跑放慢得到时，用跑的第一帧
    expect(planAnimations(slots({ run: 2 }), speeds).idle).toEqual({ kind: 'firstFrame', index: 2 });
  });

  it('没有待机也没有走：用绑定姿态；没有移动动作：整体摆动', () => {
    const plan = planAnimations(slots({}), speeds);
    expect(plan.idle).toEqual({ kind: 'bindPose' });
    expect(plan.walk).toEqual({ kind: 'sway' });
    expect(plan.run).toEqual({ kind: 'sway' });
    expect(plan.sway).toBe(true);
    expect(plan.notices).toContain(NO_MOVEMENT_NOTICE);
    expect(plan.notices.join()).not.toContain('步态');
  });

  it('只有待机：待机照常播放，移动时整体摆动', () => {
    const plan = planAnimations(slots({ idle: 0 }), speeds);
    expect(plan.idle).toEqual({ kind: 'clip', index: 0, timeScale: 1 });
    expect(plan.sway).toBe(true);
  });

  it('静态模型和只有非移动节点动画的模型：整体摆动', async () => {
    expect((await importFixture('static-mesh')).decisions().plan.sway).toBe(true);
    const nodeAnim = await importFixture('loop-false'); // 只有 wave（其他）
    expect(nodeAnim.decisions().plan.sway).toBe(true);
    expect(nodeAnim.decisions().plan.notices).toContain(NO_MOVEMENT_NOTICE);
    expect((await importFixture('skinned-humanoid')).decisions().plan.sway).toBe(false);
  });
});

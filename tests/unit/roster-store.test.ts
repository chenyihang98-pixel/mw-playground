// 名册的存储（P4）：读写、版本号、认不出的版本和损坏的记录被跳过、存储抛错时名册在内存里照常可用。
// 存储用内存实现；IndexedDB 本身的读写在端到端测试里验证。

import { describe, expect, it } from 'vitest';
import { RECORD_FORMAT, RECORD_VERSION, decodeRecord, encodeRecord, type PersonRecord } from '../../src/roster/format';
import { Roster } from '../../src/roster/roster';
import { MemoryRosterStore } from '../../src/roster/store';
import { addOrThrow, distinctGlb, importForRoster } from '../helpers/roster';

const SHA = 'a'.repeat(64);

function sampleRecord(overrides: Partial<PersonRecord> = {}): PersonRecord {
  return {
    id: SHA,
    sha256: SHA,
    fileName: 'hero.glb',
    displayName: '英雄',
    order: 0,
    role: 'guard',
    settings: {
      displayHeight: 2,
      quarterTurns: 1,
      purposes: { [`${SHA}#0`]: 'walk' },
      playbacks: { [`${SHA}#1`]: 'once' },
      lockedMotion: [`${SHA}#2`],
    },
    file: new Blob([new Uint8Array([1, 2, 3])]),
    ...overrides,
  };
}

describe('存储格式', () => {
  it('写进去的记录带格式名和版本号，读回来和原来一样', () => {
    const record = sampleRecord();
    const encoded = encodeRecord(record);
    expect(encoded.format).toBe(RECORD_FORMAT);
    expect(encoded.version).toBe(RECORD_VERSION);
    expect(RECORD_VERSION).toBe(1);
    const decoded = decodeRecord(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.record).toEqual(record);
  });

  it('认不出的版本：不抛异常，返回原因', () => {
    const decoded = decodeRecord({ ...encodeRecord(sampleRecord()), version: 2 });
    expect(decoded).toEqual({ ok: false, reason: 'version', message: '认不出的存储版本（2），本版只认版本 1' });
    expect(decodeRecord({ ...encodeRecord(sampleRecord()), version: undefined })).toMatchObject({ ok: false, reason: 'version' });
  });

  it('损坏的记录：不抛异常，返回原因', () => {
    const encoded = encodeRecord(sampleRecord());
    const cases: unknown[] = [
      null,
      'text',
      42,
      { ...encoded, format: 'other' },
      { ...encoded, file: 'not a blob' },
      { ...encoded, role: 'boss' },
      { ...encoded, sha256: 'b'.repeat(64) }, // id 与 sha256 不一致
      { ...encoded, settings: { ...(encoded.settings as object), quarterTurns: 7 } },
      { ...encoded, settings: { ...(encoded.settings as object), purposes: { [`${'b'.repeat(64)}#0`]: 'walk' } } }, // 别的文件的片段键
      { ...encoded, settings: { ...(encoded.settings as object), purposes: { [`${SHA}#x`]: 'walk' } } },
      { ...encoded, displayName: '' },
      { ...encoded, extra: true },
    ];
    for (const value of cases) {
      const decoded = decodeRecord(value);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) {
        expect(decoded.reason).toBe('corrupt');
        expect(decoded.message).toMatch(/^记录损坏/);
      }
    }
  });
});

describe('名册的读写', () => {
  it('加入、改名、设分工、改设置都写进存储；删除时从存储里删除', async () => {
    const store = new MemoryRosterStore();
    const roster = new Roster(store);
    const person = await importForRoster('one.glb', distinctGlb(1));
    const key = addOrThrow(roster, person);
    await roster.whenIdle();
    expect([...store.data.keys()]).toEqual([key]);
    expect(decodeRecord(store.data.get(key))).toMatchObject({ ok: true, record: { displayName: 'one.glb', role: 'none', order: 0 } });

    roster.rename(key, '一号');
    roster.setRole(key, 'guard');
    person.asset.setDisplayHeight(2.1);
    person.asset.rotateQuarter(1);
    await roster.whenIdle();
    const saved = decodeRecord(store.data.get(key));
    expect(saved).toMatchObject({ ok: true, record: { displayName: '一号', role: 'guard', settings: { displayHeight: 2.1, quarterTurns: 1 } } });
    if (saved.ok) expect(new Uint8Array(await saved.record.file.arrayBuffer())).toEqual(person.bytes);

    await roster.remove(key);
    expect(store.data.size).toBe(0);
    expect(person.asset.isDisposed).toBe(true);
  });

  it('认不出的版本和损坏的记录被跳过并提示，其余照常恢复；跳过的项留在存储里，可以删除', async () => {
    const store = new MemoryRosterStore();
    const first = new Roster(store);
    const good = await importForRoster('good.glb', distinctGlb(2));
    const goodKey = addOrThrow(first, good);
    await first.whenIdle();
    store.data.set('future', { ...encodeRecord(sampleRecord({ id: 'c'.repeat(64), sha256: 'c'.repeat(64) })), version: 99 });
    store.data.set('broken', { format: RECORD_FORMAT, version: 1, id: 'broken' });
    store.data.set('d'.repeat(64), encodeRecord(sampleRecord())); // 键和记录里的 id 不一致

    const restored = new Roster(store);
    await restored.restore();
    const snap = restored.snapshot();
    expect(snap.entries.map((e) => [e.key, e.status])).toEqual([
      [goodKey, 'ready'],
      ['future', 'failed'],
      ['broken', 'failed'],
      ['d'.repeat(64), 'failed'],
    ]);
    expect(snap.entries[1]?.error).toContain('认不出的存储版本（99）');
    expect(snap.entries[2]?.error).toMatch(/^记录损坏/);
    expect(snap.entries[3]?.error).toContain('键与记录里的 id 不一致');
    expect(snap.notices.filter((n) => n.includes('已跳过'))).toHaveLength(3);
    // 跳过的项不能设分工，但可以删除
    expect(restored.setRole('future', 'guard')).toEqual({ ok: false, error: '名册里没有这一项' });
    await restored.remove('future');
    await restored.remove('broken');
    expect([...store.data.keys()].sort()).toEqual([goodKey, 'd'.repeat(64)].sort());
  });
});

describe('存储抛错', () => {
  it('读不了：给出提示，名册在内存里照常可用（加入、设分工、改名），只是不保存', async () => {
    const store = new MemoryRosterStore();
    store.failures = { load: new Error('浏览器禁止'), put: new Error('浏览器禁止'), delete: new Error('浏览器禁止') };
    const roster = new Roster(store);
    await roster.restore();
    expect(roster.snapshot().storage.ok).toBe(false);
    expect(roster.snapshot().storage.problem).toContain('读不了浏览器里保存的名册（浏览器禁止）');

    const person = await importForRoster('p.glb', distinctGlb(3));
    const key = addOrThrow(roster, person);
    expect(roster.setRole(key, 'player')).toEqual({ ok: true });
    expect(roster.rename(key, '主角')).toEqual({ ok: true });
    await roster.whenIdle();
    expect(store.data.size).toBe(0);
    expect(roster.members()).toEqual([{ id: key, name: '主角', role: 'player', available: true }]);
    expect(roster.snapshot().storage.problem).toContain('没有保存');
    await roster.remove(key);
    expect(roster.size).toBe(0);
  });

  it('配额不够（QuotaExceededError）：提示“存储空间不够”；之后保存成功就清掉提示', async () => {
    const store = new MemoryRosterStore();
    const quota = new Error('quota');
    quota.name = 'QuotaExceededError';
    store.failures = { put: quota };
    const roster = new Roster(store);
    const person = await importForRoster('q.glb', distinctGlb(4));
    const key = addOrThrow(roster, person);
    await roster.whenIdle();
    expect(roster.snapshot().storage.problem).toContain('存储空间不够');
    store.failures = {};
    roster.rename(key, '再试');
    await roster.whenIdle();
    expect(roster.snapshot().storage.ok).toBe(true);
    expect(decodeRecord(store.data.get(key))).toMatchObject({ ok: true, record: { displayName: '再试' } });
  });
});

// 名册的存储格式（带版本号）。每个人物一条记录，键是文件内容的 SHA-256。
// 只保存原文件和设置，不保存加载后的对象或归一化结果：恢复时把原文件重新走一遍 importModel，再套上设置。
//
// 版本 1 的记录：
//   format: 'mw-roster-person'，version: 1
//   id / sha256：文件内容的 SHA-256（十六进制，两者相同）
//   fileName：原文件名；displayName：显示名（默认是文件名）；order：加入的先后（名册列表按它排序）
//   role：分工（player / guard / playerGuard / companion / none）
//   settings：displayHeight（显示身高，米）、quarterTurns（转了几个 90°）、
//             purposes / playbacks（片段用途、播放方式的手动选择，键是“SHA-256#片段序号”）、
//             lockedMotion（锁定了水平位移的片段，“SHA-256#片段序号”）
//   file：原文件内容（Blob）
// 读到认不出的版本或损坏的记录时不抛异常，返回原因，由名册跳过那一项并提示。

import { z } from 'zod';
import { PURPOSES, type Playback, type Purpose } from '../import/clipRules';
import { ROLES, ROSTER_LIMITS, type Role } from './config';
import { t } from '../i18n';

export const RECORD_FORMAT = 'mw-roster-person';
export const RECORD_VERSION = 1;

export interface PersonSettings {
  readonly displayHeight: number;
  readonly quarterTurns: number;
  /** 片段用途的手动选择，键是“SHA-256#片段序号”。 */
  readonly purposes: Readonly<Record<string, Purpose>>;
  /** 播放方式的手动选择，键是“SHA-256#片段序号”。 */
  readonly playbacks: Readonly<Record<string, Playback>>;
  /** 锁定了水平位移的片段（“SHA-256#片段序号”）。 */
  readonly lockedMotion: readonly string[];
}

export interface PersonRecord {
  readonly id: string;
  readonly sha256: string;
  readonly fileName: string;
  readonly displayName: string;
  readonly order: number;
  readonly role: Role;
  readonly settings: PersonSettings;
  readonly file: Blob;
}

const sha = z.string().regex(/^[0-9a-f]{64}$/, t('format.notSha'));
const clipKeyPattern = /^([0-9a-f]{64})#(0|[1-9][0-9]*)$/;
const clipKeyString = z.string().regex(clipKeyPattern, t('format.clipKeyFormat'));

const settingsSchema = z.strictObject({
  displayHeight: z.number(),
  quarterTurns: z.number().int().min(0).max(3),
  purposes: z.record(clipKeyString, z.enum(PURPOSES)),
  playbacks: z.record(clipKeyString, z.enum(['loop', 'once'])),
  lockedMotion: z.array(clipKeyString),
});

const recordSchema = z
  .strictObject({
    format: z.literal(RECORD_FORMAT),
    version: z.literal(RECORD_VERSION),
    id: sha,
    sha256: sha,
    fileName: z.string().min(1),
    displayName: z.string().min(1).max(ROSTER_LIMITS.maxNameLength),
    order: z.number().int().nonnegative(),
    role: z.enum(ROLES),
    settings: settingsSchema,
    file: z.instanceof(Blob),
  })
  .superRefine((record, ctx) => {
    if (record.id !== record.sha256) ctx.addIssue({ code: 'custom', path: ['id'], message: t('format.idMismatch') });
    const keys = [...Object.keys(record.settings.purposes), ...Object.keys(record.settings.playbacks), ...record.settings.lockedMotion];
    for (const key of keys) {
      if (!key.startsWith(`${record.sha256}#`)) ctx.addIssue({ code: 'custom', path: ['settings'], message: t('format.clipKeyForeign', { key }) });
    }
  });

/** 写进存储的值。 */
export function encodeRecord(record: PersonRecord): Record<string, unknown> {
  return {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    id: record.id,
    sha256: record.sha256,
    fileName: record.fileName,
    displayName: record.displayName,
    order: record.order,
    role: record.role,
    settings: {
      displayHeight: record.settings.displayHeight,
      quarterTurns: record.settings.quarterTurns,
      purposes: { ...record.settings.purposes },
      playbacks: { ...record.settings.playbacks },
      lockedMotion: [...record.settings.lockedMotion],
    },
    file: record.file,
  };
}

export type DecodeResult =
  | { readonly ok: true; readonly record: PersonRecord }
  | { readonly ok: false; readonly reason: 'version' | 'corrupt'; readonly message: string };

/** 从存储里读出的值还原记录。认不出的版本、损坏的记录返回原因，不抛异常。 */
export function decodeRecord(value: unknown): DecodeResult {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'corrupt', message: t('format.notObject') };
  const raw = value as { format?: unknown; version?: unknown };
  if (raw.format !== RECORD_FORMAT) return { ok: false, reason: 'corrupt', message: t('format.notRosterRecord') };
  if (raw.version !== RECORD_VERSION) {
    const shown = typeof raw.version === 'number' || typeof raw.version === 'string' ? String(raw.version) : t('format.missing');
    return { ok: false, reason: 'version', message: t('format.unknownVersion', { shown, version: String(RECORD_VERSION) }) };
  }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? `${first.path.map(String).join('.')}${first.path.length > 0 ? '：' : ''}${first.message}` : t('format.badFormat');
    return { ok: false, reason: 'corrupt', message: t('format.corrupt', { where }) };
  }
  const r = parsed.data;
  return {
    ok: true,
    record: {
      id: r.id,
      sha256: r.sha256,
      fileName: r.fileName,
      displayName: r.displayName,
      order: r.order,
      role: r.role,
      settings: r.settings,
      file: r.file,
    },
  };
}

/** “SHA-256#序号”里的序号；不属于这个文件或格式不对时返回 null。 */
export function clipIndexOf(key: string, sha256: string): number | null {
  const match = clipKeyPattern.exec(key);
  if (match?.[1] !== sha256) return null;
  return Number(match[2]);
}

// 源码扫描（F6）：浏览器端源码（src 下）去掉注释后，除了中文词典和下面的白名单，不再有含汉字或假名的字符串字面量。
// 白名单逐项写理由；白名单里的每一项都要真的用到（不留过期的项）。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const CJK = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;

/** 整个文件或整个目录都不翻译。 */
const WHOLE: readonly { readonly path: string; readonly reason: string }[] = [
  { path: 'src/i18n/messages/zh.ts', reason: '中文词典：界面固定文字的原文' },
  { path: 'src/i18n/messages/ja.ts', reason: '日语词典：日语的译文（假名和日文汉字）' },
  { path: 'src/dev/', reason: '开发工具（夹具预览、测试钩子、开发用关卡），只在开发和测试模式下存在，任务要求保持中文' },
  { path: 'src/asset/fixtures/', reason: '测试夹具：代码生成的 GLB（节点名、片段名）和夹具预览页的说明，只用于测试和开发工具' },
  {
    path: 'src/asset/inspect/',
    reason:
      'GLB 结构检查模块，命令行工具 inspect-asset 也用它（命令行保持中文）。浏览器只用到它的错误，由 src/import/precheck.ts 按错误码翻译（中文界面照旧显示原文）',
  },
  { path: 'src/workshop/diff.ts', reason: '只在工坊服务端用：预览和回退里的差别说明由服务端写好，浏览器原样显示（标了 data-i18n-raw，F6 报告里列出）' },
  { path: 'src/game/level/builtin.ts', reason: 'P2 手工地图的布局数据（名字是数据的一部分，不改）；界面上的名字按 id 查 src/game/levels/titles.ts 的翻译表' },
  { path: 'src/game/level/generatedLevels.ts', reason: 'P5 冻结的生成关卡（布局、种子、说明书原样保存，不改）；界面上的名字和开场白按 id 查翻译表' },
  { path: 'src/game/spec.ts', reason: '玩法规格的自检说明（specProblems），只在单元测试里用，不显示在界面上' },
];

/** 单个字面量不翻译：按文件和字面量里的文字认（exact 为 true 时整个字面量必须完全等于其中一项，否则包含即可）。 */
const LITERALS: readonly { readonly file: string; readonly contains: readonly string[]; readonly exact?: boolean; readonly reason: string }[] = [
  { file: 'src/i18n/lang.ts', contains: ['中文', '日本語'], exact: true, reason: '语言选择的选项固定写成各自语言的名字（“中文 / 日本語 / English”），任务要求如此' },
  {
    file: 'src/import/clipRules.ts',
    contains: ['瞄准', '射击', '开火', '换弹', '装弹', '攻击', '受击', '死亡', '跳舞', '跳', '奔跑', '跑', '行走', '走', '待机', '站立'],
    exact: true,
    reason: '识别片段用途的中文关键词，用来匹配文件里的片段名（中文命名的片段），不是界面文字',
  },
  { file: 'src/import/bindPose.ts', contains: ['绑定姿态'], exact: true, reason: '“绑定姿态”兜底片段的内部名字（AnimationClip.name），界面上不显示它' },
  { file: 'src/game/render/environment.ts', contains: ['地平线以下在近处保持地平线的颜色'], reason: '天空着色器源码（GLSL）里的注释，不是界面文字' },
  { file: 'src/game/boot.ts', contains: ['未知关卡', '默认关卡'], reason: '开发用 ?level= 参数写错时的控制台警告，以及默认关卡缺失的内部断言，不显示在界面上' },
  { file: 'src/main.ts', contains: ['页面里缺少 #scene 画布'], reason: '页面骨架缺失时的启动错误（界面还没建起来），面向开发者' },
  { file: 'src/game/levels/catalog.ts', contains: ['回退关卡'], reason: '内部断言：回退关卡的数据缺失（程序错误），不会在正常运行中出现' },
  { file: 'src/import/asset.ts', contains: ['资产已经释放'], reason: '内部断言：对已释放的资产创建实例（程序错误），不会在正常运行中出现' },
  { file: 'src/game/level/gen/random.ts', contains: ['不能从空列表里选'], reason: '内部断言：随机数从空列表里选（程序错误）' },
  { file: 'src/game/level/gen/randomBrief.ts', contains: ['随机说明书不合法'], reason: '内部断言：随机说明书没通过校验（程序错误，会直接暴露出来）' },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** 含汉字或假名的字符串字面量和模板字面量（注释不是字面量，自然不算）。 */
function cjkLiterals(path: string): Hit[] {
  const file = relative(ROOT, path).replace(/\\/g, '/');
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('${}');
    if (text !== null && CJK.test(text)) hits.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('源码扫描：浏览器端源码里的汉字和假名', () => {
  const hits = sourceFiles(join(ROOT, 'src')).flatMap(cjkLiterals);

  it('除了中文词典和白名单，没有含汉字或假名的字符串字面量', () => {
    const left = hits.filter((h) => {
      if (WHOLE.some((w) => (w.path.endsWith('/') ? h.file.startsWith(w.path) : h.file === w.path))) return false;
      const rule = LITERALS.find((l) => l.file === h.file);
      return !rule?.contains.some((c) => (rule.exact ? h.text === c : h.text.includes(c)));
    });
    expect(left.map((h) => `${h.file}:${String(h.line)} ${h.text.slice(0, 60)}`)).toEqual([]);
  });

  it('白名单的每一项都有理由，并且都用到了（不留过期的项）', () => {
    for (const w of WHOLE) {
      expect(w.reason.length, w.path).toBeGreaterThan(10);
      expect(
        hits.some((h) => (w.path.endsWith('/') ? h.file.startsWith(w.path) : h.file === w.path)),
        w.path,
      ).toBe(true);
    }
    for (const l of LITERALS) {
      expect(l.reason.length, l.file).toBeGreaterThan(10);
      for (const c of l.contains) expect(hits.some((h) => h.file === l.file && (l.exact ? h.text === c : h.text.includes(c))), `${l.file} ${c}`).toBe(true);
    }
  });

  it('英语词典本身没有含汉字或假名的字面量（ja、zh 词典在白名单里）', () => {
    expect(hits.filter((h) => h.file === 'src/i18n/messages/en.ts')).toEqual([]);
  });
});

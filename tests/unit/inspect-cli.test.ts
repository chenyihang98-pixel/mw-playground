// 命令行：先把夹具写到系统临时目录，再对它运行 inspect-asset，检查退出码和输出。

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, type FixtureId } from '../../src/asset/fixtures';
import { PROJECT_ROOT, makeTempDir, runScript } from '../helpers/node';

const SCRIPT = 'scripts/inspect-asset.ts';
let temp: ReturnType<typeof makeTempDir>;

function writeFixture(id: FixtureId): string {
  const path = join(temp.dir, `${id}.glb`);
  writeFileSync(path, buildFixture(id));
  return path;
}

function inspect(args: readonly string[], options?: Parameters<typeof runScript>[2]) {
  return runScript(SCRIPT, args, options);
}

beforeAll(() => {
  temp = makeTempDir('inspect-cli');
});

afterAll(() => {
  temp.cleanup();
});

describe('npm 脚本入口', () => {
  it('package.json 的 inspect-asset 指向被测的脚本', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['inspect-asset']).toBe(`tsx ${SCRIPT}`);
  });
});

describe('退出码 0：检查完成', () => {
  it('文本输出', () => {
    const file = writeFixture('skinned-humanoid');
    const r = inspect([file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`GLB 结构检查：${file}`);
    expect(r.stdout).toContain('三角面数（按 indices 或 POSITION 的 count 和图元 mode 计算）：60');
    expect(r.stdout).toContain('#2 "run"');
    expect(r.stdout).toContain('extras.loop（原始）：缺失（extras 里没有 loop）');
    expect(r.stdout).toContain('加载后对应 clip.userData.loop（three r187 GLTFLoader）');
    expect(r.stderr).toBe('');
  });

  it('--json 输出合法 JSON，字段与纯模块一致', () => {
    const file = writeFixture('unnamed-clips');
    const r = inspect([file, '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      report: { animations: { animations: { loaderName: string; loop: unknown }[] } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.report.animations.animations.map((a) => a.loaderName)).toEqual(['named', 'animation_1', 'animation_2']);
    expect(parsed.report.animations.animations[2]?.loop).toEqual({ kind: 'false' });
  });

  it('外部 buffer：检查完成（退出码 0），实际值写未计算', () => {
    const r = inspect([writeFixture('external-buffer')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('buffers[0].uri：fixture-external.bin');
    expect(r.stdout).toContain('实际值（从 BIN 读出的顶点 + 节点静态变换）：未计算（');
  });

  it('相对路径按运行命令时的目录（INIT_CWD）解析', () => {
    writeFixture('static-mesh');
    const r = inspect(['static-mesh.glb'], { cwd: PROJECT_ROOT, env: { INIT_CWD: temp.dir } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('GLB 结构检查：static-mesh.glb');
  });
});

describe('退出码 1：不是合法的 GLB', () => {
  it('OBJ 文本文件', () => {
    const file = join(temp.dir, 'cube.obj');
    writeFileSync(file, '# cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const r = inspect([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('不是合法的 GLB');
    expect(r.stderr).toContain('OBJ');
    expect(r.stdout).toBe('');
  });

  it('.gltf JSON 文件', () => {
    const file = join(temp.dir, 'scene.gltf');
    writeFileSync(file, '{"asset":{"version":"2.0"}}');
    const r = inspect([file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('.gltf');
  });

  it('magic 错误', () => {
    const r = inspect([writeFixture('corrupt-magic')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('不是 GLB 文件');
  });

  it('文件被截断；--json 时标准输出是 ok:false 的 JSON', () => {
    const r = inspect([writeFixture('corrupt-truncated'), '--json']);
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed).toMatchObject({ ok: false, error: { code: 'truncated' } });
    expect(r.stderr).toContain('文件被截断');
  });
});

describe('退出码 2：用法错误或读不了文件', () => {
  it('文件不存在', () => {
    const r = inspect([join(temp.dir, 'missing.glb')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('文件不存在');
  });

  it('路径是目录', () => {
    const dir = join(temp.dir, 'a-directory');
    mkdirSync(dir, { recursive: true });
    const r = inspect([dir]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('读不了文件');
  });

  it('没有参数', () => {
    const r = inspect([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('用法');
  });

  it('未知选项', () => {
    const r = inspect(['--yaml', writeFixture('loop-false')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知选项');
  });

  it('多个文件', () => {
    const r = inspect([writeFixture('loop-false'), writeFixture('loop-string')]);
    expect(r.status).toBe(2);
  });
});

describe('只读', () => {
  it('运行后临时目录里没有多出文件', () => {
    const file = writeFixture('textured');
    const before = readdirSync(temp.dir).sort();
    expect(inspect([file]).status).toBe(0);
    expect(inspect([file, '--json']).status).toBe(0);
    expect(readdirSync(temp.dir).sort()).toEqual(before);
  });
});

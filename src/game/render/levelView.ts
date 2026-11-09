// 关卡的 three 场景：地面、边界、盒子、高台、坡道、收集点、守卫。只读模拟状态。
// P6 整理了观感：地面用运行时画出的细节纹理（固定种子，不用外部贴图），障碍和高台顶面更亮，
// 投下和接收阴影，地图边缘有一圈“岛边”立在水面上，宝石有柔光，巡逻路线是虚线。

import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineDashedMaterial,
  LineLoop,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
  type Material,
  type Scene,
} from 'three';
import type { Theme } from '../level/gen/brief';
import type { Rect, Solid } from '../level/geometry';
import type { GameState } from '../sim';
import { SPEC } from '../spec';
import { CharacterView } from './characterView';
import { GUARD_PALETTE } from './humanoid';

const COLORS = {
  gem: 0xffc845,
  route: 0xff6b5e,
} as const;

interface ThemeColors {
  readonly ground: number;
  readonly grid: number;
  /** 障碍的几种颜色（按 id 固定地挑一种，看起来不单调）。 */
  readonly box: number;
  readonly boxes: readonly number[];
  readonly platform: number;
  readonly ramp: number;
  readonly border: number;
  /** 地图边缘立在水面上的“岛边”。 */
  readonly skirt: number;
}

/** 主题（P5 的视觉预设）对应的颜色。P2 的三张手工地图用 grass。 */
export const THEME_COLORS: Readonly<Record<Theme, ThemeColors>> = {
  grass: { ground: 0x86b86a, grid: 0x6c9c55, box: 0xb27a46, boxes: [0xb27a46, 0x9e6b3d, 0xc28b55], platform: 0x8f9aa6, ramp: 0xa9b3bd, border: 0x6b5a4a, skirt: 0x6b4f37 },
  sand: { ground: 0xe1c58e, grid: 0xcbab70, box: 0xc79a62, boxes: [0xc79a62, 0xb48653, 0xd4aa72], platform: 0xb59b78, ramp: 0xc9b28e, border: 0x9a7a54, skirt: 0xa77f4f },
  snow: { ground: 0xf0f4f8, grid: 0xd4dde8, box: 0x8a9db2, boxes: [0x8a9db2, 0x7a8ea4, 0x9cb0c4], platform: 0x9aa8b8, ramp: 0xb8c5d3, border: 0x7c8a9c, skirt: 0x6f8196 },
};

/** 由字符串得到 0..1 的固定数（给障碍挑颜色，不用随机数）。 */
function hashUnit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** 地面的细节纹理：接近白色的灰度噪声（乘在地面颜色上），按主题画不同的花纹。固定种子，每次都一样。 */
/** 能画纹理的画布；在没有 DOM 的环境（单元测试）里返回 null。 */
function makeCanvas(size: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function groundTexture(theme: Theme): Texture {
  const size = 256;
  const canvas = makeCanvas(size);
  if (!canvas) return new Texture();
  const ctx = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  if (!ctx) return texture;
  let seed = theme === 'grass' ? 17 : theme === 'sand' ? 29 : 41;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const dab = (x: number, y: number, r: number, shade: number, alpha: number) => {
    for (const [dx, dy] of [
      [0, 0],
      [size, 0],
      [-size, 0],
      [0, size],
      [0, -size],
    ] as const) {
      ctx.fillStyle = `rgba(${String(shade)}, ${String(shade)}, ${String(shade)}, ${String(alpha)})`;
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  if (theme === 'sand') {
    ctx.strokeStyle = 'rgba(150, 150, 150, 0.16)';
    ctx.lineWidth = 2;
    for (let row = 0; row < 14; row++) {
      ctx.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const y = row * 19 + Math.sin(x / 26 + row) * 4;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  for (let i = 0; i < 900; i++) dab(rand() * size, rand() * size, 2 + rand() * 9, theme === 'snow' ? 200 : 150, 0.05 + rand() * 0.06);
  for (let i = 0; i < 700; i++) dab(rand() * size, rand() * size, 0.6 + rand() * 1.4, theme === 'grass' ? 90 : 120, 0.16 + rand() * 0.16);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
}

/** 宝石的柔光：径向渐变的小贴图（运行时画）。 */
function glowTexture(): Texture {
  const size = 64;
  const canvas = makeCanvas(size);
  if (!canvas) return new Texture();
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255, 220, 120, 0.85)');
    g.addColorStop(0.35, 'rgba(255, 200, 69, 0.35)');
    g.addColorStop(1, 'rgba(255, 200, 69, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** 盒子形状的材质：侧面原色，顶面亮一些（六个面的顺序 +x −x +y −y +z −z）。 */
function boxMaterials(color: number): Material[] {
  const side = new MeshStandardMaterial({ color, roughness: 0.82 });
  const top = new MeshStandardMaterial({ color: new Color(color).lerp(new Color(0xffffff), 0.18), roughness: 0.75 });
  return [side, side, top, side, side, side];
}

/** 坡道的楔形几何：矩形底面，沿 rise 方向从 0 升到 height。 */
export function rampGeometry(rect: Rect, height: number, rise: NonNullable<Solid['rise']>): BufferGeometry {
  // 低端两点高度 0，高端两点高度 height
  const { minX, maxX, minZ, maxZ } = rect;
  const corner = (x: number, z: number): number => {
    switch (rise) {
      case '+x':
        return x === maxX ? height : 0;
      case '-x':
        return x === minX ? height : 0;
      case '+z':
        return z === maxZ ? height : 0;
      case '-z':
        return z === minZ ? height : 0;
    }
  };
  const top = [
    new Vector3(minX, corner(minX, minZ), minZ),
    new Vector3(maxX, corner(maxX, minZ), minZ),
    new Vector3(maxX, corner(maxX, maxZ), maxZ),
    new Vector3(minX, corner(minX, maxZ), maxZ),
  ];
  const bottom = top.map((v) => new Vector3(v.x, 0, v.z));
  const triangles: Vector3[] = [];
  const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) => {
    triangles.push(a, b, c, a, c, d);
  };
  const [t0, t1, t2, t3] = top as [Vector3, Vector3, Vector3, Vector3];
  const [b0, b1, b2, b3] = bottom as [Vector3, Vector3, Vector3, Vector3];
  quad(t0, t3, t2, t1); // 顶面（斜面）
  quad(b0, b1, b2, b3); // 底面
  quad(b0, t0, t1, b1); // -z 侧
  quad(b2, t2, t3, b3); // +z 侧
  quad(b3, t3, t0, b0); // -x 侧
  quad(b1, t1, t2, b2); // +x 侧
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(triangles.flatMap((v) => [v.x, v.y, v.z]), 3));
  geometry.computeVertexNormals();
  return geometry;
}

function material(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness: 0.9, flatShading: true });
}

/** 投下并接收阴影。 */
function shadowed<T extends Mesh>(mesh: T): T {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export class LevelView {
  readonly group = new Group();
  private readonly gems = new Map<string, Mesh>();
  private readonly guardViews: CharacterView[] = [];
  private readonly palette: ThemeColors;
  private readonly textures: Texture[] = [];

  constructor(scene: Scene, state: GameState, theme: Theme = 'grass') {
    this.group.name = `level-${state.level.id}`;
    const { width, depth } = state.level.size;
    this.palette = THEME_COLORS[theme];

    const detail = groundTexture(theme);
    detail.repeat.set(width / 7, depth / 7);
    this.textures.push(detail);
    const ground = new Mesh(new PlaneGeometry(width, depth), new MeshStandardMaterial({ color: this.palette.ground, map: detail, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.name = 'ground';
    ground.receiveShadow = true;
    this.group.add(ground);
    const grid = new GridHelper(Math.max(width, depth), Math.max(width, depth), this.palette.grid, this.palette.grid);
    grid.position.y = 0.003;
    grid.scale.set(width / Math.max(width, depth), 1, depth / Math.max(width, depth));
    for (const m of [grid.material].flat()) {
      m.transparent = true;
      m.opacity = 0.18;
    }
    this.group.add(grid);
    // 地图边缘立在水面上的“岛边”（只是装饰，地图外的水面在 Environment 里）
    const skirt = new Mesh(new BoxGeometry(width + 0.4, 0.7, depth + 0.4), boxMaterials(this.palette.skirt));
    skirt.name = 'island-edge';
    skirt.position.y = -0.351;
    skirt.receiveShadow = true;
    this.group.add(skirt);

    // 地图边界：一圈矮墙（只是视觉提示；碰撞由模拟里的边界限制）
    const b = state.world.bounds;
    const thickness = 0.2;
    const borderHeight = 0.4;
    const borders: [number, number, number, number][] = [
      [(b.minX + b.maxX) / 2, b.minZ - thickness / 2, width + thickness * 2, thickness],
      [(b.minX + b.maxX) / 2, b.maxZ + thickness / 2, width + thickness * 2, thickness],
      [b.minX - thickness / 2, (b.minZ + b.maxZ) / 2, thickness, depth],
      [b.maxX + thickness / 2, (b.minZ + b.maxZ) / 2, thickness, depth],
    ];
    for (const [x, z, sx, sz] of borders) {
      const wall = shadowed(new Mesh(new BoxGeometry(sx, borderHeight, sz), boxMaterials(this.palette.border)));
      wall.position.set(x, borderHeight / 2, z);
      this.group.add(wall);
    }

    for (const solid of state.world.solids) this.group.add(this.solidMesh(solid));

    const glow = glowTexture();
    this.textures.push(glow);
    for (const spot of state.world.collectibles) {
      const gem = new Mesh(
        new OctahedronGeometry(0.22),
        new MeshStandardMaterial({ color: COLORS.gem, emissive: new Color(COLORS.gem).multiplyScalar(0.45), roughness: 0.25, metalness: 0.2 }),
      );
      gem.castShadow = true;
      const halo = new Sprite(new SpriteMaterial({ map: glow, blending: AdditiveBlending, depthWrite: false, transparent: true }));
      halo.scale.setScalar(1.15);
      gem.add(halo);
      gem.name = `gem-${spot.id}`;
      gem.position.set(spot.center.x, spot.center.y, spot.center.z);
      this.gems.set(spot.id, gem);
      this.group.add(gem);
    }

    for (const route of state.world.guardRoutes) {
      const line = new LineLoop(
        new BufferGeometry().setFromPoints(route.points.map((p) => new Vector3(p.x, 0.02, p.z))),
        new LineDashedMaterial({ color: COLORS.route, transparent: true, opacity: 0.6, dashSize: 0.45, gapSize: 0.3 }),
      );
      line.computeLineDistances();
      this.group.add(line);
    }
    state.guards.forEach((guard) => {
      const view = new CharacterView(`guard-${guard.id}`, GUARD_PALETTE);
      this.guardViews.push(view);
      this.group.add(view.root);
    });

    scene.add(this.group);
    this.update(state, 0, 0);
  }

  /** 关卡里按顺序排列的守卫的视图（P4：名册里的守卫人物替换它们模型槽里的模型）。 */
  get guards(): readonly CharacterView[] {
    return this.guardViews;
  }

  private solidMesh(solid: Solid): Mesh {
    const r = solid.rect;
    if (solid.kind === 'ramp' && solid.rise !== undefined) {
      const mesh = shadowed(new Mesh(rampGeometry(r, solid.height, solid.rise), material(this.palette.ramp)));
      mesh.name = `ramp-${solid.id}`;
      return mesh;
    }
    const boxes = this.palette.boxes;
    const color = solid.kind === 'platform' ? this.palette.platform : (boxes[Math.floor(hashUnit(solid.id) * boxes.length)] ?? this.palette.box);
    const mesh = shadowed(new Mesh(new BoxGeometry(r.maxX - r.minX, solid.height, r.maxZ - r.minZ), boxMaterials(color)));
    mesh.name = `${solid.kind}-${solid.id}`;
    mesh.position.set((r.minX + r.maxX) / 2, solid.height / 2, (r.minZ + r.maxZ) / 2);
    return mesh;
  }

  update(state: GameState, dt: number, time: number): void {
    for (const spot of state.world.collectibles) {
      const gem = this.gems.get(spot.id);
      if (!gem) continue;
      gem.visible = !state.collected.includes(spot.id);
      gem.rotation.y = time * 2;
      gem.position.y = spot.center.y + Math.sin(time * 2.5 + spot.center.x) * 0.06;
    }
    // 守卫只在游玩时移动；动画速度取规格里的巡逻速度
    const speed = state.phase === 'playing' ? SPEC.guard.speed : 0;
    state.guards.forEach((guard, i) => {
      this.guardViews[i]?.update(
        { position: guard.position, facing: guard.facing, horizontalSpeed: speed, grounded: true, vy: 0 },
        dt,
        time,
      );
    });
  }

  dispose(): void {
    for (const t of this.textures) t.dispose();
    this.group.removeFromParent();
    this.group.traverse((obj) => {
      const mesh = obj as Partial<Mesh>;
      if (mesh.isMesh !== true) return;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) m.dispose();
    });
  }
}

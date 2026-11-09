// 关卡的 three 场景：地面、边界、盒子、高台、坡道、收集点、守卫。只读模拟状态。

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Vector3,
  type Scene,
} from 'three';
import type { Theme } from '../level/gen/brief';
import type { Rect, Solid } from '../level/geometry';
import type { GameState } from '../sim';
import { SPEC } from '../spec';
import { CharacterView } from './characterView';
import { GUARD_PALETTE } from './humanoid';

const COLORS = {
  ground: 0x8fb276,
  grid: 0x6f9460,
  border: 0x4b3b2a,
  box: 0xb07a45,
  platform: 0x9aa3ad,
  ramp: 0xb5bcc4,
  gem: 0xffd23f,
  route: 0xc0392b,
} as const;

/** 主题（P5 的视觉预设）对应的地面、网格和障碍颜色。P2 的三张手工地图用 grass。 */
export const THEME_COLORS: Readonly<Record<Theme, { ground: number; grid: number; box: number }>> = {
  grass: { ground: COLORS.ground, grid: COLORS.grid, box: COLORS.box },
  sand: { ground: 0xd9c08a, grid: 0xc4a96f, box: 0x9c6b3c },
  snow: { ground: 0xeef2f7, grid: 0xcfd8e3, box: 0x7d8a99 },
};

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

export class LevelView {
  readonly group = new Group();
  private readonly gems = new Map<string, Mesh>();
  private readonly guardViews: CharacterView[] = [];
  private readonly palette: { ground: number; grid: number; box: number };

  constructor(scene: Scene, state: GameState, theme: Theme = 'grass') {
    this.group.name = `level-${state.level.id}`;
    const { width, depth } = state.level.size;
    this.palette = THEME_COLORS[theme];

    const ground = new Mesh(new PlaneGeometry(width, depth), material(this.palette.ground));
    ground.rotation.x = -Math.PI / 2;
    ground.name = 'ground';
    this.group.add(ground);
    const grid = new GridHelper(Math.max(width, depth), Math.max(width, depth), this.palette.grid, this.palette.grid);
    grid.position.y = 0.003;
    grid.scale.set(width / Math.max(width, depth), 1, depth / Math.max(width, depth));
    this.group.add(grid);

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
      const wall = new Mesh(new BoxGeometry(sx, borderHeight, sz), material(COLORS.border));
      wall.position.set(x, borderHeight / 2, z);
      this.group.add(wall);
    }

    for (const solid of state.world.solids) this.group.add(this.solidMesh(solid));

    for (const spot of state.world.collectibles) {
      const gem = new Mesh(
        new OctahedronGeometry(0.22),
        new MeshStandardMaterial({ color: COLORS.gem, emissive: new Color(COLORS.gem).multiplyScalar(0.35), roughness: 0.3 }),
      );
      gem.name = `gem-${spot.id}`;
      gem.position.set(spot.center.x, spot.center.y, spot.center.z);
      this.gems.set(spot.id, gem);
      this.group.add(gem);
    }

    for (const route of state.world.guardRoutes) {
      const line = new LineLoop(
        new BufferGeometry().setFromPoints(route.points.map((p) => new Vector3(p.x, 0.02, p.z))),
        new LineBasicMaterial({ color: COLORS.route, transparent: true, opacity: 0.5 }),
      );
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
      const mesh = new Mesh(rampGeometry(r, solid.height, solid.rise), material(COLORS.ramp));
      mesh.name = `ramp-${solid.id}`;
      return mesh;
    }
    const mesh = new Mesh(
      new BoxGeometry(r.maxX - r.minX, solid.height, r.maxZ - r.minZ),
      material(solid.kind === 'platform' ? COLORS.platform : this.palette.box),
    );
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

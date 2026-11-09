// 名册测试的辅助：内存存储、按导入流程得到的资产、和页面一样把名册的变化落到场景里（分配 + 换模型 + 同步模拟的同伴）。

import { Group } from 'three';
import { GltfBuilder, buildFixture, type FixtureId } from '../../src/asset/fixtures';
import { CharacterView } from '../../src/game/render/characterView';
import { GUARD_PALETTE, PLAYER_PALETTE } from '../../src/game/render/humanoid';
import { createInitialState, setCompanions, type GameState } from '../../src/game/sim';
import { InstanceRegistry, type ImportedAsset } from '../../src/import/asset';
import { assignCast } from '../../src/roster/cast';
import { CastDirector } from '../../src/roster/director';
import type { Roster } from '../../src/roster/roster';
import type { LevelLayout } from '../../src/game/level/schema';
import { importBytes, triangleMesh } from './import';

/** 第 i 个互不相同的小文件（节点名不同，SHA-256 就不同）。 */
export function distinctGlb(i: number): Uint8Array<ArrayBuffer> {
  const b = new GltfBuilder();
  b.addScene([b.addNode({ name: `person-${String(i)}`, mesh: triangleMesh(b) })]);
  return b.toGlb();
}

export interface Imported {
  readonly asset: ImportedAsset;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly file: Blob;
}

export async function importForRoster(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<Imported> {
  const outcome = await importBytes(name, bytes);
  if (!outcome.ok) throw new Error(`${name} 应该能导入：${outcome.error}`);
  return { asset: outcome.asset, bytes, file: new Blob([bytes]) };
}

export function importFixtureForRoster(id: FixtureId): Promise<Imported> {
  return importForRoster(`${id}.glb`, buildFixture(id));
}

/** 加入名册，失败时抛错（测试里用）。 */
export function addOrThrow(roster: Roster, imported: Imported): string {
  const result = roster.add(imported.asset, imported.file);
  if (!result.ok) throw new Error(result.error);
  return result.key;
}

/** 和页面（src/game/app.ts）一样：名册一变就重新分配、换模型、同步模拟里的同伴。 */
export class Stage {
  readonly registry: InstanceRegistry;
  readonly player = new CharacterView('player', PLAYER_PALETTE);
  readonly guards: CharacterView[];
  readonly parent = new Group();
  readonly director: CastDirector;
  state: GameState;

  constructor(
    readonly roster: Roster,
    level: LevelLayout,
    capacity?: number,
  ) {
    this.registry = new InstanceRegistry(capacity);
    this.state = createInitialState(level);
    this.guards = this.state.guards.map((g) => new CharacterView(`guard-${g.id}`, GUARD_PALETTE));
    this.director = new CastDirector({ player: this.player, guards: this.guards, guardIds: this.state.guards.map((g) => g.id), parent: this.parent }, this.registry);
    roster.onChange(() => {
      this.recast();
    });
    this.recast();
  }

  recast(): void {
    const cast = assignCast(this.roster.members(), this.state.guards.length, this.registry.max);
    const companions = this.director.apply(cast, (id) => this.roster.assetOf(id));
    this.state = setCompanions(this.state, companions);
  }
}

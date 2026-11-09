// 游戏状态的只读快照（纯 JSON），给测试钩子和调试用。快照是新建的对象，改它不会影响游戏。

import type { GameState, HitRecord, Phase } from './game';

export interface GameSnapshot {
  readonly levelId: string;
  readonly levelName: string;
  readonly phase: Phase;
  readonly simTime: number;
  readonly steps: number;
  readonly timeLimit: number;
  readonly timeLeft: number;
  readonly target: number;
  readonly collectedCount: number;
  readonly collectedIds: readonly string[];
  readonly totalCollectibles: number;
  readonly player: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly vy: number;
    readonly grounded: boolean;
    readonly facing: number;
    readonly horizontalSpeed: number;
    readonly running: boolean;
  };
  readonly guards: readonly { readonly id: string; readonly x: number; readonly y: number; readonly z: number }[];
  /** 同伴（P4）。id 是名册里人物的 id。 */
  readonly companions: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly facing: number;
    readonly horizontalSpeed: number;
    readonly grounded: boolean;
    readonly following: boolean;
    readonly farTime: number;
    readonly teleports: number;
  }[];
  readonly hitCooldown: number;
  readonly hits: readonly HitRecord[];
  readonly result: GameState['result'];
}

export function snapshotGame(state: GameState): GameSnapshot {
  const p = state.player;
  return {
    levelId: state.level.id,
    levelName: state.level.name,
    phase: state.phase,
    simTime: state.simTime,
    steps: state.steps,
    timeLimit: state.level.timeLimit,
    timeLeft: state.timeLeft,
    target: state.level.target,
    collectedCount: state.collected.length,
    collectedIds: [...state.collected],
    totalCollectibles: state.world.collectibles.length,
    player: {
      x: p.position.x,
      y: p.position.y,
      z: p.position.z,
      vy: p.vy,
      grounded: p.grounded,
      facing: p.facing,
      horizontalSpeed: p.horizontalSpeed,
      running: p.running,
    },
    guards: state.guards.map((g) => ({ id: g.id, x: g.position.x, y: g.position.y, z: g.position.z })),
    companions: state.companions.map((c) => ({
      id: c.id,
      x: c.body.position.x,
      y: c.body.position.y,
      z: c.body.position.z,
      facing: c.body.facing,
      horizontalSpeed: c.body.horizontalSpeed,
      grounded: c.body.grounded,
      following: c.following,
      farTime: c.farTime,
      teleports: c.teleports,
    })),
    hitCooldown: state.hitCooldown,
    hits: state.hits.map((h) => ({ ...h })),
    result: state.result ? { ...state.result } : null,
  };
}

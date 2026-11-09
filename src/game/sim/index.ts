// 模拟的公共入口（纯模块）：单元测试和页面都从这里取。
export {
  advance,
  createInitialState,
  distanceToCapsuleAxis,
  restartGame,
  setCompanions,
  setPaused,
  startGame,
  stepGame,
  togglePause,
} from './game';
export { DEFAULT_RULES } from './game';
export type { AdvanceResult, GameResult, GameRules, GameState, HitRecord, Phase } from './game';
export { NO_INPUT, moveDirection, spawnPlayer, stepPlayer } from './player';
export type { InputFrame, PlayerState } from './player';
export { capsulesTouch, guardAt, pointOnRoute, spawnGuards, stepGuards } from './guards';
export type { GuardState } from './guards';
export { blockingRects, clampToBounds, moveCapsule } from './collision';
export { canStand, findSpotNear, followOffset, followTarget, regroupCompanions, spawnCompanions, stepCompanions } from './companions';
export type { CompanionState } from './companions';
export { buildWorld, groundAt } from './world';
export type { CollectibleSpot, GuardRoute, Vec3, World } from './world';
export { snapshotGame } from './snapshot';
export type { GameSnapshot } from './snapshot';

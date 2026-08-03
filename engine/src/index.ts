/**
 * @elf-throne/engine — 规则引擎公共出口。
 * 纯 TS 内核，零运行时依赖；禁 import 网络/UI（control-manifest §1）。
 */
export * from './types.js';
export { createRng } from './rng.js';
export type { Rng } from './rng.js';
export { createInitialState } from './state.js';
export { applyCommand, beginGame, drawCards } from './actions.js';
export { endTurn } from './phases.js';
export { projectView, projectEvents } from './view.js';
export type { GameView, CharacterView } from './view.js';
export { CHARACTERS, TURN_ORDER_FULL } from './content/characters.js';
export { SCENES, isAdjacent } from './content/scenes.js';
export { MODE_TABLE, activeCharactersFor } from './content/modes.js';
export { ACTION_CARDS, ACTION_CARD_BY_ID } from './content/action-cards.js';
export { CRISIS_CARDS, CRISIS_CARD_BY_ID } from './content/crisis-cards.js';
export {
  BOND_CARDS,
  LETTER_CARDS,
  EQUIPMENT_CARDS,
  BOND_CARD_BY_ID,
  LETTER_CARD_BY_ID,
  EQUIPMENT_CARD_BY_ID,
} from './content/bond-cards.js';

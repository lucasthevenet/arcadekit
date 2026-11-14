/**
 * `@arcadekit/push-puzzle`: the push-puzzle genre's rules, with no DOM. A Sokoban-like tile map
 * played in turns, with undo and holes.
 *
 * Its declarations are exported bare under their names: the events (`Hud`, `LevelSolved`), the
 * simulation (`PushPuzzle`) and the content (`PushPuzzleContent`). Every other module is a
 * namespace: a run's state and step (`World`), a level read from its text (`Level`), and the
 * content's Schema (`PuzzleContent`). No DOM or Three.js here: `tsconfig.root.json` checks this
 * entry with no DOM types, and the engine is in `@arcadekit/push-puzzle/browser`.
 */
export { PushPuzzleContent } from "./content";
export { Hud, LevelSolved } from "./events";
export * as Level from "./level";
export * as PuzzleContent from "./puzzle-content";
export { PushPuzzle } from "./simulation";
export * as World from "./world";

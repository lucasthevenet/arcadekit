/**
 * The `@arcadekit/three` entry point, which draws an arcadekit game with
 * Three.js.
 *
 *   import { Gltf, Three } from "@arcadekit/three"
 *
 * Each module also has its own entry point, `@arcadekit/three/Three` and
 * `@arcadekit/three/Gltf`. Only `@arcadekit/three/Gltf` imports Three.js's glTF
 * loader. `arcadekit`, `effect` and `three` are peer dependencies, so a game
 * has one copy of each.
 *
 * Positions come from the game's own components, `arcadekit/Transform3d` or
 * `arcadekit/Transform2d`. The game's rules write them, and this package only
 * reads them.
 */
export * as Three from "./three/Three";
export * as Gltf from "./Gltf";

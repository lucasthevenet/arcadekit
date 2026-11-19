/**
 * The `@arcadekit/three` entry point, which draws an arcadekit game with
 * Three.js.
 *
 *   import { Gltf, Three } from "@arcadekit/three"
 *
 * Each module also has its own entry point: `@arcadekit/three/Three`, and
 * `@arcadekit/three/Gltf`, which is the only one that pulls in Three.js's glTF
 * loader. `arcadekit`, `effect` and `three` are peer dependencies, so a game
 * has a single copy of each. Positions come from the game's own components,
 * `arcadekit/Transform3d` or `arcadekit/Transform2d`: the game's rules write
 * them, and this package only reads them.
 */
export * as Three from "./Three";

export * as Gltf from "./Gltf";

/**
 * Draws an arcadekit game with Three.js: the `@arcadekit/three` entry.
 *
 *   import { Gltf, Three } from "@arcadekit/three"
 *
 * Each is an entry of its own too: `@arcadekit/three/Three`, and
 * `@arcadekit/three/Gltf`, which alone brings the glTF loader of Three.js.
 * `arcadekit`, `effect` and `three` are peer dependencies, so a game has
 * one copy of each. Where a thing is drawn comes from the game's own
 * components, `arcadekit/Transform3d` or `arcadekit/Transform2d`, which
 * the game's rules write and this package only reads.
 */
export * as Three from "./Three";
export * as Gltf from "./Gltf";

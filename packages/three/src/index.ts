/**
 * Draws an arcadekit game with Three.js: the `@arcadekit/three` entry.
 *
 *   import { Three } from "@arcadekit/three"
 *
 * `Three` is an entry of its own too, `@arcadekit/three/Three`. Where a
 * thing is drawn comes from the game's own components,
 * `arcadekit/Transform3d` or `arcadekit/Transform2d`, which the game's
 * rules write and this package only reads.
 */
export * as Three from "./Three";

// Test helpers for a view that draws sprites: a sheet with no image, what a batch shows, and two
// checks of the PNG a game ships. Only tests should import this entry; the root doesn't export
// it. It runs in Node, with no WebGL: the PNG checks inflate with `node:zlib`.

export { type DrawnSprite, drawnSprites } from "./drawn-sprites";
export { framesWithSoftAlpha, pngSize } from "./png";
export { testSheet } from "./test-sheet";

// arcadekit/render-three/testing: what a view's tests need, a sheet with no image, what a batch
// shows, and two checks of the PNG a game ships. Only tests import this entry; the root doesn't
// export it. It runs in Node, with no WebGL: the PNG checks inflate with `node:zlib`. Each module
// is a namespace.

export * as DrawnSprites from "./drawn-sprites";
export * as Png from "./png";
export * as TestSpriteSheet from "./test-sprite-sheet";
